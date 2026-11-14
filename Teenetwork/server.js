const express = require("express"), { Pool } = require("pg"), bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken"), cookieParser = require("cookie-parser"), path = require("path");

const DB = process.env.DATABASE_URL;
const SECRET = process.env.JWT_SECRET;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
if (!DB || !SECRET) { console.error("Missing DATABASE_URL or JWT_SECRET"); process.exit(1); }

const pool = new Pool({ connectionString: DB, ssl: DB.includes("railway.internal") ? false : { rejectUnauthorized: false } });
const q = (sql, p) => pool.query(sql, p);

async function setup() {
  await q(`create table if not exists centers (id serial primary key, name text not null);
  create table if not exists users (id serial primary key, name text not null, email text unique not null,
    password_hash text not null, center_id int references centers on delete set null, is_admin boolean not null default false);
  create table if not exists reports (id serial primary key, center_id int references centers on delete cascade,
    member_id int references users on delete set null, member_name text, school text not null, date date not null,
    attendance text, details text not null, students int not null, remarks text, challenges text, created_at timestamptz default now());`);
}

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: "Something went wrong" }); });

async function auth(req, res, next) {
  try {
    const { id } = jwt.verify(req.cookies.token || "", SECRET);
    const r = await q("select id,name,email,center_id,is_admin from users where id=$1", [id]);
    if (!r.rows[0]) throw 0;
    req.user = r.rows[0]; next();
  } catch { res.status(401).json({ error: "Please log in" }); }
}
const admin = (req, res, next) => req.user.is_admin ? next() : res.status(403).json({ error: "Admins only" });

function login(res, id) {
  const token = jwt.sign({ id }, SECRET, { expiresIn: "30d" });
  res.cookie("token", token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 30 * 864e5 });
}

app.post("/api/signup", wrap(async (req, res) => {
  const name = String(req.body.name || "").trim(), email = String(req.body.email || "").trim().toLowerCase(), pw = String(req.body.password || "");
  if (!name || !email.includes("@") || pw.length < 6) return res.status(400).json({ error: "Enter your name, a valid email and a password of at least 6 characters." });
  if ((await q("select 1 from users where email=$1", [email])).rows[0]) return res.status(400).json({ error: "That email is already registered. Please log in." });
  const r = await q("insert into users(name,email,password_hash,is_admin) values($1,$2,$3,$4) returning id",
    [name, email, await bcrypt.hash(pw, 10), email === ADMIN_EMAIL]);
  login(res, r.rows[0].id); res.json({ ok: true });
}));

app.post("/api/login", wrap(async (req, res) => {
  const r = await q("select id,password_hash from users where email=$1", [String(req.body.email || "").trim().toLowerCase()]);
  if (!r.rows[0] || !(await bcrypt.compare(String(req.body.password || ""), r.rows[0].password_hash))) return res.status(400).json({ error: "Wrong email or password." });
  login(res, r.rows[0].id); res.json({ ok: true });
}));

app.post("/api/logout", (req, res) => { res.clearCookie("token"); res.json({ ok: true }); });
app.get("/api/me", auth, (req, res) => res.json(req.user));

app.get("/api/data", auth, wrap(async (req, res) => {
  const u = req.user;
  const centers = (await q("select * from centers order by name")).rows;
  const reports = u.is_admin ? (await q("select * from reports order by date desc, id desc")).rows
    : u.center_id ? (await q("select * from reports where center_id=$1 order by date desc, id desc", [u.center_id])).rows : [];
  const users = u.is_admin ? (await q("select id,name,email,center_id,is_admin from users order by name")).rows : [];
  res.json({ centers, reports, users });
}));

app.post("/api/centers", auth, admin, wrap(async (req, res) => {
  const n = String(req.body.name || "").trim(); if (!n) return res.status(400).json({ error: "Enter a name" });
  await q("insert into centers(name) values($1)", [n]); res.json({ ok: true });
}));
app.delete("/api/centers/:id", auth, admin, wrap(async (req, res) => { await q("delete from centers where id=$1", [req.params.id]); res.json({ ok: true }); }));

app.put("/api/users/:id/center", auth, admin, wrap(async (req, res) => {
  await q("update users set center_id=$1 where id=$2", [req.body.center_id || null, req.params.id]); res.json({ ok: true });
}));

app.post("/api/reports", auth, wrap(async (req, res) => {
  const u = req.user, b = req.body;
  if (!u.center_id) return res.status(403).json({ error: "You have not been added to a centre yet." });
  if (!b.school || !b.date || !b.details || b.students === "" || isNaN(Number(b.students))) return res.status(400).json({ error: "Please fill in school, date, session details and number of students." });
  await q("insert into reports(center_id,member_id,member_name,school,date,attendance,details,students,remarks,challenges) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [u.center_id, u.id, u.name, b.school, b.date, b.attendance || "", b.details, Number(b.students), b.remarks || "", b.challenges || ""]);
  res.json({ ok: true });
}));
app.delete("/api/reports/:id", auth, wrap(async (req, res) => {
  await q("delete from reports where id=$1 and ($2 or member_id=$3)", [req.params.id, req.user.is_admin, req.user.id]); res.json({ ok: true });
}));

setup().then(() => app.listen(process.env.PORT || 3000, () => console.log("TEENETWORK running"))).catch(e => { console.error(e); process.exit(1); });
