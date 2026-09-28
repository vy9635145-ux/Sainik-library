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
`);

const cols=db.prepare("PRAGMA table_info(bookings)").all().map(x=>x.name);
for(const [n,d] of [
  ["father_name","TEXT DEFAULT ''"],["address","TEXT DEFAULT ''"],
  ["payment_status","TEXT DEFAULT 'pending'"],["payment_id","TEXT"],["amount","INTEGER DEFAULT 0"],
  ["paid_at","TEXT"],["cancelled_at","TEXT"],["cancelled_by","TEXT"],["cancellation_reason","TEXT"]
]){
  if(!cols.includes(n)) db.exec(`ALTER TABLE bookings ADD COLUMN ${n} ${d}`);
}
db.exec(`DROP INDEX IF EXISTS uq_seat_date_shift`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_active_seat_date_shift
         ON bookings(seat,date,shift) WHERE status IN ('pending','confirmed')`);

const adminUser=process.env.ADMIN_USER||"admin";
const adminPass=process.env.ADMIN_PASSWORD||"ChangeMe123!";
if(!db.prepare("SELECT 1 FROM admins WHERE username=?").get(adminUser))
  db.prepare("INSERT INTO admins(username,password_hash) VALUES(?,?)").run(adminUser,bcrypt.hashSync(adminPass,12));

function setting(k,d){const x=db.prepare("SELECT value FROM settings WHERE key=?").get(k);return x?x.value:d;}
function amountForPlan(plan){
  const map={Daily:Number(process.env.DAILY_AMOUNT||process.env.PAYMENT_AMOUNT||2000),
    Monthly:Number(process.env.MONTHLY_AMOUNT||process.env.PAYMENT_AMOUNT||2000),
    Quarterly:Number(process.env.QUARTERLY_AMOUNT||process.env.PAYMENT_AMOUNT||2000)};
  return Number.isFinite(map[plan])&&map[plan]>0?map[plan]:2000;
}
function expirePending(){
  const mins=Number(process.env.PAYMENT_HOLD_MINUTES||10);
  const now=new Date().toISOString();
  db.prepare(`UPDATE bookings
    SET status='cancelled', cancelled_at=?, cancelled_by='SYSTEM',
        cancellation_reason='Payment hold expired'
    WHERE status='pending' AND payment_status='pending'
      AND datetime(created_at)<datetime('now',?)`).run(now,`-${mins} minutes`);
}
setInterval(expirePending,60000).unref(); expirePending();

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
  holdMinutes:Number(process.env.PAYMENT_HOLD_MINUTES||10),
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

app.get("/api/seats",(req,res)=>{
  expirePending();
  const {date,shift}=req.query;
  if(!date||!shift)return res.status(400).json({error:"date and shift required"});
  const rows=db.prepare("SELECT seat,status FROM bookings WHERE date=? AND shift=? AND status IN ('pending','confirmed')").all(date,shift);
  res.json({booked:rows.filter(x=>x.status==="confirmed").map(x=>x.seat),held:rows.filter(x=>x.status==="pending").map(x=>x.seat)});
});

app.post("/api/login",(req,res)=>{
  const {username,password}=req.body||{};
  const a=db.prepare("SELECT * FROM admins WHERE username=?").get(username);
  if(!a||!bcrypt.compareSync(password,a.password_hash))return res.status(401).json({error:"Invalid credentials"});
  res.json({token:jwt.sign({id:a.id,username:a.username},SECRET,{expiresIn:"8h"})});
});

app.get("/api/bookings",auth,(req,res)=>res.json(db.prepare("SELECT * FROM bookings ORDER BY created_at DESC").all()));

app.post("/api/bookings",(req,res)=>{
  expirePending();
  const {name,fatherName="",father_name="",mobile,email="",address="",seat,date,shift,plan="Daily"}=req.body||{};
  const father = String(fatherName || father_name || "").trim();
  const total=Number(setting("total_seats","40"));
  if(!name||!father||!address||!/^\d{10}$/.test(mobile)||!Number.isInteger(Number(seat))||Number(seat)<1||Number(seat)>total||!date||!shift)
    return res.status(400).json({error:"Invalid booking details"});
  const amount=amountForPlan(plan);
  const id="SL-"+Date.now().toString().slice(-8)+Math.floor(Math.random()*90+10);
  try{
    db.prepare(`INSERT INTO bookings
      (id,name,father_name,mobile,email,address,seat,date,shift,plan,created_at,status,payment_status,amount)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending','pending',?)`)
      .run(id,name,father,mobile,email,address,Number(seat),date,shift,plan,new Date().toISOString(),amount);
    res.json({id,status:"pending",paymentStatus:"pending",amount,holdMinutes:Number(process.env.PAYMENT_HOLD_MINUTES||10)});
  }catch(e){
    if(String(e).includes("UNIQUE"))return res.status(409).json({error:"Seat is currently booked or being paid for. Try another seat."});
    console.error(e);res.status(500).json({error:"Booking hold failed"});
  }
});

// User marks that payment was made. This does NOT confirm the booking.
// Admin must verify the payment and press Confirm Payment.
app.post("/api/payment/claim",(req,res)=>{
  const {bookingId}=req.body||{};
  const b=db.prepare("SELECT * FROM bookings WHERE id=?").get(bookingId);
  if(!b)return res.status(404).json({error:"Booking not found"});
  if(b.status!=="pending")return res.status(400).json({error:"Booking is no longer awaiting payment"});
  db.prepare("UPDATE bookings SET payment_status='submitted' WHERE id=?").run(bookingId);
  res.json({ok:true,status:"submitted"});
});

// Admin manually verifies the user's UPI payment proof and confirms the seat.
app.post("/api/bookings/:id/confirm-payment",auth,(req,res)=>{
  const b=db.prepare("SELECT * FROM bookings WHERE id=?").get(req.params.id);
  if(!b)return res.status(404).json({error:"Booking not found"});
  if(b.status!=="pending")return res.status(400).json({error:"Booking is not pending"});
  db.prepare(`UPDATE bookings SET status='confirmed',payment_status='paid',payment_id=?,paid_at=? WHERE id=?`)
    .run("MANUAL-UPI-"+Date.now(),new Date().toISOString(),b.id);
  res.json({ok:true,message:"Payment confirmed and seat booked"});
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

app.post("/api/settings",auth,(req,res)=>{
  for(const [k,v] of Object.entries(req.body||{}))
    if(["total_seats","notice_title","notice_text"].includes(k))
      db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k,String(v));
  res.json({ok:true});
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(process.env.PORT||3000,()=>console.log("Sainik Library server running on port "+(process.env.PORT||3000)));
