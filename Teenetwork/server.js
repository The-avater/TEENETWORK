const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const path = require("path");
const fs = require("fs");

// Load .env automatically if available (Node 20+)
try { process.loadEnvFile(); } catch {}
try { process.loadEnvFile(path.join(__dirname, ".env")); } catch {}

const DB = process.env.DATABASE_URL;
const SECRET = process.env.JWT_SECRET || "teenetwork-dev-secret-key-change-in-prod";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "kineromosele@gmail.com").trim().toLowerCase();
const ADMIN_EMAILS = [
  "kineromosele@gmail.com",
  ADMIN_EMAIL
].filter(Boolean);

let pool = null;
let isPostgres = Boolean(DB);
let localDb = null;
const localDbFile = path.join(__dirname, "data.json");

const defaultSchools = [
  {
    id: 1,
    name: "King's College Lagos",
    center_id: 1,
    contact_person: "Dr. A. Adebayo",
    phone: "+234 803 123 4567",
    email: "contact@kingscollegelagos.sch.ng",
    address: "3 Catholic Mission Street, Lagos Island, Lagos",
    session_time: "Wednesdays 10:00 AM - 11:30 AM"
  },
  {
    id: 2,
    name: "Queen's College Yaba",
    center_id: 1,
    contact_person: "Mrs. O. Adeleke",
    phone: "+234 802 987 6543",
    email: "contact@queenscollegeyaba.sch.ng",
    address: "Birrel Avenue, Sabo Yaba, Lagos",
    session_time: "Thursdays 11:00 AM - 12:30 PM"
  },
  {
    id: 3,
    name: "Government Secondary School Garki",
    center_id: 2,
    contact_person: "Mr. Emmanuel Ibrahim",
    phone: "+234 805 555 1234",
    email: "gssgarki@fct.gov.ng",
    address: "Area 10, Garki, Abuja",
    session_time: "Fridays 10:00 AM - 12:00 PM"
  }
];

if (isPostgres) {
  pool = new Pool({
    connectionString: DB,
    ssl: DB.includes("railway.internal") ? false : { rejectUnauthorized: false }
  });
} else {
  console.log("ℹ️  No DATABASE_URL set. Running in local JSON storage mode (data.json).");
  if (fs.existsSync(localDbFile)) {
    try {
      localDb = JSON.parse(fs.readFileSync(localDbFile, "utf8"));
      if (!localDb.schools) localDb.schools = [...defaultSchools];
    } catch {
      localDb = { centers: [], schools: [...defaultSchools], users: [], reports: [], password_resets: [], user_centers: [], user_schools: [] };
    }
  } else {
    localDb = {
      centers: [
        {
          id: 1,
          name: "Lagos Central",
          location: "St. Jude Hall, 14 Commercial Ave, Yaba, Lagos",
          session_time: "Thursdays 10:00 AM - 12:30 PM",
          contact: "Mrs. Folake Davies (+234 802 345 6789)"
        },
        {
          id: 2,
          name: "Abuja Outreach",
          location: "Youth Center, Area 10, Garki, Abuja",
          session_time: "Saturdays 11:00 AM - 2:00 PM",
          contact: "Pastor Emmanuel (+234 803 987 6543)"
        }
      ],
      schools: [...defaultSchools],
      users: [],
      reports: [],
      password_resets: [],
      user_centers: [],
      user_schools: []
    };
    saveLocalDb();
  }
}

function saveLocalDb() {
  if (!isPostgres && localDb) {
    try {
      fs.writeFileSync(localDbFile, JSON.stringify(localDb, null, 2), "utf8");
    } catch (e) {
      console.error("Failed to persist local db:", e);
    }
  }
}

// Unified query abstraction
async function q(sql, p = []) {
  if (isPostgres) {
    return pool.query(sql, p);
  }

  // Local JSON fallback handling for local dev
  const s = sql.trim().toLowerCase();

  if (s.startsWith("create table") || s.startsWith("alter table")) {
    return { rows: [] };
  }

  // users queries
  if (s.includes("select 1 from users where email=$1")) {
    const exists = localDb.users.some(u => u.email.toLowerCase() === p[0].toLowerCase());
    return { rows: exists ? [{ "?column?": 1 }] : [] };
  }
  if (s.includes("insert into users")) {
    const id = (localDb.users.reduce((max, u) => Math.max(max, u.id), 0) || 0) + 1;
    const now = new Date().toISOString();
    const user = {
      id,
      name: p[0],
      email: p[1].toLowerCase(),
      password_hash: p[2],
      is_admin: Boolean(p[3]),
      center_id: null,
      center_ids: [],
      school_ids: [1, 2, 3], // Default access to sample schools
      phone: "",
      bio: "",
      created_at: now,
      last_active_at: now
    };
    localDb.users.push(user);
    saveLocalDb();
    return { rows: [{ id }] };
  }
  if (s.includes("select id,password_hash from users where email=$1")) {
    const user = localDb.users.find(u => u.email.toLowerCase() === p[0].toLowerCase());
    return { rows: user ? [{ id: user.id, password_hash: user.password_hash, name: user.name, is_admin: user.is_admin }] : [] };
  }
  if (s.includes("select id,name,email,center_id,is_admin,phone,bio,created_at,last_active_at from users where id=$1") ||
      s.includes("select id,name,email,center_id,is_admin from users where id=$1")) {
    const user = localDb.users.find(u => u.id === Number(p[0]));
    return { rows: user ? [{ ...user }] : [] };
  }
  if (s.includes("update users set name=$1, phone=$2, bio=$3 where id=$4")) {
    const user = localDb.users.find(u => u.id === Number(p[3]));
    if (user) {
      user.name = p[0];
      user.phone = p[1] || "";
      user.bio = p[2] || "";
      saveLocalDb();
    }
    return { rowCount: user ? 1 : 0, rows: [] };
  }
  if (s.includes("from users order by name") ||
      s.includes("select id,name,email,center_id,is_admin from users order by name")) {
    const users = [...localDb.users]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(u => ({
        id: u.id,
        name: u.name,
        email: u.email,
        center_id: u.center_id,
        center_ids: u.center_ids || (u.center_id ? [u.center_id] : []),
        school_ids: u.school_ids || [1, 2, 3],
        is_admin: u.is_admin,
        phone: u.phone || "",
        whatsapp: u.whatsapp || u.phone || "",
        bio: u.bio || "",
        created_at: u.created_at,
        last_active_at: u.last_active_at
      }));
    return { rows: users };
  }
  if (s.includes("update users set center_id=$1 where id=$2")) {
    const user = localDb.users.find(u => u.id === Number(p[1]));
    if (user) {
      const cId = p[0] ? Number(p[0]) : null;
      user.center_id = cId;
      if (cId) {
        user.center_ids = Array.from(new Set([...(user.center_ids || []), cId]));
      }
      saveLocalDb();
    }
    return { rowCount: user ? 1 : 0, rows: [] };
  }
  if (s.includes("update users set password_hash=$1 where id=$2")) {
    const user = localDb.users.find(u => u.id === Number(p[1]));
    if (user) { user.password_hash = p[0]; saveLocalDb(); }
    return { rowCount: user ? 1 : 0, rows: [] };
  }
  if (s.includes("update users set password_hash=$1, is_admin=true where email=$2")) {
    const user = localDb.users.find(u => u.email.toLowerCase() === p[1].toLowerCase());
    if (user) { user.password_hash = p[0]; user.is_admin = true; saveLocalDb(); }
    return { rowCount: user ? 1 : 0, rows: [] };
  }
  if (s.includes("update users set last_active_at=now() where id=$1")) {
    const user = localDb.users.find(u => u.id === Number(p[0]));
    if (user) { user.last_active_at = new Date().toISOString(); saveLocalDb(); }
    return { rows: [] };
  }
  if (s.includes("select password_hash from users where id=$1")) {
    const user = localDb.users.find(u => u.id === Number(p[0]));
    return { rows: user ? [{ password_hash: user.password_hash }] : [] };
  }
  if (s.includes("select id,name from users where email=$1")) {
    const user = localDb.users.find(u => u.email.toLowerCase() === p[0].toLowerCase());
    return { rows: user ? [{ id: user.id, name: user.name }] : [] };
  }

  // schools queries
  if (s.includes("select * from schools order by name")) {
    const schools = [...(localDb.schools || [])].sort((a, b) => a.name.localeCompare(b.name));
    return { rows: schools };
  }
  if (s.includes("insert into schools")) {
    const id = ((localDb.schools || []).reduce((max, sch) => Math.max(max, sch.id), 0) || 0) + 1;
    const school = {
      id,
      name: p[0],
      center_id: p[1] ? Number(p[1]) : null,
      contact_person: p[2] || "",
      phone: p[3] || "",
      email: p[4] || "",
      address: p[5] || "",
      session_time: p[6] || ""
    };
    if (!localDb.schools) localDb.schools = [];
    localDb.schools.push(school);
    saveLocalDb();
    return { rows: [{ id }] };
  }
  if (s.includes("update schools set")) {
    const sId = Number(p[7] !== undefined ? p[7] : p[6]);
    const sch = (localDb.schools || []).find(x => x.id === sId);
    if (sch) {
      sch.name = p[0];
      sch.center_id = p[1] ? Number(p[1]) : null;
      sch.contact_person = p[2] || "";
      sch.phone = p[3] || "";
      sch.email = p[4] || "";
      sch.address = p[5] || "";
      sch.session_time = p[6] || "";
      saveLocalDb();
    }
    return { rowCount: sch ? 1 : 0, rows: [] };
  }
  if (s.includes("delete from schools where id=$1")) {
    const sId = Number(p[0]);
    if (localDb.schools) {
      localDb.schools = localDb.schools.filter(x => x.id !== sId);
      saveLocalDb();
    }
    return { rows: [] };
  }

  // user_centers queries
  if (s.includes("select center_id from user_centers where user_id=$1")) {
    const user = localDb.users.find(u => u.id === Number(p[0]));
    const ids = user ? (user.center_ids || (user.center_id ? [user.center_id] : [])) : [];
    return { rows: ids.map(cid => ({ center_id: cid })) };
  }

  // user_schools queries
  if (s.includes("select school_id from user_schools where user_id=$1")) {
    const user = localDb.users.find(u => u.id === Number(p[0]));
    const ids = user ? (user.school_ids || [1, 2, 3]) : [1, 2, 3];
    return { rows: ids.map(sid => ({ school_id: sid })) };
  }

  // centers queries
  if (s.includes("select * from centers order by name")) {
    const centers = [...localDb.centers].sort((a, b) => a.name.localeCompare(b.name));
    return { rows: centers };
  }
  if (s.includes("insert into centers")) {
    const id = (localDb.centers.reduce((max, c) => Math.max(max, c.id), 0) || 0) + 1;
    const center = {
      id,
      name: p[0],
      location: p[1] || "",
      session_time: p[2] || "",
      contact: p[3] || ""
    };
    localDb.centers.push(center);
    saveLocalDb();
    return { rows: [{ id }] };
  }
  if (s.includes("update centers set")) {
    const cId = Number(p[4]);
    const center = localDb.centers.find(c => c.id === cId);
    if (center) {
      center.name = p[0];
      center.location = p[1] || "";
      center.session_time = p[2] || "";
      center.contact = p[3] || "";
      saveLocalDb();
    }
    return { rowCount: center ? 1 : 0, rows: [] };
  }
  if (s.includes("delete from centers where id=$1")) {
    localDb.centers = localDb.centers.filter(c => c.id !== Number(p[0]));
    localDb.users.forEach(u => {
      if (u.center_id === Number(p[0])) u.center_id = null;
      if (u.center_ids) u.center_ids = u.center_ids.filter(id => id !== Number(p[0]));
    });
    localDb.reports = localDb.reports.filter(r => r.center_id !== Number(p[0]));
    saveLocalDb();
    return { rows: [] };
  }

  // reports queries
  if (s.includes("select * from reports order by date desc, id desc")) {
    const reports = [...localDb.reports]
      .sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.id - a.id);
    return { rows: reports };
  }
  if (s.includes("select * from reports where id=$1")) {
    const rep = localDb.reports.find(r => r.id === Number(p[0]));
    return { rows: rep ? [{ ...rep }] : [] };
  }
  if (s.includes("select member_id, year from reports where id=$1") || s.includes("select member_id from reports where id=$1")) {
    const rep = localDb.reports.find(r => r.id === Number(p[0]));
    return { rows: rep ? [{ member_id: rep.member_id, year: rep.year || 2026 }] : [] };
  }
  if (s.includes("insert into reports")) {
    const id = (localDb.reports.reduce((max, r) => Math.max(max, r.id), 0) || 0) + 1;
    const now = new Date().toISOString();
    const report = {
      id,
      center_id: Number(p[0]),
      member_id: Number(p[1]),
      member_name: p[2],
      school: p[3],
      date: p[4],
      attendance: p[5],
      details: p[6],
      students: Number(p[7]),
      remarks: p[8] || "",
      challenges: p[9] || "",
      photos: p[10] || "[]",
      status: p[11] || "submitted",
      year: Number(p[12]) || new Date().getFullYear(),
      academic_session: p[13] || "First Term",
      class_level: p[14] || "",
      created_at: now,
      updated_at: now
    };
    localDb.reports.unshift(report);
    saveLocalDb();
    return { rows: [{ id }] };
  }
  if (s.includes("update reports set")) {
    const reportId = Number(p[8]);
    const report = localDb.reports.find(r => r.id === reportId);
    if (report) {
      report.date = p[0];
      report.attendance = p[1];
      report.details = p[2];
      report.students = Number(p[3]);
      report.remarks = p[4];
      report.challenges = p[5];
      report.photos = p[6] || "[]";
      report.class_level = p[7] || report.class_level || "";
      report.updated_at = new Date().toISOString();
      saveLocalDb();
    }
    return { rowCount: report ? 1 : 0, rows: [] };
  }
  if (s.includes("delete from reports where id=$1")) {
    const id = Number(p[0]);
    const isAdmin = Boolean(p[1]);
    const memberId = Number(p[2]);
    const initialLen = localDb.reports.length;
    localDb.reports = localDb.reports.filter(r => !(r.id === id && (isAdmin || r.member_id === memberId)));
    saveLocalDb();
    return { rowCount: initialLen - localDb.reports.length, rows: [] };
  }

  // password reset queries
  if (s.includes("delete from password_resets where user_id=$1")) {
    localDb.password_resets = localDb.password_resets.filter(pr => pr.user_id !== Number(p[0]));
    saveLocalDb();
    return { rows: [] };
  }
  if (s.includes("insert into password_resets")) {
    localDb.password_resets.push({
      token_hash: p[0],
      user_id: Number(p[1]),
      expires_at: new Date(Date.now() + 3600000).toISOString()
    });
    saveLocalDb();
    return { rows: [] };
  }
  if (s.includes("select user_id from password_resets where token_hash=$1")) {
    const pr = localDb.password_resets.find(item => item.token_hash === p[0] && new Date(item.expires_at) > new Date());
    return { rows: pr ? [{ user_id: pr.user_id }] : [] };
  }

  // login_otps queries
  if (s.includes("delete from login_otps where email=$1")) {
    if (!localDb.login_otps) localDb.login_otps = [];
    localDb.login_otps = localDb.login_otps.filter(o => o.email.toLowerCase() !== p[0].toLowerCase());
    saveLocalDb();
    return { rows: [] };
  }
  if (s.includes("insert into login_otps")) {
    if (!localDb.login_otps) localDb.login_otps = [];
    localDb.login_otps.push({
      email: p[0].toLowerCase(),
      otp_code: p[1],
      expires_at: new Date(Date.now() + 600000).toISOString()
    });
    saveLocalDb();
    return { rows: [] };
  }
  if (s.includes("select otp_code from login_otps where email=$1 and expires_at > now()")) {
    if (!localDb.login_otps) localDb.login_otps = [];
    const item = localDb.login_otps.find(o => o.email.toLowerCase() === p[0].toLowerCase() && new Date(o.expires_at) > new Date());
    return { rows: item ? [{ otp_code: item.otp_code }] : [] };
  }

  // reminders_sent queries
  if (s.includes("select * from reminders_sent") || s.includes("insert into reminders_sent")) {
    if (!localDb.reminders_sent) localDb.reminders_sent = [];
    if (s.startsWith("insert into reminders_sent")) {
      localDb.reminders_sent.push({
        id: localDb.reminders_sent.length + 1,
        user_id: Number(p[0]),
        school_id: Number(p[1]),
        reminder_type: p[2],
        session_date: p[3],
        sent_at: new Date().toISOString()
      });
      saveLocalDb();
    }
    return { rows: [...localDb.reminders_sent] };
  }

  return { rows: [] };
}

async function setup() {
  if (isPostgres) {
    await q(`create table if not exists centers (
      id serial primary key,
      name text not null,
      location text,
      session_time text,
      contact text
    );
    create table if not exists schools (
      id serial primary key,
      name text not null,
      center_id int references centers on delete set null,
      contact_person text,
      phone text,
      email text,
      address text
    );
    create table if not exists users (
      id serial primary key,
      name text not null,
      email text unique not null,
      password_hash text not null,
      center_id int references centers on delete set null,
      is_admin boolean not null default false,
      phone text,
      bio text,
      created_at timestamptz default now(),
      last_active_at timestamptz default now()
    );
    create table if not exists user_centers (
      user_id int references users on delete cascade,
      center_id int references centers on delete cascade,
      primary key (user_id, center_id)
    );
    create table if not exists user_schools (
      user_id int references users on delete cascade,
      school_id int references schools on delete cascade,
      primary key (user_id, school_id)
    );
    create table if not exists reports (
      id serial primary key,
      center_id int references centers on delete cascade,
      member_id int references users on delete set null,
      member_name text,
      school text not null,
      date date not null,
      attendance text,
      details text not null,
      students int not null,
      remarks text,
      challenges text,
      photos text,
      status text default 'submitted',
      year int default 2026,
      academic_session text default 'First Term',
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    );
    create table if not exists password_resets (
      token_hash text primary key,
      user_id int references users on delete cascade,
      expires_at timestamptz not null
    );`);

    // Migrations for existing databases
    await q(`alter table centers add column if not exists location text;`).catch(() => {});
    await q(`alter table centers add column if not exists session_time text;`).catch(() => {});
    await q(`alter table centers add column if not exists contact text;`).catch(() => {});
    await q(`alter table schools add column if not exists session_time text;`).catch(() => {});
    await q(`alter table users add column if not exists phone text;`).catch(() => {});
    await q(`alter table users add column if not exists whatsapp text;`).catch(() => {});
    await q(`alter table users add column if not exists bio text;`).catch(() => {});
    await q(`alter table users add column if not exists created_at timestamptz default now();`).catch(() => {});
    await q(`alter table reports add column if not exists photos text;`).catch(() => {});
    await q(`alter table reports add column if not exists status text default 'submitted';`).catch(() => {});
    await q(`alter table reports add column if not exists updated_at timestamptz default now();`).catch(() => {});
    await q(`alter table reports add column if not exists year int default 2026;`).catch(() => {});
    await q(`alter table reports add column if not exists academic_session text default 'First Term';`).catch(() => {});
    await q(`alter table reports add column if not exists class_level text;`).catch(() => {});
    await q(`alter table users add column if not exists last_active_at timestamptz default now();`).catch(() => {});
    await q(`create table if not exists login_otps (
      email text primary key,
      otp_code text not null,
      expires_at timestamptz not null
    );`).catch(() => {});
    await q(`create table if not exists reminders_sent (
      id serial primary key,
      user_id int,
      school_id int,
      reminder_type text,
      session_date text,
      sent_at timestamptz default now()
    );`).catch(() => {});

    // Seed default schools in PostgreSQL if empty
    const count = (await q("select count(*) from schools")).rows[0].count;
    if (count === "0") {
      for (const sc of defaultSchools) {
        await q("insert into schools(name, center_id, contact_person, phone, email, address, session_time) values($1, $2, $3, $4, $5, $6, $7)",
          [sc.name, sc.center_id, sc.contact_person, sc.phone, sc.email, sc.address, sc.session_time || ""]).catch(() => {});
      }
    }

    // One-time requested clearout of all existing registered users:
    await q(`create table if not exists app_migrations (name text primary key, applied_at timestamptz default now());`).catch(() => {});
    const clearedRes = await q(`select name from app_migrations where name='wipe_users_20261114'`).catch(() => ({ rows: [] }));
    if (!clearedRes.rows.length) {
      console.log("Executing requested one-time wipe of registered accounts...");
      await q(`delete from password_resets;`).catch(() => {});
      await q(`delete from user_schools;`).catch(() => {});
      await q(`delete from user_centers;`).catch(() => {});
      await q(`delete from users;`).catch(() => {});
      await q(`insert into app_migrations(name) values('wipe_users_20261114');`).catch(() => {});
      console.log("All registered user accounts cleared. kineromosele@gmail.com is configured as default administrator.");
    }
  } else if (localDb) {
    if (!localDb.wiped_users_20261114) {
      localDb.users = [];
      localDb.user_schools = [];
      localDb.user_centers = [];
      localDb.password_resets = [];
      localDb.wiped_users_20261114 = true;
      saveLocalDb();
      console.log("Local database user accounts wiped successfully.");
    }
  }
}

const app = express();
app.use(express.json({ limit: "30mb" }));
app.use(express.urlencoded({ extended: true, limit: "30mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e);
  res.status(500).json({ error: "Something went wrong" });
});

// Helper to fetch full centers assigned to a user
async function getUserCenters(user, allCenters) {
  if (user.is_admin) {
    return allCenters;
  }
  let assignedIds = [];
  if (isPostgres) {
    const ucRes = await q("select center_id from user_centers where user_id=$1", [user.id]);
    assignedIds = ucRes.rows.map(r => r.center_id);
  } else {
    assignedIds = user.center_ids || [];
  }
  if (user.center_id && !assignedIds.includes(user.center_id)) {
    assignedIds.push(user.center_id);
  }
  return allCenters.filter(c => assignedIds.includes(c.id));
}

// Helper to fetch schools assigned to a user
async function getUserSchools(user, allSchools) {
  if (user.is_admin) {
    return allSchools;
  }
  let assignedIds = [];
  if (isPostgres) {
    const usRes = await q("select school_id from user_schools where user_id=$1", [user.id]);
    assignedIds = usRes.rows.map(r => r.school_id);
  } else {
    assignedIds = user.school_ids || [];
  }
  // If no explicit school assigned, provide all schools in the user's centres or all default schools
  if (!assignedIds.length) {
    return allSchools;
  }
  return allSchools.filter(s => assignedIds.includes(s.id));
}

async function auth(req, res, next) {
  try {
    let token = req.cookies.token;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7).trim();
    }
    if (!token) throw 0;

    const { id } = jwt.verify(token, SECRET);
    const r = await q("select id,name,email,center_id,is_admin,phone,bio,created_at,last_active_at from users where id=$1", [id]);
    if (!r.rows[0]) throw 0;
    req.user = r.rows[0];
    req.token = token;

    // Keep track of member active status asynchronously
    q("update users set last_active_at=now() where id=$1", [id]).catch(() => {});

    next();
  } catch {
    res.status(401).json({ error: "Please log in" });
  }
}

const admin = (req, res, next) => req.user.is_admin ? next() : res.status(403).json({ error: "Admins only" });

function login(res, id) {
  // Remember user login for 1 year (365 days)
  const token = jwt.sign({ id }, SECRET, { expiresIn: "365d" });
  res.cookie("token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 365 * 864e5
  });
  return token;
}

/* ---- Authentication & Multi-Account Routes ---- */
app.post("/api/signup", wrap(async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const pw = String(req.body.password || "");
  const whatsapp = String(req.body.whatsapp || req.body.phone || "").trim();

  if (!name || !email.includes("@") || pw.length < 6) {
    return res.status(400).json({ error: "Enter your name, a valid email and a password of at least 6 characters." });
  }

  if (!whatsapp) {
    return res.status(400).json({ error: "WhatsApp number is required to receive meeting reminders and outreach updates." });
  }

  if ((await q("select 1 from users where email=$1", [email])).rows[0]) {
    return res.status(400).json({ error: "That email is already registered. Please log in." });
  }

  const isFirstUser = isPostgres
    ? (await q("select count(*) from users")).rows[0].count === "0"
    : localDb.users.length === 0;

  const isAdmin = ADMIN_EMAILS.includes(email) || email === ADMIN_EMAIL || isFirstUser;

  const r = await q("insert into users(name,email,password_hash,is_admin,phone,whatsapp) values($1,$2,$3,$4,$5,$6) returning id",
    [name, email, await bcrypt.hash(pw, 10), isAdmin, whatsapp, whatsapp]);

  const token = login(res, r.rows[0].id);
  res.json({
    ok: true,
    is_admin: isAdmin,
    token,
    user: { id: r.rows[0].id, name, email, is_admin: isAdmin, phone: whatsapp, whatsapp }
  });
}));

app.post("/api/login", wrap(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const r = await q("select id,password_hash,name,is_admin,email,phone,whatsapp from users where email=$1", [email]);
  if (!r.rows[0] || !(await bcrypt.compare(String(req.body.password || ""), r.rows[0].password_hash))) {
    return res.status(400).json({ error: "Wrong email or password." });
  }

  // Generate 6-digit confirmation code
  const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

  await q("delete from login_otps where email=$1", [email]);
  await q("insert into login_otps(email, otp_code, expires_at) values($1, $2, now() + interval '10 minutes')", [email, otpCode]);

  // Send confirmation email
  await sendMail(
    email,
    `Your TEENETWORK Confirmation Code: ${otpCode}`,
    `<div style="font-family: sans-serif; max-width: 500px; margin: auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px;">
      <h2 style="color: #1034A6; margin-top: 0;">TEENETWORK Portal Access</h2>
      <p>Hello <strong>${escHtml(r.rows[0].name)}</strong>,</p>
      <p>Here is your 6-digit confirmation code to access the TEENETWORK portal:</p>
      <div style="background: #eef4ff; border: 2px dashed #1034A6; border-radius: 12px; padding: 16px; text-align: center; margin: 20px 0;">
        <span style="font-size: 32px; font-weight: 900; letter-spacing: 6px; color: #1034A6; font-family: monospace;">${otpCode}</span>
      </div>
      <p style="font-size: 12px; color: #64748b;">This code will expire in 10 minutes. If you did not make this login request, please change your password immediately.</p>
    </div>`
  );

  console.log(`🔐 Confirmation OTP sent to ${email}: ${otpCode}`);

  res.json({
    require_otp: true,
    email,
    message: "A 6-digit confirmation code has been sent to your email.",
    dev_code: process.env.RESEND_API_KEY ? undefined : otpCode
  });
}));

app.post("/api/verify-login-otp", wrap(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const otp = String(req.body.otp || "").trim();

  if (!email || !otp) {
    return res.status(400).json({ error: "Email and confirmation code are required." });
  }

  const otpRow = await q("select otp_code from login_otps where email=$1 and expires_at > now()", [email]);
  if (!otpRow.rows[0] || otpRow.rows[0].otp_code !== otp) {
    return res.status(400).json({ error: "Invalid or expired confirmation code. Please check your email or request a new code." });
  }

  await q("delete from login_otps where email=$1", [email]);

  const u = (await q("select id,name,email,center_id,is_admin,phone,whatsapp from users where email=$1", [email])).rows[0];
  if (!u) return res.status(404).json({ error: "User account not found." });

  let isAdmin = Boolean(u.is_admin);
  if (ADMIN_EMAILS.includes(email) && !isAdmin) {
    await q("update users set is_admin=true where id=$1", [u.id]);
    isAdmin = true;
  }

  const token = login(res, u.id);
  res.json({
    ok: true,
    token,
    user: { id: u.id, name: u.name, email: u.email, is_admin: isAdmin, phone: u.phone, whatsapp: u.whatsapp }
  });
}));

app.post("/api/resend-login-otp", wrap(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const u = (await q("select id,name,email from users where email=$1", [email])).rows[0];
  if (!u) return res.status(404).json({ error: "User not found." });

  const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
  await q("delete from login_otps where email=$1", [email]);
  await q("insert into login_otps(email, otp_code, expires_at) values($1, $2, now() + interval '10 minutes')", [email, otpCode]);

  await sendMail(email, `Your TEENETWORK Confirmation Code: ${otpCode}`,
    `<p>Your new TEENETWORK confirmation code is: <strong>${otpCode}</strong> (valid for 10 minutes).</p>`
  );

  console.log(`🔄 Resent OTP for ${email}: ${otpCode}`);
  res.json({
    ok: true,
    message: "A new confirmation code has been sent to your email.",
    dev_code: process.env.RESEND_API_KEY ? undefined : otpCode
  });
}));

// Multi-account instant switcher endpoint
app.post("/api/switch-account", wrap(async (req, res) => {
  const token = String(req.body.token || "");
  if (!token) return res.status(400).json({ error: "Missing account token" });
  try {
    const { id } = jwt.verify(token, SECRET);
    const r = await q("select id,name,email,center_id,is_admin from users where id=$1", [id]);
    if (!r.rows[0]) return res.status(404).json({ error: "User not found" });
    const newToken = login(res, id);
    res.json({ ok: true, token: newToken, user: r.rows[0] });
  } catch {
    res.status(401).json({ error: "Session expired for this account. Please log in again." });
  }
}));

app.post("/api/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

app.get("/api/me", auth, wrap(async (req, res) => {
  const allCenters = (await q("select * from centers order by name")).rows;
  const allSchools = (await q("select * from schools order by name")).rows;
  const userCenters = await getUserCenters(req.user, allCenters);
  const userSchools = await getUserSchools(req.user, allSchools);

  res.json({
    ...req.user,
    token: req.token,
    centers: userCenters,
    schools: userSchools
  });
}));

/* ---- User Profile Update ---- */
app.put("/api/profile", auth, wrap(async (req, res) => {
  const name = String(req.body.name || "").trim();
  const phone = String(req.body.phone || "").trim();
  const bio = String(req.body.bio || "").trim();

  if (!name) return res.status(400).json({ error: "Name cannot be empty." });

  await q("update users set name=$1, phone=$2, bio=$3 where id=$4", [name, phone, bio, req.user.id]);
  res.json({ ok: true });
}));

/* ---- Data & Reporting Routes ---- */
app.get("/api/data", auth, wrap(async (req, res) => {
  const u = req.user;
  const centers = (await q("select * from centers order by name")).rows;
  const allSchools = (await q("select * from schools order by name")).rows;
  const userCenters = await getUserCenters(u, centers);
  const userSchools = await getUserSchools(u, allSchools);
  const userCenterIds = userCenters.map(c => c.id);

  let reports = (await q("select * from reports order by date desc, id desc")).rows;
  if (!u.is_admin) {
    const userSchoolNames = userSchools.map(s => s.name.trim().toLowerCase());
    reports = reports.filter(r =>
      userCenterIds.includes(Number(r.center_id)) ||
      userSchoolNames.includes((r.school || "").trim().toLowerCase()) ||
      r.member_id === u.id
    );
  }

  const rawUsers = u.is_admin
    ? (await q("select id,name,email,center_id,is_admin,phone,bio,created_at,last_active_at,whatsapp from users order by name")).rows
    : [];

  const users = rawUsers.map(user => {
    const userReports = reports.filter(rep => rep.member_id === user.id);
    const studentsReached = userReports.reduce((acc, rep) => acc + (Number(rep.students) || 0), 0);
    return {
      ...user,
      report_count: userReports.length,
      students_reached: studentsReached
    };
  });

  const totalStudents = reports.reduce((acc, rep) => acc + (Number(rep.students) || 0), 0);
  const totalReports = reports.length;
  const uniqueSchools = [...new Set(reports.map(r => (r.school || "").trim().toLowerCase()).filter(Boolean))].length;
  const activeMembersCount = users.filter(usr => {
    if (!usr.last_active_at) return false;
    const diffDays = (Date.now() - new Date(usr.last_active_at).getTime()) / (1000 * 3600 * 24);
    return diffDays <= 30;
  }).length;

  // Distinct Students Reached Calculation (Rule: Sum of average students reached per school per year)
  // Prevents repeat counts of recurring visits to the same school audience
  const schoolAveragesMap = {};
  reports.forEach(rep => {
    const sch = (rep.school || "").trim().toLowerCase();
    if (!sch) return;
    const yr = Number(rep.year) || new Date(rep.date || Date.now()).getFullYear();
    const key = `${yr}:::${sch}`;
    if (!schoolAveragesMap[key]) {
      schoolAveragesMap[key] = { year: yr, school: rep.school.trim(), sumStudents: 0, count: 0 };
    }
    schoolAveragesMap[key].sumStudents += Number(rep.students) || 0;
    schoolAveragesMap[key].count += 1;
  });

  const schoolAveragesList = Object.values(schoolAveragesMap).map(item => ({
    year: item.year,
    school: item.school,
    reportCount: item.count,
    avgStudents: Math.round(item.sumStudents / item.count)
  }));

  const distinctStudentsReached = schoolAveragesList.reduce((acc, item) => acc + item.avgStudents, 0);
  const avgStudentsPerSchool = schoolAveragesList.length > 0 ? Math.round(distinctStudentsReached / schoolAveragesList.length) : 0;

  res.json({
    centers,
    user_centers: userCenters,
    schools: allSchools,
    user_schools: userSchools,
    reports,
    users,
    stats: {
      totalStudents,
      distinctStudentsReached,
      avgStudentsPerSchool,
      schoolAverages: schoolAveragesList,
      totalReports,
      uniqueSchools,
      activeMembers: u.is_admin ? activeMembersCount : undefined
    }
  });
}));

/* ---- AI WhatsApp Reminders Engine ---- */
app.get("/api/reminders", auth, wrap(async (req, res) => {
  const allUsers = (await q("select id,name,email,phone,whatsapp,is_admin from users order by name")).rows;
  const allSchools = (await q("select * from schools order by name")).rows;
  const remindersSent = (await q("select * from reminders_sent order by sent_at desc")).rows;

  const reminders = [];

  for (const user of allUsers) {
    const userPhone = (user.whatsapp || user.phone || "").trim();
    if (!userPhone) continue;
    const cleanPhone = userPhone.replace(/[^0-9]/g, "");
    if (!cleanPhone) continue;

    const userSchools = await getUserSchools(user, allSchools);

    for (const school of userSchools) {
      const schoolAddress = school.address || "Assigned School Outreach Center";
      const sessionTime = school.session_time || "Morning Assembly / Outreach Period";

      // 1. "Day Before" Reminder
      const keyDayBefore = `${user.id}_${school.id}_1day`;
      const sent1Day = remindersSent.find(r => r.user_id === user.id && r.school_id === school.id && r.reminder_type === "1_day_before");

      const msgDayBefore = `🌟 *TEENETWORK OUTREACH REMINDER (1 Day Before)*\n\nHello *${user.name}*,\nThis is a friendly reminder of your upcoming outreach session tomorrow:\n\n🏫 *School:* ${school.name}\n📍 *Location:* ${schoolAddress}\n⏰ *Meeting Time:* ${sessionTime}\n\nBe prayerful, prepared, and punctual. God bless your labor in TEENETWORK! 🙏✨`;
      const waLink1Day = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(msgDayBefore)}`;

      reminders.push({
        id: keyDayBefore,
        user_id: user.id,
        user_name: user.name,
        whatsapp: userPhone,
        school_id: school.id,
        school_name: school.name,
        location: schoolAddress,
        session_time: sessionTime,
        reminder_type: "1 Day Before",
        reminder_type_raw: "1_day_before",
        message: msgDayBefore,
        wa_link: waLink1Day,
        sent: Boolean(sent1Day),
        sent_at: sent1Day?.sent_at || null
      });

      // 2. "3 Hours Before" Reminder
      const key3Hours = `${user.id}_${school.id}_3hours`;
      const sent3Hours = remindersSent.find(r => r.user_id === user.id && r.school_id === school.id && r.reminder_type === "3_hours_before");

      const msg3Hours = `🚨 *TEENETWORK URGENT REMINDER (3 Hours to Meeting)*\n\nHello *${user.name}*,\nYour outreach meeting starts in *3 hours*!\n\n🏫 *School:* ${school.name}\n📍 *Location:* ${schoolAddress}\n⏰ *Meeting Time:* ${sessionTime}\n\nPlease prepare to head out and arrive safely. You are making an eternal difference! 🌾🔥`;
      const waLink3Hours = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(msg3Hours)}`;

      reminders.push({
        id: key3Hours,
        user_id: user.id,
        user_name: user.name,
        whatsapp: userPhone,
        school_id: school.id,
        school_name: school.name,
        location: schoolAddress,
        session_time: sessionTime,
        reminder_type: "3 Hours Before",
        reminder_type_raw: "3_hours_before",
        message: msg3Hours,
        wa_link: waLink3Hours,
        sent: Boolean(sent3Hours),
        sent_at: sent3Hours?.sent_at || null
      });
    }
  }

  res.json({ reminders, total: reminders.length });
}));

app.post("/api/reminders/trigger", auth, admin, wrap(async (req, res) => {
  const { user_id, school_id, reminder_type } = req.body;
  if (!user_id || !school_id || !reminder_type) {
    return res.status(400).json({ error: "Missing user_id, school_id, or reminder_type." });
  }

  await q("insert into reminders_sent(user_id, school_id, reminder_type, session_date) values($1, $2, $3, $4)",
    [Number(user_id), Number(school_id), reminder_type, new Date().toISOString().split("T")[0]]);

  res.json({ ok: true, message: "Reminder marked as dispatched." });
}));

/* ---- Schools Management ---- */
app.post("/api/schools", auth, admin, wrap(async (req, res) => {
  const { name, center_id, contact_person, phone, email, address, session_time } = req.body;
  if (!name) return res.status(400).json({ error: "School name is required." });

  await q("insert into schools(name, center_id, contact_person, phone, email, address, session_time) values($1, $2, $3, $4, $5, $6, $7)",
    [name.trim(), center_id ? Number(center_id) : null, contact_person || "", phone || "", email || "", address || "", session_time || ""]);
  res.json({ ok: true });
}));

app.put("/api/schools/:id", auth, admin, wrap(async (req, res) => {
  const { name, center_id, contact_person, phone, email, address, session_time } = req.body;
  if (!name) return res.status(400).json({ error: "School name is required." });

  await q("update schools set name=$1, center_id=$2, contact_person=$3, phone=$4, email=$5, address=$6, session_time=$7 where id=$8",
    [name.trim(), center_id ? Number(center_id) : null, contact_person || "", phone || "", email || "", address || "", session_time || "", req.params.id]);
  res.json({ ok: true });
}));

app.delete("/api/schools/:id", auth, admin, wrap(async (req, res) => {
  await q("delete from schools where id=$1", [req.params.id]);
  res.json({ ok: true });
}));

/* ---- Centre Management ---- */
app.post("/api/centers", auth, admin, wrap(async (req, res) => {
  const name = String(req.body.name || "").trim();
  const location = String(req.body.location || "").trim();
  const session_time = String(req.body.session_time || "").trim();
  const contact = String(req.body.contact || "").trim();

  if (!name) return res.status(400).json({ error: "Enter a centre name" });

  await q("insert into centers(name, location, session_time, contact) values($1, $2, $3, $4)",
    [name, location, session_time, contact]);
  res.json({ ok: true });
}));

app.put("/api/centers/:id", auth, admin, wrap(async (req, res) => {
  const name = String(req.body.name || "").trim();
  const location = String(req.body.location || "").trim();
  const session_time = String(req.body.session_time || "").trim();
  const contact = String(req.body.contact || "").trim();

  if (!name) return res.status(400).json({ error: "Enter a centre name" });

  await q("update centers set name=$1, location=$2, session_time=$3, contact=$4 where id=$5",
    [name, location, session_time, contact, req.params.id]);
  res.json({ ok: true });
}));

app.delete("/api/centers/:id", auth, admin, wrap(async (req, res) => {
  await q("delete from centers where id=$1", [req.params.id]);
  res.json({ ok: true });
}));

app.put("/api/users/:id/center", auth, admin, wrap(async (req, res) => {
  const centerId = req.body.center_id ? Number(req.body.center_id) : null;
  await q("update users set center_id=$1 where id=$2", [centerId, req.params.id]);
  res.json({ ok: true });
}));

/* ---- Report Submission & Editing (With Year Lockout Rule & Class Level) ---- */
app.post("/api/reports", auth, wrap(async (req, res) => {
  const u = req.user, b = req.body;
  const allCenters = (await q("select * from centers order by name")).rows;
  const userCenters = await getUserCenters(u, allCenters);

  let centerId = b.center_id ? Number(b.center_id) : null;
  if (!centerId) {
    centerId = userCenters[0]?.id || u.center_id || 1;
  }

  if (!b.school || !b.date || !b.details || b.students === "" || isNaN(Number(b.students))) {
    return res.status(400).json({ error: "Please fill in date, session details and number of students." });
  }

  const currentYear = new Date().getFullYear();
  const year = Number(b.year) || currentYear;

  // Previous Years Lockout Rule:
  if (year < currentYear && !u.is_admin) {
    return res.status(403).json({ error: "Members cannot submit reports for past academic years. Only administrators can submit past year reports." });
  }

  const photos = Array.isArray(b.photos) ? JSON.stringify(b.photos) : (typeof b.photos === "string" ? b.photos : "[]");
  const academicSession = b.academic_session || "First Term";
  const classLevel = b.class_level || b.class || "";

  await q(`insert into reports(center_id,member_id,member_name,school,date,attendance,details,students,remarks,challenges,photos,status,year,academic_session,class_level)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [centerId, u.id, u.name, b.school.trim(), b.date, b.attendance || "", b.details.trim(), Number(b.students), b.remarks || "", b.challenges || "", photos, "submitted", year, academicSession, classLevel]);

  res.json({ ok: true });
}));

app.put("/api/reports/:id", auth, wrap(async (req, res) => {
  const u = req.user, b = req.body;
  const repId = req.params.id;

  const check = await q("select member_id, year from reports where id=$1", [repId]);
  if (!check.rows[0]) return res.status(404).json({ error: "Report not found" });

  const report = check.rows[0];
  const currentYear = new Date().getFullYear();

  // Past Year Lockout Rule:
  // "ONCE A YEAR IS FINISHED THE DETAILS IN THAT YEAR WILL BECOME EDITABLE ONLY BY AN ADMIN WHEN THEY LOG IN TO REVIEW THE REPORTS"
  if (Number(report.year) < currentYear && !u.is_admin) {
    return res.status(403).json({ error: "This report is from a past academic year and is locked. It can only be reviewed or edited by an Administrator." });
  }

  if (!u.is_admin && report.member_id !== u.id) {
    return res.status(403).json({ error: "You can only edit your own reports." });
  }

  if (!b.date || !b.details || b.students === "" || isNaN(Number(b.students))) {
    return res.status(400).json({ error: "Please fill in date, session details and number of students." });
  }

  const photos = Array.isArray(b.photos) ? JSON.stringify(b.photos) : (typeof b.photos === "string" ? b.photos : "[]");
  const classLevel = b.class_level || b.class || "";

  await q(`update reports set date=$1, attendance=$2, details=$3, students=$4, remarks=$5, challenges=$6, photos=$7, updated_at=now(), class_level=$8 where id=$9`,
    [b.date, b.attendance || "", b.details.trim(), Number(b.students), b.remarks || "", b.challenges || "", photos, classLevel, repId]);

  res.json({ ok: true });
}));

app.delete("/api/reports/:id", auth, wrap(async (req, res) => {
  const check = await q("select member_id, year from reports where id=$1", [req.params.id]);
  if (!check.rows[0]) return res.status(404).json({ error: "Report not found" });

  const report = check.rows[0];
  const currentYear = new Date().getFullYear();

  if (Number(report.year) < currentYear && !req.user.is_admin) {
    return res.status(403).json({ error: "Reports from past academic years cannot be deleted by members. Contact an administrator." });
  }

  await q("delete from reports where id=$1 and ($2 or member_id=$3)", [req.params.id, req.user.is_admin, req.user.id]);
  res.json({ ok: true });
}));

/* ---- Password Management ---- */
app.put("/api/password", auth, wrap(async (req, res) => {
  const r = await q("select password_hash from users where id=$1", [req.user.id]);
  const np = String(req.body.new_password || "");
  if (!(await bcrypt.compare(String(req.body.current_password || ""), r.rows[0].password_hash))) {
    return res.status(400).json({ error: "Your current password is wrong." });
  }
  if (np.length < 6) return res.status(400).json({ error: "The new password must be at least 6 characters." });
  await q("update users set password_hash=$1 where id=$2", [await bcrypt.hash(np, 10), req.user.id]);
  res.json({ ok: true });
}));

app.put("/api/users/:id/password", auth, admin, wrap(async (req, res) => {
  const np = String(req.body.password || "");
  if (np.length < 6) return res.status(400).json({ error: "The password must be at least 6 characters." });
  await q("update users set password_hash=$1 where id=$2", [await bcrypt.hash(np, 10), req.params.id]);
  res.json({ ok: true });
}));

/* ---- Password Reset via Email ---- */
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
const escHtml = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function sendMail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) {
    console.log("RESEND_API_KEY is not set. Email not sent.");
    return;
  }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.RESEND_FROM || "TEENETWORK <onboarding@resend.dev>", to: [to], subject, html })
    });
    if (!r.ok) console.error("Resend error", r.status, await r.text());
  } catch (e) {
    console.error("Resend failed", e.message);
  }
}

app.set("trust proxy", 1);

app.post("/api/forgot", wrap(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const r = await q("select id,name from users where email=$1", [email]);
  if (r.rows[0]) {
    const token = crypto.randomBytes(32).toString("hex");
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    await q("delete from password_resets where user_id=$1", [r.rows[0].id]);
    await q("insert into password_resets(token_hash,user_id,expires_at) values($1,$2,now()+interval '1 hour')", [hash, r.rows[0].id]);
    const link = (APP_URL || req.protocol + "://" + req.get("host")) + "/?reset=" + token;
    await sendMail(email, "Reset your TEENETWORK password",
      `<p>Hello ${escHtml(r.rows[0].name)},</p><p>Click the link below to choose a new password. It is valid for 1 hour.</p><p><a href="${link}">Choose a new password</a></p><p>If you did not ask for this, you can safely ignore this email.</p>`);
  }
  res.json({ ok: true });
}));

app.post("/api/reset", wrap(async (req, res) => {
  const pw = String(req.body.password || "");
  if (pw.length < 6) return res.status(400).json({ error: "The new password must be at least 6 characters." });
  const hash = crypto.createHash("sha256").update(String(req.body.token || "")).digest("hex");
  const r = await q("select user_id from password_resets where token_hash=$1 and expires_at>now()", [hash]);
  if (!r.rows[0]) return res.status(400).json({ error: "This reset link is invalid or has expired. Please request a new one." });
  await q("update users set password_hash=$1 where id=$2", [await bcrypt.hash(pw, 10), r.rows[0].user_id]);
  await q("delete from password_resets where user_id=$1", [r.rows[0].user_id]);
  res.json({ ok: true });
}));

async function adminRecovery() {
  const pw = process.env.RESET_ADMIN_PASSWORD;
  if (!pw || !ADMIN_EMAIL) return;
  if (pw.length < 6) return console.log("RESET_ADMIN_PASSWORD is too short, ignored");
  const r = await q("update users set password_hash=$1, is_admin=true where email=$2", [await bcrypt.hash(pw, 10), ADMIN_EMAIL]);
  console.log(r.rowCount ? "Admin password was reset. Remove RESET_ADMIN_PASSWORD now." : "No account found for ADMIN_EMAIL");
}

const PORT = process.env.PORT || 3000;
setup()
  .then(adminRecovery)
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 TEENETWORK running on port ${PORT}`);
      console.log(`👉 http://localhost:${PORT}`);
    });
  })
  .catch(e => {
    console.error("Initialization error:", e);
    process.exit(1);
  });
