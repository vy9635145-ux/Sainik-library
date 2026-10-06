require("dotenv").config();
const express=require("express"), path=require("path");
const {Pool}=require("pg");
const bcrypt=require("bcryptjs"), jwt=require("jsonwebtoken"), crypto=require("crypto"), QRCode=require("qrcode");

const app=express();
app.use(express.json({limit:"6mb"}));
app.use(express.static(path.join(__dirname,"public")));

const DATABASE_URL=process.env.DATABASE_URL;
if(!DATABASE_URL){
  console.error("DATABASE_URL is not configured. Sainik Library requires PostgreSQL.");
  process.exit(1);
}
const pool=new Pool({
  connectionString:DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : {rejectUnauthorized:false},
  max:5
});

async function query(text,params=[]){return pool.query(text,params);}
async function one(text,params=[]){const r=await query(text,params);return r.rows[0]||null;}
async function all(text,params=[]){const r=await query(text,params);return r.rows;}

async function initDb(){
  await query(`
    CREATE TABLE IF NOT EXISTS admins(
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookings(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      father_name TEXT DEFAULT '',
      mobile TEXT NOT NULL,
      email TEXT,
      address TEXT DEFAULT '',
      seat INTEGER NOT NULL,
      date TEXT NOT NULL,
      shift TEXT NOT NULL,
      plan TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      payment_status TEXT DEFAULT 'pending',
      payment_id TEXT,
      amount INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      paid_at TEXT,
      cancelled_at TEXT,
      cancelled_by TEXT,
      cancellation_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS settings(
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS success_students(
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      photo TEXT DEFAULT '',
      bio TEXT DEFAULT '',
      selected_for TEXT DEFAULT '',
      selected_place TEXT DEFAULT '',
      library_from TEXT DEFAULT '',
      library_to TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  // Indexes are intentionally partial: cancelled bookings release the seat.
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_active_seat_shift ON bookings(seat,shift) WHERE status IN ('pending','confirmed')`);
  await query(`CREATE INDEX IF NOT EXISTS idx_bookings_created_at ON bookings(created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_success_students_id ON success_students(id DESC)`);

  const adminUser=process.env.ADMIN_USER||"admin";
  const adminPass=process.env.ADMIN_PASSWORD||"ChangeMe123!";
  const existing=await one("SELECT id FROM admins WHERE username=$1",[adminUser]);
  if(!existing){
    await query("INSERT INTO admins(username,password_hash) VALUES($1,$2)",[adminUser,bcrypt.hashSync(adminPass,12)]);
  }

  // Older pending bookings are treated as active permanent bookings, matching the
  // previous SQLite version's behaviour. No automatic expiry is performed.
  await query("UPDATE bookings SET status='confirmed' WHERE status='pending'");
}

function setting(k,d){return one("SELECT value FROM settings WHERE key=$1",[k]).then(x=>x?x.value:d);}
function amountForPlan(plan){
  const map={
    Daily:Number(process.env.DAILY_AMOUNT||process.env.PAYMENT_AMOUNT||50),
    Monthly:Number(process.env.MONTHLY_AMOUNT||process.env.PAYMENT_AMOUNT||500),
    Quarterly:Number(process.env.QUARTERLY_AMOUNT||process.env.PAYMENT_AMOUNT||1500)
  };
  return Number.isFinite(map[plan])&&map[plan]>0?map[plan]:500;
}
function conflictingShifts(shift){
  if(shift==="Morning") return ["Morning","Full Day"];
  if(shift==="Evening") return ["Evening","Full Day"];
  if(shift==="Full Day") return ["Morning","Evening","Full Day"];
  return [shift];
}
function placeholders(start,count){return Array.from({length:count},(_,i)=>`$${start+i}`).join(",");}

const SECRET=process.env.JWT_SECRET||crypto.randomBytes(32).toString("hex");
function auth(req,res,next){
  try{
    req.admin=jwt.verify((req.headers.authorization||"").replace("Bearer ",""),SECRET);
    next();
  }catch(e){res.status(401).json({error:"Unauthorized"});}
}

app.get("/api/config",async(req,res)=>{
  try{
    res.json({
      totalSeats:Number(await setting("total_seats","55")),
      noticeTitle:await setting("notice_title","Admissions & seat booking open"),
      noticeText:await setting("notice_text","Contact the library for membership, timing and seat availability."),
      paymentMode:"upi_manual",
      paymentAmount:Number(process.env.PAYMENT_AMOUNT||2000),
      holdMinutes:0,
      upiId:process.env.UPI_ID||"",
      upiName:process.env.UPI_NAME||"Sainik Library"
    });
  }catch(e){console.error(e);res.status(500).json({error:"Could not load config"});}
});

app.get("/api/payment/qr",async(req,res)=>{
  const {amount,bookingId}=req.query;
  const upi=process.env.UPI_ID,name=process.env.UPI_NAME||"Sainik Library";
  if(!upi)return res.status(503).json({error:"UPI_ID is not configured"});
  const pa=`upi://pay?pa=${encodeURIComponent(upi)}&pn=${encodeURIComponent(name)}&am=${encodeURIComponent(Number(amount)||0)}&cu=INR&tn=${encodeURIComponent("Sainik Library "+(bookingId||""))}`;
  try{res.json({upiLink:pa,qrDataUrl:await QRCode.toDataURL(pa,{width:420,margin:2})});}
  catch(e){res.status(500).json({error:"Could not create payment QR"});}
});

app.get("/api/seats", async (req, res) => {
  try {
    const { shift, date } = req.query;

    if (!shift || !date) {
      return res.status(400).json({ error: "shift and date required" });
    }

    const shifts = conflictingShifts(shift);

    const rows = await all(
      `SELECT seat, status
       FROM bookings
       WHERE date = $1
       AND shift IN (${placeholders(2, shifts.length)})
       AND status IN ('pending','confirmed')`,
      [date, ...shifts]
    );

    res.json({
      booked: rows
        .filter(x => x.status === "confirmed")
        .map(x => Number(x.seat)),

      held: rows
        .filter(x => x.status === "pending")
        .map(x => Number(x.seat))
    });

  } catch (e) {
    console.error("Seats API error:", e);
    res.status(500).json({ error: "Could not load seats" });
  }
});

app.post("/api/login",async(req,res)=>{
  try{
    const {username,password}=req.body||{};
    const a=await one("SELECT * FROM admins WHERE username=$1",[username]);
    if(!a||!bcrypt.compareSync(password,a.password_hash))return res.status(401).json({error:"Invalid credentials"});
    res.json({token:jwt.sign({id:a.id,username:a.username},SECRET,{expiresIn:"8h"})});
  }catch(e){console.error(e);res.status(500).json({error:"Login failed"});}
});

app.get("/api/bookings",auth,async(req,res)=>{
  try{res.json(await all("SELECT * FROM bookings ORDER BY created_at DESC"));}
  catch(e){console.error(e);res.status(500).json({error:"Could not load bookings"});}
});

app.get("/api/success-students",async(req,res)=>{
  try{res.json(await all("SELECT * FROM success_students ORDER BY id DESC"));}
  catch(e){console.error(e);res.status(500).json({error:"Could not load success students"});}
});

app.post("/api/success-students",auth,async(req,res)=>{
  try{
    const {name,photo="",bio="",selectedFor="",selectedPlace="",libraryFrom="",libraryTo=""}=req.body||{};
    if(!String(name||"").trim())return res.status(400).json({error:"Student name is required"});
    if(String(photo).length>4_500_000)return res.status(400).json({error:"Photo is too large. Please use a smaller image."});
    const now=new Date().toISOString();
    const r=await one(`INSERT INTO success_students(name,photo,bio,selected_for,selected_place,library_from,library_to,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`,[
      String(name).trim(),String(photo||""),String(bio||""),String(selectedFor||""),String(selectedPlace||""),String(libraryFrom||""),String(libraryTo||""),now]);
    res.json({ok:true,id:r.id});
  }catch(e){console.error(e);res.status(500).json({error:"Could not save student"});}
});

app.put("/api/success-students/:id",auth,async(req,res)=>{
  try{
    const old=await one("SELECT * FROM success_students WHERE id=$1",[req.params.id]);
    if(!old)return res.status(404).json({error:"Student record not found"});
    const {name,photo,bio="",selectedFor="",selectedPlace="",libraryFrom="",libraryTo=""}=req.body||{};
    if(!String(name||"").trim())return res.status(400).json({error:"Student name is required"});
    const finalPhoto=photo===undefined?old.photo:String(photo||"");
    if(finalPhoto.length>4_500_000)return res.status(400).json({error:"Photo is too large. Please use a smaller image."});
    await query(`UPDATE success_students SET name=$1,photo=$2,bio=$3,selected_for=$4,selected_place=$5,library_from=$6,library_to=$7,updated_at=$8 WHERE id=$9`,[
      String(name).trim(),finalPhoto,String(bio||""),String(selectedFor||""),String(selectedPlace||""),String(libraryFrom||""),String(libraryTo||""),new Date().toISOString(),req.params.id]);
    res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:"Could not update student"});}
});

app.delete("/api/success-students/:id",auth,async(req,res)=>{
  try{
    const r=await query("DELETE FROM success_students WHERE id=$1",[req.params.id]);
    if(!r.rowCount)return res.status(404).json({error:"Student record not found"});
    res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:"Could not delete student"});}
});

app.post("/api/bookings",async(req,res)=>{
  const {name,fatherName="",father_name="",mobile,email="",address="",seat,date,shift,plan="Daily"}=req.body||{};
  const father=String(fatherName||father_name||"").trim();
  try{
    const total=Number(await setting("total_seats","55"));
    if(!name||!father||!address||!/^[0-9]{10}$/.test(mobile)||!Number.isInteger(Number(seat))||Number(seat)<1||Number(seat)>total||!date||!shift)
      return res.status(400).json({error:"Invalid booking details"});
    const amount=amountForPlan(plan);
    const id="SL-"+Date.now().toString().slice(-8)+Math.floor(Math.random()*90+10);
    const shifts=conflictingShifts(shift);
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      // Lock the physical seat row for this transaction when possible. If no row exists,
      // the unique partial index below still prevents duplicate active shift bookings.
      const existing=await client.query(`SELECT id,shift FROM bookings WHERE seat=$1 AND shift IN (${placeholders(2,shifts.length)}) AND status IN ('pending','confirmed') FOR UPDATE`,[Number(seat),...shifts]);
      if(existing.rows.length)throw new Error("SEAT_CONFLICT");
      await client.query(`INSERT INTO bookings(id,name,father_name,mobile,email,address,seat,date,shift,plan,created_at,status,payment_status,amount)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'confirmed','pending',$12)`,[
        id,name,father,mobile,email,address,Number(seat),date,shift,plan,new Date().toISOString(),amount]);
      await client.query("COMMIT");
      res.json({id,status:"confirmed",paymentStatus:"pending",amount});
    }catch(e){await client.query("ROLLBACK");
      if(e.message==="SEAT_CONFLICT"||e.code==="23505")return res.status(409).json({error:shift==="Morning"?"This seat is already booked for Morning or Full Day. It stays locked until admin cancellation.":shift==="Evening"?"This seat is already booked for Evening or Full Day. It stays locked until admin cancellation.":"This seat is already booked for Morning, Evening, or Full Day. It stays locked until admin cancellation."});
      console.error(e);res.status(500).json({error:"Booking failed"});
    }finally{client.release();}
  }catch(e){console.error(e);res.status(500).json({error:"Booking failed"});}
});

app.post("/api/payment/claim",async(req,res)=>{
  try{
    const {bookingId}=req.body||{};
    const b=await one("SELECT * FROM bookings WHERE id=$1",[bookingId]);
    if(!b)return res.status(404).json({error:"Booking not found"});
    if(b.status==="cancelled")return res.status(400).json({error:"Booking is cancelled"});
    if(b.payment_status==="paid")return res.status(400).json({error:"Payment is already verified"});
    await query("UPDATE bookings SET payment_status='submitted' WHERE id=$1",[bookingId]);
    res.json({ok:true,status:"submitted"});
  }catch(e){console.error(e);res.status(500).json({error:"Could not submit payment"});}
});

app.post("/api/bookings/:id/confirm-payment",auth,async(req,res)=>{
  try{
    const b=await one("SELECT * FROM bookings WHERE id=$1",[req.params.id]);
    if(!b)return res.status(404).json({error:"Booking not found"});
    if(b.status==="cancelled")return res.status(400).json({error:"Booking is cancelled"});
    await query("UPDATE bookings SET payment_status='paid',payment_id=$1,paid_at=$2 WHERE id=$3",["MANUAL-UPI-"+Date.now(),new Date().toISOString(),b.id]);
    res.json({ok:true,message:"Payment confirmed. Seat remains permanently booked until admin cancellation."});
  }catch(e){console.error(e);res.status(500).json({error:"Could not confirm payment"});}
});

app.delete("/api/bookings/:id",auth,async(req,res)=>{
  try{
    const b=await one("SELECT * FROM bookings WHERE id=$1",[req.params.id]);
    if(!b)return res.status(404).json({error:"Booking not found"});
    if(b.status==="cancelled")return res.status(400).json({error:"Booking is already cancelled"});
    const reason=String(req.body?.reason||"Cancelled by admin").trim().slice(0,250);
    await query("UPDATE bookings SET status='cancelled',cancelled_at=$1,cancelled_by=$2,cancellation_reason=$3 WHERE id=$4",[new Date().toISOString(),req.admin.username,reason,b.id]);
    res.json({ok:true,message:"Booking cancelled and seat released. Cancellation remains in admin history."});
  }catch(e){console.error(e);res.status(500).json({error:"Could not cancel booking"});}
});

app.delete("/api/history/:id",auth,async(req,res)=>{
  try{
    const b=await one("SELECT * FROM bookings WHERE id=$1",[req.params.id]);
    if(!b)return res.status(404).json({error:"Booking not found"});
    if(b.status!=="cancelled")return res.status(400).json({error:"Active booking cannot be deleted. Cancel it first."});
    await query("DELETE FROM bookings WHERE id=$1",[b.id]);
    res.json({ok:true,message:"History record permanently deleted by admin."});
  }catch(e){console.error(e);res.status(500).json({error:"Could not delete history"});}
});

app.post("/api/settings",auth,async(req,res)=>{
  try{
    for(const [k,v] of Object.entries(req.body||{})){
      if(["total_seats","notice_title","notice_text"].includes(k))
        await query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[k,String(v)]);
    }
    res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:"Could not save settings"});}
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

const port=process.env.PORT||3000;
initDb().then(()=>app.listen(port,()=>console.log("Sainik Library server running on port "+port)))
  .catch(e=>{console.error("Database initialization failed:",e);process.exit(1);});

process.on("SIGTERM",async()=>{await pool.end();process.exit(0);});
