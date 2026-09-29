require("dotenv").config();
const express=require("express"), path=require("path"), Database=require("better-sqlite3");
const bcrypt=require("bcryptjs"), jwt=require("jsonwebtoken"), crypto=require("crypto"), QRCode=require("qrcode");

const app=express();
app.use(express.json());
app.use(express.static(path.join(__dirname,"public")));

const db=new Database(process.env.DB_FILE||"sainik.db");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS admins(id INTEGER PRIMARY KEY,username TEXT UNIQUE,password_hash TEXT);
CREATE TABLE IF NOT EXISTS bookings(
 id TEXT PRIMARY KEY,name TEXT NOT NULL,father_name TEXT DEFAULT '',mobile TEXT NOT NULL,email TEXT,
 address TEXT DEFAULT '',seat INTEGER NOT NULL,date TEXT NOT NULL,shift TEXT NOT NULL,plan TEXT NOT NULL,
 status TEXT DEFAULT 'pending',payment_status TEXT DEFAULT 'pending',payment_id TEXT,
 amount INTEGER DEFAULT 0,created_at TEXT NOT NULL,paid_at TEXT,cancelled_at TEXT,
 cancelled_by TEXT,cancellation_reason TEXT
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE IF NOT EXISTS success_students(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
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

const cols=db.prepare("PRAGMA table_info(bookings)").all().map(x=>x.name);
for(const [n,d] of [
  ["father_name","TEXT DEFAULT ''"],["address","TEXT DEFAULT ''"],
  ["payment_status","TEXT DEFAULT 'pending'"],["payment_id","TEXT"],["amount","INTEGER DEFAULT 0"],
  ["paid_at","TEXT"],["cancelled_at","TEXT"],["cancelled_by","TEXT"],["cancellation_reason","TEXT"]
]){
  if(!cols.includes(n)) db.exec(`ALTER TABLE bookings ADD COLUMN ${n} ${d}`);
}
// A seat belongs to a shift permanently until an admin cancels the booking.
// Date is intentionally NOT part of this uniqueness rule: booking S1 in Morning
// locks S1 for Morning on every date. The same seat can still be booked in
// Evening/Full Day because those are separate shifts.
const duplicateActive=db.prepare(`
  SELECT seat,shift,COUNT(*) AS c
  FROM bookings
  WHERE status IN ('pending','confirmed')
  GROUP BY seat,shift
  HAVING COUNT(*)>1
`).all();
for(const d of duplicateActive){
  const keep=db.prepare(`
    SELECT id FROM bookings
    WHERE seat=? AND shift=? AND status IN ('pending','confirmed')
    ORDER BY datetime(created_at) ASC, rowid ASC
    LIMIT 1
  `).get(d.seat,d.shift);
  db.prepare(`
    UPDATE bookings
    SET status='cancelled',cancelled_at=?,cancelled_by='system-migration',
        cancellation_reason=?
    WHERE seat=? AND shift=? AND status IN ('pending','confirmed') AND id<>?
  `).run(new Date().toISOString(),
         'Duplicate active booking resolved during permanent seat migration',
         d.seat,d.shift,keep.id);
}
// Resolve legacy cross-shift conflicts created before the Morning/Evening/Full Day
// overlap rule. Keep the oldest active booking and cancel later conflicting records.
const activeBySeat=db.prepare(`
  SELECT * FROM bookings
  WHERE status IN ('pending','confirmed')
  ORDER BY seat ASC, datetime(created_at) ASC, rowid ASC
`).all();
const keptBySeat=new Map();
for(const b of activeBySeat){
  const kept=keptBySeat.get(b.seat)||[];
  const conflict=kept.some(k =>
    b.shift==="Full Day" || k.shift==="Full Day" || b.shift===k.shift
  );
  if(conflict){
    db.prepare(`
      UPDATE bookings SET status='cancelled',cancelled_at=?,cancelled_by='system-migration',
      cancellation_reason=? WHERE id=?
    `).run(
      new Date().toISOString(),
      'Cross-shift conflict resolved during Morning/Evening/Full Day migration',
      b.id
    );
  }else{
    kept.push(b);
    keptBySeat.set(b.seat,kept);
  }
}

db.exec(`DROP INDEX IF EXISTS uq_seat_date_shift`);
db.exec(`DROP INDEX IF EXISTS uq_active_seat_date_shift`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_active_seat_shift
         ON bookings(seat,shift) WHERE status IN ('pending','confirmed')`);

const adminUser=process.env.ADMIN_USER||"admin";
const adminPass=process.env.ADMIN_PASSWORD||"ChangeMe123!";
if(!db.prepare("SELECT 1 FROM admins WHERE username=?").get(adminUser))
  db.prepare("INSERT INTO admins(username,password_hash) VALUES(?,?)").run(adminUser,bcrypt.hashSync(adminPass,12));

// Existing pending bookings are migrated to permanent seat bookings.
// Their payment status is kept unchanged so the admin can still verify payment later.
db.prepare("UPDATE bookings SET status='confirmed' WHERE status='pending'").run();

function setting(k,d){const x=db.prepare("SELECT value FROM settings WHERE key=?").get(k);return x?x.value:d;}
function amountForPlan(plan){
  const map={Daily:Number(process.env.DAILY_AMOUNT||process.env.PAYMENT_AMOUNT||50),
    Monthly:Number(process.env.MONTHLY_AMOUNT||process.env.PAYMENT_AMOUNT||500),
    Quarterly:Number(process.env.QUARTERLY_AMOUNT||process.env.PAYMENT_AMOUNT||1500)};
  return Number.isFinite(map[plan])&&map[plan]>0?map[plan]:500;
}
// Bookings are permanent until an admin cancels them.
// There is intentionally NO automatic payment-hold expiry.
function expirePending(){ /* retained for backward compatibility; never expires bookings */ }

const SECRET=process.env.JWT_SECRET||crypto.randomBytes(32).toString("hex");
function auth(req,res,next){
  try{req.admin=jwt.verify((req.headers.authorization||"").replace("Bearer ",""),SECRET);next();}
  catch(e){res.status(401).json({error:"Unauthorized"});}
}

app.get("/api/config",(req,res)=>res.json({
  totalSeats:Number(setting("total_seats","40")),
  noticeTitle:setting("notice_title","Admissions & seat booking open"),
  noticeText:setting("notice_text","Contact the library for membership, timing and seat availability."),
  paymentMode:"upi_manual",
  paymentAmount:Number(process.env.PAYMENT_AMOUNT||2000),
  holdMinutes:0,
  upiId:process.env.UPI_ID||"",
  upiName:process.env.UPI_NAME||"Sainik Library"
}));

app.get("/api/payment/qr",async(req,res)=>{
  const {amount,bookingId}=req.query;
  const upi=process.env.UPI_ID, name=process.env.UPI_NAME||"Sainik Library";
  if(!upi)return res.status(503).json({error:"UPI_ID is not configured in .env"});
  const pa=`upi://pay?pa=${encodeURIComponent(upi)}&pn=${encodeURIComponent(name)}&am=${encodeURIComponent(Number(amount)||0)}&cu=INR&tn=${encodeURIComponent("Sainik Library "+(bookingId||""))}`;
  try{res.json({upiLink:pa,qrDataUrl:await QRCode.toDataURL(pa,{width:420,margin:2})});}
  catch(e){res.status(500).json({error:"Could not create payment QR"});}
});

function conflictingShifts(shift){
  if(shift==="Morning") return ["Morning","Full Day"];
  if(shift==="Evening") return ["Evening","Full Day"];
  if(shift==="Full Day") return ["Morning","Evening","Full Day"];
  return [shift];
}

app.get("/api/seats",(req,res)=>{
  expirePending();
  const {shift}=req.query;
  if(!shift)return res.status(400).json({error:"shift required"});
  // Permanent shift locking:
  // Morning booking => Morning + Full Day are locked on every date.
  // Evening booking => Evening + Full Day are locked on every date.
  // Full Day booking => Morning + Evening + Full Day are locked on every date.
  const shifts=conflictingShifts(shift);
  const marks=shifts.map(()=>"?").join(",");
  const rows=db.prepare(
    `SELECT seat,status FROM bookings
     WHERE shift IN (${marks}) AND status IN ('pending','confirmed')`
  ).all(...shifts);
  res.json({
    booked:rows.filter(x=>x.status==="confirmed").map(x=>x.seat),
    held:rows.filter(x=>x.status==="pending").map(x=>x.seat)
  });
});

app.post("/api/login",(req,res)=>{
  const {username,password}=req.body||{};
  const a=db.prepare("SELECT * FROM admins WHERE username=?").get(username);
  if(!a||!bcrypt.compareSync(password,a.password_hash))return res.status(401).json({error:"Invalid credentials"});
  res.json({token:jwt.sign({id:a.id,username:a.username},SECRET,{expiresIn:"8h"})});
});

app.get("/api/bookings",auth,(req,res)=>res.json(db.prepare("SELECT * FROM bookings ORDER BY created_at DESC").all()));

// Public success-student showcase. Only records created by admin are returned.
app.get("/api/success-students",(req,res)=>res.json(db.prepare("SELECT * FROM success_students ORDER BY id DESC").all()));

app.post("/api/success-students",auth,(req,res)=>{
  const {name,photo="",bio="",selectedFor="",selectedPlace="",libraryFrom="",libraryTo=""}=req.body||{};
  if(!String(name||"").trim()) return res.status(400).json({error:"Student name is required"});
  if(String(photo).length>4_500_000) return res.status(400).json({error:"Photo is too large. Please use a smaller image."});
  const now=new Date().toISOString();
  const info=db.prepare(`INSERT INTO success_students
    (name,photo,bio,selected_for,selected_place,library_from,library_to,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(String(name).trim(),String(photo||""),String(bio||""),String(selectedFor||""),String(selectedPlace||""),String(libraryFrom||""),String(libraryTo||""),now,now);
  res.json({ok:true,id:info.lastInsertRowid});
});

app.put("/api/success-students/:id",auth,(req,res)=>{
  const old=db.prepare("SELECT * FROM success_students WHERE id=?").get(req.params.id);
  if(!old)return res.status(404).json({error:"Student record not found"});
  const {name,photo,bio="",selectedFor="",selectedPlace="",libraryFrom="",libraryTo=""}=req.body||{};
  if(!String(name||"").trim())return res.status(400).json({error:"Student name is required"});
  const finalPhoto=photo===undefined?old.photo:String(photo||"");
  if(finalPhoto.length>4_500_000)return res.status(400).json({error:"Photo is too large. Please use a smaller image."});
  db.prepare(`UPDATE success_students SET name=?,photo=?,bio=?,selected_for=?,selected_place=?,library_from=?,library_to=?,updated_at=? WHERE id=?`)
    .run(String(name).trim(),finalPhoto,String(bio||""),String(selectedFor||""),String(selectedPlace||""),String(libraryFrom||""),String(libraryTo||""),new Date().toISOString(),req.params.id);
  res.json({ok:true});
});

app.delete("/api/success-students/:id",auth,(req,res)=>{
  const info=db.prepare("DELETE FROM success_students WHERE id=?").run(req.params.id);
  if(!info.changes)return res.status(404).json({error:"Student record not found"});
  res.json({ok:true});
});

app.post("/api/bookings",(req,res)=>{
  expirePending();
  const {name,fatherName="",father_name="",mobile,email="",address="",seat,date,shift,plan="Daily"}=req.body||{};
  const father = String(fatherName || father_name || "").trim();
  const total=Number(setting("total_seats","40"));
  if(!name||!father||!address||!/^\d{10}$/.test(mobile)||!Number.isInteger(Number(seat))||Number(seat)<1||Number(seat)>total||!date||!shift)
    return res.status(400).json({error:"Invalid booking details"});

  const amount=amountForPlan(plan);
  const id="SL-"+Date.now().toString().slice(-8)+Math.floor(Math.random()*90+10);
  const shifts=conflictingShifts(shift);
  const marks=shifts.map(()=>"?").join(",");

  try{
    // Check the cross-shift rule inside the same write transaction so two users
    // cannot race to reserve the same physical seat.
    const insert=db.transaction(()=>{
      const existing=db.prepare(
        `SELECT id,shift FROM bookings
         WHERE seat=? AND shift IN (${marks})
         AND status IN ('pending','confirmed')
         LIMIT 1`
      ).get(Number(seat),...shifts);
      if(existing){
        throw new Error("SEAT_CONFLICT");
      }
      db.prepare(`INSERT INTO bookings
        (id,name,father_name,mobile,email,address,seat,date,shift,plan,created_at,status,payment_status,amount)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'confirmed','pending',?)`)
        .run(id,name,father,mobile,email,address,Number(seat),date,shift,plan,new Date().toISOString(),amount);
    });
    insert();
    res.json({id,status:"confirmed",paymentStatus:"pending",amount});
  }catch(e){
    if(e.message==="SEAT_CONFLICT" || String(e).includes("UNIQUE"))
      return res.status(409).json({
        error: shift==="Morning"
          ? "This seat is already booked for Morning or Full Day. It stays locked until admin cancellation."
          : shift==="Evening"
            ? "This seat is already booked for Evening or Full Day. It stays locked until admin cancellation."
            : "This seat is already booked for Morning, Evening, or Full Day. It stays locked until admin cancellation."
      });
    console.error(e);res.status(500).json({error:"Booking failed"});
  }
});

// User marks that payment was made. The seat is already permanently booked.
// Admin only verifies the payment.
app.post("/api/payment/claim",(req,res)=>{
  const {bookingId}=req.body||{};
  const b=db.prepare("SELECT * FROM bookings WHERE id=?").get(bookingId);
  if(!b)return res.status(404).json({error:"Booking not found"});
  if(b.status==="cancelled")return res.status(400).json({error:"Booking is cancelled"});
  if(b.payment_status==="paid")return res.status(400).json({error:"Payment is already verified"});
  db.prepare("UPDATE bookings SET payment_status='submitted' WHERE id=?").run(bookingId);
  res.json({ok:true,status:"submitted"});
});

// Admin manually verifies the user's UPI payment proof and confirms the seat.
app.post("/api/bookings/:id/confirm-payment",auth,(req,res)=>{
  const b=db.prepare("SELECT * FROM bookings WHERE id=?").get(req.params.id);
  if(!b)return res.status(404).json({error:"Booking not found"});
  if(b.status==="cancelled")return res.status(400).json({error:"Booking is cancelled"});
  db.prepare(`UPDATE bookings SET payment_status='paid',payment_id=?,paid_at=? WHERE id=?`)
    .run("MANUAL-UPI-"+Date.now(),new Date().toISOString(),b.id);
  res.json({ok:true,message:"Payment confirmed. Seat remains permanently booked until admin cancellation."});
});

app.delete("/api/bookings/:id",auth,(req,res)=>{
  const b=db.prepare("SELECT * FROM bookings WHERE id=?").get(req.params.id);
  if(!b)return res.status(404).json({error:"Booking not found"});
  if(b.status==="cancelled")return res.status(400).json({error:"Booking is already cancelled"});
  const reason=String(req.body?.reason||"Cancelled by admin").trim().slice(0,250);
  db.prepare(`UPDATE bookings SET status='cancelled',cancelled_at=?,cancelled_by=?,cancellation_reason=? WHERE id=?`)
    .run(new Date().toISOString(),req.admin.username,reason,b.id);
  res.json({ok:true,message:"Booking cancelled and seat released. Cancellation remains in admin history."});
});

// Admin can permanently remove a cancelled record from history.
// Active bookings cannot be deleted; they must first be cancelled by admin.
app.delete("/api/history/:id",auth,(req,res)=>{
  const b=db.prepare("SELECT * FROM bookings WHERE id=?").get(req.params.id);
  if(!b)return res.status(404).json({error:"Booking not found"});
  if(b.status!=="cancelled")
    return res.status(400).json({error:"Active booking cannot be deleted. Cancel it first."});
  db.prepare("DELETE FROM bookings WHERE id=?").run(b.id);
  res.json({ok:true,message:"History record permanently deleted by admin."});
});

app.post("/api/settings",auth,(req,res)=>{
  for(const [k,v] of Object.entries(req.body||{}))
    if(["total_seats","notice_title","notice_text"].includes(k))
      db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k,String(v));
  res.json({ok:true});
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(process.env.PORT||3000,()=>console.log("Sainik Library server running on port "+(process.env.PORT||3000)));
