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

/* ---- Academic Year & Term Utilities ---- */
function parseAcademicYear(yearStr) {
  if (!yearStr) return { start: 2026, end: 2027, str: "2026/2027" };
  const str = String(yearStr).trim();
  const parts = str.split("/");
  if (parts.length === 2) {
    const start = parseInt(parts[0], 10);
    const end = parseInt(parts[1], 10);
    if (!isNaN(start) && !isNaN(end)) {
      return { start, end, str: `${start}/${end}` };
    }
  }
  const num = parseInt(str, 10);
  if (!isNaN(num)) {
    return { start: num, end: num + 1, str: `${num}/${num + 1}` };
  }
  return { start: 2026, end: 2027, str: "2026/2027" };
}

function getCurrentAcademicYear() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed: 0 = Jan, 8 = Sep
  if (month >= 8) { // Sep to Dec
    return `${year}/${year + 1}`;
  } else { // Jan to Aug
    return `${year - 1}/${year}`;
  }
}

function isPastAcademicYear(yearStr) {
  const parsed = parseAcademicYear(yearStr);
  const current = parseAcademicYear(getCurrentAcademicYear());
  return parsed.start < current.start;
}

function isFutureAcademicYear(yearStr) {
  const parsed = parseAcademicYear(yearStr);
  const current = parseAcademicYear(getCurrentAcademicYear());
  return parsed.start > current.start;
}

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
      school_ids: [], // Start with 0 assigned schools until admin assigns
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
  if (s.includes("update users set name=$1, phone=$2, whatsapp=$3, bio=$4 where id=$5") ||
      s.includes("update users set name=$1, phone=$2, bio=$3 where id=$4")) {
    const uId = Number(p[4] !== undefined ? p[4] : p[3]);
    const user = localDb.users.find(u => u.id === uId);
    if (user) {
      user.name = p[0];
      user.phone = p[1] || "";
      user.whatsapp = p[2] !== undefined && p[4] !== undefined ? (p[2] || "") : (user.whatsapp || p[1] || "");
      user.bio = p[4] !== undefined ? (p[3] || "") : (p[2] || "");
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
  if (s.includes("select * from schools where id=$1")) {
    const sId = Number(p[0]);
    const sch = (localDb.schools || []).find(x => x.id === sId);
    return { rows: sch ? [sch] : [] };
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
    const sId = Number(p[p.length - 1]);
    const sch = (localDb.schools || []).find(x => x.id === sId);
    if (sch) {
      const oldName = sch.name;
      sch.name = p[0];
      if (p.length === 8) {
        sch.center_id = p[1] ? Number(p[1]) : sch.center_id;
        sch.contact_person = p[2] || "";
        sch.phone = p[3] || "";
        sch.email = p[4] || "";
        sch.address = p[5] || "";
        sch.session_time = p[6] || "";
      } else {
        sch.contact_person = p[1] || "";
        sch.phone = p[2] || "";
        sch.email = p[3] || "";
        sch.address = p[4] || "";
        sch.session_time = p[5] || "";
      }
      if (oldName && oldName.toLowerCase() !== sch.name.toLowerCase()) {
        (localDb.reports || []).forEach(r => {
          if ((r.school || "").toLowerCase() === oldName.toLowerCase()) {
            r.school = sch.name;
          }
        });
      }
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
  if (s.includes("update reports set school=$1 where lower(trim(school))=$2")) {
    const newName = p[0];
    const oldName = (p[1] || "").toLowerCase();
    (localDb.reports || []).forEach(r => {
      if ((r.school || "").trim().toLowerCase() === oldName) {
        r.school = newName;
      }
    });
    saveLocalDb();
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
    const ids = user ? (user.school_ids || []) : [];
    return { rows: ids.map(sid => ({ school_id: sid })) };
  }
  if (s.includes("select user_id, school_id from user_schools")) {
    const rows = [];
    (localDb.users || []).forEach(u => {
      (u.school_ids || []).forEach(sid => rows.push({ user_id: u.id, school_id: sid }));
    });
    return { rows };
  }
  if (s.includes("delete from user_schools where user_id=$1")) {
    const user = localDb.users.find(u => u.id === Number(p[0]));
    if (user) {
      user.school_ids = [];
      saveLocalDb();
    }
    return { rows: [] };
  }
  if (s.includes("insert into user_schools(user_id, school_id)")) {
    const uId = Number(p[0]), sId = Number(p[1]);
    const user = localDb.users.find(u => u.id === uId);
    if (user) {
      user.school_ids = user.school_ids || [];
      if (!user.school_ids.includes(sId)) user.school_ids.push(sId);
      saveLocalDb();
    }
    return { rows: [] };
  }

  // reminder_templates queries
  if (s.includes("from reminder_templates")) {
    const rows = Object.entries(localDb.reminder_templates || {}).map(([key, message]) => ({ key, message }));
    return { rows };
  }
  if (s.includes("insert into reminder_templates") || s.includes("update reminder_templates")) {
    localDb.reminder_templates = localDb.reminder_templates || {};
    localDb.reminder_templates[p[0]] = p[1];
    saveLocalDb();
    return { rows: [{ key: p[0] }] };
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
    return { rows: rep ? [{ member_id: rep.member_id, year: rep.year || "2026/2027", academic_session: rep.academic_session || "First Term" }] : [] };
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
      year: p[12] ? String(p[12]) : "2026/2027",
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
      year text default '2026/2027',
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
    await q(`alter table reports add column if not exists year text default '2026/2027';`).catch(() => {});
    await q(`alter table reports alter column year type text using year::text;`).catch(() => {});
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
    await q(`create table if not exists reminder_templates (
      key text primary key,
      message text not null,
      updated_at timestamptz default now()
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
  const usRes = await q("select school_id from user_schools where user_id=$1", [user.id]);
  const assignedIds = (usRes.rows || []).map(r => Number(r.school_id));
  // RULE: Newly created accounts must NOT have schools automatically assigned.
  // Return empty array if no school has explicitly been assigned by an admin.
  if (!assignedIds.length) {
    return [];
  }
  return (allSchools || []).filter(s => assignedIds.includes(Number(s.id)));
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
  const phone = String(req.body.phone || req.body.whatsapp || "").trim();
  const whatsapp = String(req.body.whatsapp || req.body.phone || "").trim();
  const bio = String(req.body.bio || "").trim();

  if (!name) return res.status(400).json({ error: "Name cannot be empty." });

  await q("update users set name=$1, phone=$2, whatsapp=$3, bio=$4 where id=$5", [name, phone, whatsapp, bio, req.user.id]);
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

  const allUserSchoolsRows = (await q("select user_id, school_id from user_schools")).rows;

  const users = rawUsers.map(user => {
    const userReports = reports.filter(rep => rep.member_id === user.id);
    const studentsReached = userReports.reduce((acc, rep) => acc + (Number(rep.students) || 0), 0);
    const userAssignedSchoolIds = allUserSchoolsRows
      .filter(row => Number(row.user_id) === Number(user.id))
      .map(row => Number(row.school_id));
    const userAssignedSchools = allSchools.filter(s => userAssignedSchoolIds.includes(Number(s.id)));
    return {
      ...user,
      report_count: userReports.length,
      students_reached: studentsReached,
      school_ids: userAssignedSchoolIds,
      schools: userAssignedSchools
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
    const yr = rep.year ? String(rep.year).trim() : (rep.date ? String(new Date(rep.date).getFullYear()) : "2026/2027");
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
  const customTemplates = (await q("select key, message from reminder_templates")).rows;
  const customMap = {};
  customTemplates.forEach(t => { customMap[t.key] = t.message; });

  const defaultMsgDayBeforeTemplate = customMap["template_1day"] || `🌟 *TEENETWORK OUTREACH REMINDER (1 Day Before)*\n\nHello *{member_name}*,\nThis is an automated reminder of your upcoming school outreach session tomorrow:\n\n🏫 *School:* {school_name}\n📍 *Location:* {location}\n⏰ *Meeting Time:* {session_time}\n\nBe prayerful, prepared, and punctual. God bless your labor in TEENETWORK! 🙏✨`;

  const defaultMsg3HoursTemplate = customMap["template_3hours"] || `🚨 *TEENETWORK URGENT REMINDER (3 Hours to Meeting)*\n\nHello *{member_name}*,\nYour outreach meeting starts in *3 hours*!\n\n🏫 *School:* {school_name}\n📍 *Location:* {location}\n⏰ *Meeting Time:* {session_time}\n\nPlease prepare to head out and arrive safely. You are making an eternal difference! 🌾🔥`;

  const reminders = [];

  for (const user of allUsers) {
    if (user.is_admin) continue; // Reminders are strictly for outreach members

    const userPhone = (user.whatsapp || user.phone || "").trim();
    if (!userPhone) continue;
    const cleanPhone = userPhone.replace(/[^0-9]/g, "");
    if (!cleanPhone) continue;

    // RULE: Only members who have assigned schools with the school attached!
    const userSchools = await getUserSchools(user, allSchools);
    if (!userSchools || !userSchools.length) {
      continue;
    }

    for (const school of userSchools) {
      const schoolAddress = school.address || "Assigned School Outreach Center";
      const sessionTime = school.session_time || "Morning Assembly / Outreach Period";

      // 1. "Day Before" Reminder
      const keyDayBefore = `${user.id}_${school.id}_1day`;
      const sent1Day = remindersSent.find(r => Number(r.user_id) === Number(user.id) && Number(r.school_id) === Number(school.id) && r.reminder_type === "1_day_before");

      let rawTemplate1Day = customMap[keyDayBefore] || customMap["template_1day"] || defaultMsgDayBeforeTemplate;
      let msgDayBefore = rawTemplate1Day
        .replace(/\{member_name\}/g, user.name)
        .replace(/\{school_name\}/g, school.name)
        .replace(/\{location\}/g, schoolAddress)
        .replace(/\{session_time\}/g, sessionTime);

      const waLink1Day = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(msgDayBefore)}`;

      reminders.push({
        id: keyDayBefore,
        rem_key: keyDayBefore,
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
        sent_at: sent1Day?.sent_at || null,
        is_customized: Boolean(customMap[keyDayBefore] || customMap["template_1day"])
      });

      // 2. "3 Hours Before" Reminder
      const key3Hours = `${user.id}_${school.id}_3hours`;
      const sent3Hours = remindersSent.find(r => Number(r.user_id) === Number(user.id) && Number(r.school_id) === Number(school.id) && r.reminder_type === "3_hours_before");

      let rawTemplate3Hours = customMap[key3Hours] || customMap["template_3hours"] || defaultMsg3HoursTemplate;
      let msg3Hours = rawTemplate3Hours
        .replace(/\{member_name\}/g, user.name)
        .replace(/\{school_name\}/g, school.name)
        .replace(/\{location\}/g, schoolAddress)
        .replace(/\{session_time\}/g, sessionTime);

      const waLink3Hours = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(msg3Hours)}`;

      reminders.push({
        id: key3Hours,
        rem_key: key3Hours,
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
        sent_at: sent3Hours?.sent_at || null,
        is_customized: Boolean(customMap[key3Hours] || customMap["template_3hours"])
      });
    }
  }

  res.json({
    reminders,
    total: reminders.length,
    template_1day: customMap["template_1day"] || defaultMsgDayBeforeTemplate,
    template_3hours: customMap["template_3hours"] || defaultMsg3HoursTemplate
  });
}));

app.put("/api/reminders/message", auth, admin, wrap(async (req, res) => {
  const { key, message } = req.body;
  if (!key || !message) {
    return res.status(400).json({ error: "Missing reminder key or message text." });
  }

  if (isPostgres) {
    await q("insert into reminder_templates(key, message, updated_at) values($1, $2, now()) on conflict (key) do update set message=$2, updated_at=now()",
      [key, message.trim()]);
  } else {
    localDb.reminder_templates = localDb.reminder_templates || {};
    localDb.reminder_templates[key] = message.trim();
    saveLocalDb();
  }

  res.json({ ok: true, key, message: message.trim() });
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

/* ---- AI WhatsApp Reminders Autonomous Background Dispatch Engine (Weekly Cycles) ---- */
async function runAutoRemindersDispatch() {
  try {
    const allUsers = (await q("select id,name,email,phone,whatsapp,is_admin from users where is_admin=false")).rows;
    const allSchools = (await q("select * from schools")).rows;
    const remindersSent = (await q("select * from reminders_sent")).rows;
    
    // Weekly cycle calculation: meeting days are weekly, reminders dispatched weekly
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    const weekNum = Math.ceil((((now - startOfYear) / 86400000) + startOfYear.getDay() + 1) / 7);
    const weekKey = `${now.getFullYear()}-W${weekNum}`;

    for (const user of allUsers) {
      const userPhone = (user.whatsapp || user.phone || "").trim();
      if (!userPhone) continue;
      const cleanPhone = userPhone.replace(/[^0-9]/g, "");
      if (!cleanPhone) continue;

      const userSchools = await getUserSchools(user, allSchools);
      if (!userSchools || !userSchools.length) continue;

      for (const school of userSchools) {
        for (const remType of ["1_day_before", "3_hours_before"]) {
          const alreadyDispatched = remindersSent.some(r =>
            Number(r.user_id) === Number(user.id) &&
            Number(r.school_id) === Number(school.id) &&
            r.reminder_type === remType &&
            (r.session_date === weekKey || r.session_date === todayStr)
          );

          if (!alreadyDispatched) {
            await q("insert into reminders_sent(user_id, school_id, reminder_type, session_date) values($1, $2, $3, $4)",
              [user.id, school.id, remType, weekKey]);
            console.log(`[AI Auto-Reminder] Dispatched weekly ${remType} reminder to ${user.name} (${userPhone}) for ${school.name}`);
          }
        }
      }
    }
  } catch (err) {
    console.error("[AI Auto-Reminder Background Error]:", err.message);
  }
}

setInterval(runAutoRemindersDispatch, 5 * 60 * 1000);
setTimeout(runAutoRemindersDispatch, 2000);

/* ---- Schools Management ---- */
app.post("/api/schools", auth, admin, wrap(async (req, res) => {
  const { name, center_id, contact_person, phone, email, address, session_time } = req.body;
  if (!name) return res.status(400).json({ error: "School name is required." });

  await q("insert into schools(name, center_id, contact_person, phone, email, address, session_time) values($1, $2, $3, $4, $5, $6, $7)",
    [name.trim(), center_id ? Number(center_id) : null, contact_person || "", phone || "", email || "", address || "", session_time || ""]);
  res.json({ ok: true });
}));

app.put("/api/schools/:id", auth, admin, wrap(async (req, res) => {
  const schoolId = Number(req.params.id);
  const { name, center_id, contact_person, phone, email, address, session_time } = req.body;
  if (!name) return res.status(400).json({ error: "School name is required." });

  const prevRes = await q("select * from schools where id=$1", [schoolId]);
  const prevSchool = prevRes.rows[0];

  if (center_id !== undefined) {
    await q("update schools set name=$1, center_id=$2, contact_person=$3, phone=$4, email=$5, address=$6, session_time=$7 where id=$8",
      [name.trim(), center_id ? Number(center_id) : null, contact_person || "", phone || "", email || "", address || "", session_time || "", schoolId]);
  } else {
    await q("update schools set name=$1, contact_person=$2, phone=$3, email=$4, address=$5, session_time=$6 where id=$7",
      [name.trim(), contact_person || "", phone || "", email || "", address || "", session_time || "", schoolId]);
  }

  if (prevSchool && prevSchool.name && prevSchool.name.trim().toLowerCase() !== name.trim().toLowerCase()) {
    await q("update reports set school=$1 where lower(trim(school))=$2", [name.trim(), prevSchool.name.trim().toLowerCase()]).catch(() => {});
  }

  res.json({ ok: true });
}));

app.delete("/api/schools/:id", auth, admin, wrap(async (req, res) => {
  const schoolId = Number(req.params.id);
  await q("delete from schools where id=$1", [schoolId]);
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

app.put("/api/users/:id/schools", auth, admin, wrap(async (req, res) => {
  const userId = Number(req.params.id);
  let schoolIds = Array.isArray(req.body.school_ids)
    ? req.body.school_ids.map(Number)
    : (req.body.school_id ? [Number(req.body.school_id)] : []);
  schoolIds = [...new Set(schoolIds.filter(Boolean))];

  await q("delete from user_schools where user_id=$1", [userId]);
  for (const sid of schoolIds) {
    await q("insert into user_schools(user_id, school_id) values($1, $2)", [userId, sid]);
  }
  res.json({ ok: true, school_ids: schoolIds });
}));

/* ---- Report Submission & Editing (With Academic Year Lockout Rule & Term Bounds) ---- */
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

  const year = b.year ? String(b.year).trim() : getCurrentAcademicYear();
  const academicSession = b.academic_session || "First Term";
  const classLevel = b.class_level || b.class || "";

  // Past Academic Years Lockout Rule:
  if (isPastAcademicYear(year) && !u.is_admin) {
    return res.status(403).json({ error: "Members cannot submit reports for past academic years. Only administrators can submit past year reports." });
  }

  // Academic Term Date Bounds:
  // Under Y/Y+1:
  // First Term: 01 September Y till 26 December Y
  // Second Term: 01 January Y+1 till 30 April Y+1
  // Third Term: 01 May Y+1 till 30 August Y+1
  const yearObj = parseAcademicYear(year);
  let termMin = `${yearObj.start}-09-01`;
  let termMax = `${yearObj.start}-12-26`;
  if (academicSession.toLowerCase().includes("second")) {
    termMin = `${yearObj.end}-01-01`;
    termMax = `${yearObj.end}-04-30`;
  } else if (academicSession.toLowerCase().includes("third")) {
    termMin = `${yearObj.end}-05-01`;
    termMax = `${yearObj.end}-08-30`;
  }

  if (b.date < termMin || b.date > termMax) {
    return res.status(400).json({ error: `Session date (${b.date}) must be within ${academicSession} dates (${termMin} to ${termMax}).` });
  }

  const photos = Array.isArray(b.photos) ? JSON.stringify(b.photos) : (typeof b.photos === "string" ? b.photos : "[]");

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

  // Past Academic Year Lockout Rule:
  // "ONCE A YEAR IS FINISHED THE DETAILS IN THAT YEAR WILL BECOME EDITABLE ONLY BY AN ADMIN WHEN THEY LOG IN TO REVIEW THE REPORTS"
  if (isPastAcademicYear(report.year) && !u.is_admin) {
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

  if (isPastAcademicYear(report.year) && !req.user.is_admin) {
    return res.status(403).json({ error: "Reports from past academic years cannot be deleted by members. Contact an administrator." });
  }

  await q("delete from reports where id=$1 and ($2 or member_id=$3)", [req.params.id, req.user.is_admin, req.user.id]);
  res.json({ ok: true });
}));

/* ---- Timeframe Master Export Endpoints (Word & Excel) ---- */
function filterReportsByTimeframe(reports, { timeframe, start_date, end_date, school, year }) {
  let list = [...reports];
  if (school && school !== "all") {
    list = list.filter(r => (r.school || "").trim().toLowerCase() === school.trim().toLowerCase());
  }
  if (year && !timeframe) {
    list = list.filter(r => String(r.year || "").trim() === String(year).trim());
  }
  if (timeframe === "2026/2027" || timeframe === "2026") {
    list = list.filter(r => {
      const parsed = parseAcademicYear(r.year);
      return parsed.str === "2026/2027" || Number(r.year) === 2026;
    });
  } else if (timeframe === "2026/2027_term1" || timeframe === "2026_term1") {
    list = list.filter(r => {
      const parsed = parseAcademicYear(r.year);
      const isTerm = r.academic_session === "First Term";
      const inDates = r.date ? (r.date >= "2026-09-01" && r.date <= "2026-12-26") : false;
      return (parsed.str === "2026/2027" || Number(r.year) === 2026) && (isTerm || inDates);
    });
  } else if (timeframe === "2026/2027_term2" || timeframe === "2026_term2") {
    list = list.filter(r => {
      const parsed = parseAcademicYear(r.year);
      const isTerm = r.academic_session === "Second Term";
      const inDates = r.date ? (r.date >= "2027-01-01" && r.date <= "2027-04-30") : false;
      return (parsed.str === "2026/2027" || Number(r.year) === 2026) && (isTerm || inDates);
    });
  } else if (timeframe === "2026/2027_term3" || timeframe === "2026_term3") {
    list = list.filter(r => {
      const parsed = parseAcademicYear(r.year);
      const isTerm = r.academic_session === "Third Term";
      const inDates = r.date ? (r.date >= "2027-05-01" && r.date <= "2027-08-30") : false;
      return (parsed.str === "2026/2027" || Number(r.year) === 2026) && (isTerm || inDates);
    });
  } else if (timeframe === "2025/2026" || timeframe === "2025") {
    list = list.filter(r => {
      const parsed = parseAcademicYear(r.year);
      return parsed.str === "2025/2026" || Number(r.year) === 2025;
    });
  } else if (timeframe === "2024/2025" || timeframe === "2024") {
    list = list.filter(r => {
      const parsed = parseAcademicYear(r.year);
      return parsed.str === "2024/2025" || Number(r.year) === 2024;
    });
  } else if (start_date || end_date) {
    if (start_date) list = list.filter(r => !r.date || r.date >= start_date);
    if (end_date) list = list.filter(r => !r.date || r.date <= end_date);
  }
  return list;
}

app.get("/api/reports/export/word", auth, admin, wrap(async (req, res) => {
  const { timeframe, start_date, end_date, school, year } = req.query;
  const allReports = (await q("select * from reports order by school asc, date desc, id desc")).rows;
  const users = (await q("select id, name, email, whatsapp, phone from users")).rows;
  const centers = (await q("select * from centers")).rows;

  const sorted = filterReportsByTimeframe(allReports, { timeframe, start_date, end_date, school, year });
  const cName = id => (centers.find(c => c.id === Number(id)) || {}).name || "General / Unassigned";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const schoolMap = {};
  sorted.forEach(r => {
    const sch = (r.school || "Unassigned").trim();
    const k = sch.toLowerCase();
    if (!schoolMap[k]) schoolMap[k] = { name: sch, centerId: r.center_id, sessions: 0, sumStudents: 0, ministers: new Set(), reports: [] };
    schoolMap[k].sessions += 1;
    schoolMap[k].sumStudents += Number(r.students) || 0;
    if (r.member_name) schoolMap[k].ministers.add(r.member_name);
    schoolMap[k].reports.push(r);
  });

  const schoolList = Object.values(schoolMap).sort((a, b) => a.name.localeCompare(b.name));
  const totalStudents = sorted.reduce((acc, r) => acc + (Number(r.students) || 0), 0);
  const distinctStudents = schoolList.reduce((acc, s) => acc + Math.round(s.sumStudents / s.sessions), 0);
  const uniqueMinisters = [...new Set(sorted.map(r => r.member_name).filter(Boolean))];

  let timeframeTitle = "All Time (Complete Historical Archive)";
  if (timeframe === "2026") timeframeTitle = "Full Academic Year 2026";
  else if (timeframe === "2026_term1") timeframeTitle = "First Term 2026 (01 Sep 2026 - 26 Dec 2026)";
  else if (timeframe === "2026_term2") timeframeTitle = "Second Term 2026 (01 Jan 2026 - 20 Apr 2026)";
  else if (timeframe === "2026_term3") timeframeTitle = "Third Term 2026 (25 Apr 2026 - 15 Aug 2026)";
  else if (timeframe === "2025") timeframeTitle = "Academic Year 2025";
  else if (start_date || end_date) timeframeTitle = `Custom Range: ${start_date || 'Start'} to ${end_date || 'Present'}`;

  const schoolSummaryRows = schoolList.map((s, idx) => `
    <tr>
      <td style="text-align:center;">${idx + 1}</td>
      <td><strong>${esc(s.name)}</strong></td>
      <td>${esc(cName(s.centerId))}</td>
      <td style="text-align:center;">${s.sessions}</td>
      <td style="text-align:right;">${s.sumStudents.toLocaleString()}</td>
      <td style="text-align:right;">${Math.round(s.sumStudents / s.sessions).toLocaleString()}</td>
      <td>${esc(Array.from(s.ministers).join(", ") || "General")}</td>
    </tr>`).join('');

  const detailedSectionsHtml = schoolList.map(s => {
    const sessionCards = s.reports.map(r => {
      const userObj = users.find(u => u.id === r.member_id) || {};
      const phoneStr = userObj.whatsapp || userObj.phone || "";
      const ministerContact = phoneStr ? `${esc(r.member_name || "Unknown")} (${esc(phoneStr)})` : esc(r.member_name || "Unknown");

      return `
        <div style="margin-bottom:14px; border:1px solid #cbd5e1; page-break-inside:avoid; background-color:#ffffff;">
          <div style="background-color:#1034A6; color:#ffffff; padding:7px 10px; font-weight:bold; font-size:10pt;">
            <span>Session #${r.id} &bull; ${esc(r.date || "No date")}</span>
            <span style="float:right; color:#fee2e2;">Class: ${esc(r.class_level || "General")} | ${esc(r.academic_session || "First Term")} ${r.year || 2026}</span>
          </div>
          <div style="padding:10px;">
            <table style="width:100%; border-collapse:collapse; margin-bottom:8px;">
              <tr>
                <td style="width:18%; font-weight:bold; color:#1034A6; font-size:9pt; padding:2px 0;">Reporting Minister:</td>
                <td style="font-size:9pt; padding:2px 0;">${ministerContact}</td>
                <td style="width:18%; font-weight:bold; color:#1034A6; font-size:9pt; padding:2px 0;">Students Present:</td>
                <td style="font-size:9pt; font-weight:bold; color:#E2252B; padding:2px 0;">${(Number(r.students) || 0).toLocaleString()} students</td>
              </tr>
              ${r.attendance ? `
              <tr>
                <td style="font-weight:bold; color:#1034A6; font-size:9pt; padding:2px 0;">Audience Notes:</td>
                <td colspan="3" style="font-size:9pt; padding:2px 0;">${esc(r.attendance)}</td>
              </tr>` : ''}
            </table>
            <div style="margin-top:6px; padding:8px 10px; background-color:#f8fafc; border-left:3px solid #1034A6;">
              <div style="font-weight:bold; color:#1034A6; font-size:9.5pt; margin-bottom:3px;">📖 Topic & Session Teaching:</div>
              <div style="font-size:9.5pt; line-height:1.45; color:#1e293b; white-space:pre-wrap;">${esc(r.details || "None reported")}</div>
            </div>
            ${r.remarks ? `
            <div style="margin-top:6px; padding:6px 10px; background-color:#eff6ff; border-left:3px solid #2563eb;">
              <div style="font-weight:bold; color:#1d4ed8; font-size:9pt; margin-bottom:2px;">✨ Breakthrough Highlights & Remarks:</div>
              <div style="font-size:9pt; color:#1e293b; white-space:pre-wrap;">${esc(r.remarks)}</div>
            </div>` : ''}
            ${r.challenges ? `
            <div style="margin-top:6px; padding:6px 10px; background-color:#fff1f2; border-left:3px solid #E2252B;">
              <div style="font-weight:bold; color:#be123c; font-size:9pt; margin-bottom:2px;">⚠️ Challenges & Prayer Points:</div>
              <div style="font-size:9pt; color:#1e293b; white-space:pre-wrap;">${esc(r.challenges)}</div>
            </div>` : ''}
          </div>
        </div>`;
    }).join('');

    return `
      <div style="margin-top:24px; margin-bottom:12px;">
        <div style="background-color:#0a1128; color:#ffffff; padding:10px 14px; font-size:12pt; font-weight:bold; border-left:5px solid #E2252B;">
          🏫 ${esc(s.name)} <span style="font-size:9.5pt; font-weight:normal; color:#cbd5e1; margin-left:12px;">(${cName(s.centerId)} &bull; ${s.sessions} sessions &bull; ${s.sumStudents.toLocaleString()} total students)</span>
        </div>
        <div style="padding-top:10px;">${sessionCards}</div>
      </div>`;
  }).join('');

  const wordHtml = `
    <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
    <head>
      <meta charset='utf-8'>
      <title>TEENETWORK - Comprehensive Outreach Report</title>
      <style>
        @page { size: 8.5in 11.0in; margin: 0.8in 0.8in 0.8in 0.8in; }
        body { font-family: 'Segoe UI', Calibri, Arial, sans-serif; color: #0f172a; line-height: 1.45; font-size: 10pt; }
        .brand-header { border-bottom: 3.5px solid #1034A6; padding-bottom: 12px; margin-bottom: 16px; }
        .brand-title { font-size: 19pt; font-weight: 900; color: #1034A6; margin: 0 0 2px 0; }
        .brand-subtitle { font-size: 12pt; font-weight: 800; color: #E2252B; margin: 0 0 4px 0; text-transform: uppercase; }
        .meta-table { width: 100%; border-collapse: collapse; margin: 14px 0 20px 0; background-color: #f8fafc; border: 1px solid #cbd5e1; }
        .meta-table td { padding: 6px 10px; font-size: 9pt; border: 1px solid #e2e8f0; }
        .meta-label { font-weight: bold; color: #1034A6; width: 24%; background-color: #f1f5f9; }
        .section-title { font-size: 12pt; font-weight: 800; color: #1034A6; border-bottom: 2px solid #cbd5e1; padding-bottom: 4px; margin: 22px 0 10px 0; text-transform: uppercase; }
        .kpi-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
        .kpi-table th { background-color: #1034A6; color: #ffffff; font-size: 8.5pt; font-weight: bold; text-transform: uppercase; padding: 8px 6px; text-align: center; border: 1px solid #0a1128; }
        .kpi-table td { background-color: #f8fafc; font-size: 13pt; font-weight: 900; color: #0f172a; padding: 10px 6px; text-align: center; border: 1px solid #cbd5e1; }
        .data-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
        .data-table th { background-color: #1034A6; color: #ffffff; font-size: 8.5pt; font-weight: bold; padding: 7px 8px; text-align: left; border: 1px solid #0a1128; }
        .data-table td { border: 1px solid #cbd5e1; padding: 7px 8px; font-size: 9pt; vertical-align: top; }
        .data-table tr:nth-child(even) td { background-color: #f8fafc; }
        .footer { margin-top: 36px; padding-top: 12px; border-top: 1px solid #cbd5e1; font-size: 8.5pt; color: #64748b; text-align: center; }
      </style>
    </head>
    <body>
      <div class="brand-header">
        <h1 class="brand-title">THE EXCELLENCE EVANGELICAL NETWORK (TEENETWORK)</h1>
        <div class="brand-subtitle">COMPREHENSIVE OUTREACH SESSIONS REPORT &bull; UNIFIED COMPENDIUM</div>
        <p style="font-size:9pt; color:#64748b; margin:0; font-style:italic;">"Raising Excellent Leaders for Christ across Schools and Colleges"</p>
      </div>

      <table class="meta-table">
        <tr>
          <td class="meta-label">Reporting Period:</td>
          <td><strong>${esc(timeframeTitle)}</strong></td>
          <td class="meta-label">Target Scope:</td>
          <td><strong>${esc(school && school !== 'all' ? school : 'All Schools')}</strong></td>
        </tr>
        <tr>
          <td class="meta-label">Date Generated:</td>
          <td>${new Date().toLocaleString()}</td>
          <td class="meta-label">Authorized Admin:</td>
          <td>${esc(req.user.name || 'Administrator')}</td>
        </tr>
      </table>

      <div class="section-title">1. Executive Summary & Impact KPIs</div>
      <table class="kpi-table">
        <thead>
          <tr>
            <th>Schools Reached</th>
            <th>Sessions Conducted</th>
            <th>Total Student Attendance</th>
            <th>Distinct Students Reached</th>
            <th>Active Ministers</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>${schoolList.length}</td>
            <td>${sorted.length}</td>
            <td style="color:#1034A6;">${totalStudents.toLocaleString()}</td>
            <td style="color:#E2252B;">${distinctStudents.toLocaleString()}</td>
            <td>${uniqueMinisters.length}</td>
          </tr>
        </tbody>
      </table>

      <div class="section-title">2. School-by-School Summary Table</div>
      <table class="data-table">
        <thead>
          <tr>
            <th style="width:5%; text-align:center;">#</th>
            <th style="width:25%;">School Name</th>
            <th style="width:16%;">Assigned Center</th>
            <th style="width:10%; text-align:center;">Sessions</th>
            <th style="width:14%; text-align:right;">Total Students</th>
            <th style="width:12%; text-align:right;">Avg / Session</th>
            <th style="width:18%;">Outreach Ministers</th>
          </tr>
        </thead>
        <tbody>${schoolSummaryRows}</tbody>
      </table>

      <div class="section-title">3. Detailed Session Reports</div>
      ${detailedSectionsHtml}

      <div class="footer">
        <p><strong>TEENETWORK Central Administrative Secretariat</strong> &bull; Official Outreach Ministry Archive</p>
      </div>
    </body>
    </html>`;

  res.setHeader("Content-Type", "application/msword; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="teenetwork-master-report-${timeframe || 'all'}-${new Date().toISOString().slice(0, 10)}.doc"`);
  res.send("\uFEFF" + wordHtml);
}));

app.get("/api/reports/export/excel", auth, admin, wrap(async (req, res) => {
  const { timeframe, start_date, end_date, school, year } = req.query;
  const allReports = (await q("select * from reports order by school asc, date desc, id desc")).rows;
  const users = (await q("select id, name, email, whatsapp, phone from users")).rows;
  const centers = (await q("select * from centers")).rows;

  const sorted = filterReportsByTimeframe(allReports, { timeframe, start_date, end_date, school, year });
  const cName = id => (centers.find(c => c.id === Number(id)) || {}).name || "General / Unassigned";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const schoolStats = {};
  sorted.forEach(r => {
    const sch = (r.school || "Unassigned").trim();
    const k = sch.toLowerCase();
    if (!schoolStats[k]) schoolStats[k] = { name: sch, sessions: 0, sumStudents: 0 };
    schoolStats[k].sessions += 1;
    schoolStats[k].sumStudents += Number(r.students) || 0;
  });
  const schoolList = Object.values(schoolStats);
  const totalStudents = sorted.reduce((acc, r) => acc + (Number(r.students) || 0), 0);
  const distinctStudents = schoolList.reduce((acc, s) => acc + Math.round(s.sumStudents / s.sessions), 0);
  const uniqueMinisters = [...new Set(sorted.map(r => r.member_name).filter(Boolean))];

  let timeframeTitle = "All Time (Complete Historical Archive)";
  if (timeframe === "2026") timeframeTitle = "Full Academic Year 2026";
  else if (timeframe === "2026_term1") timeframeTitle = "First Term 2026 (01 Sep 2026 - 26 Dec 2026)";
  else if (timeframe === "2026_term2") timeframeTitle = "Second Term 2026 (01 Jan 2026 - 20 Apr 2026)";
  else if (timeframe === "2026_term3") timeframeTitle = "Third Term 2026 (25 Apr 2026 - 15 Aug 2026)";
  else if (timeframe === "2025") timeframeTitle = "Academic Year 2025";
  else if (start_date || end_date) timeframeTitle = `Custom Range: ${start_date || 'Start'} to ${end_date || 'Present'}`;

  const excelRows = sorted.map((r, idx) => {
    const userObj = users.find(u => u.id === r.member_id) || {};
    const phoneStr = userObj.whatsapp || userObj.phone || "";
    const bg = idx % 2 === 0 ? "#ffffff" : "#f8fafc";

    return `
      <tr style="background-color:${bg};">
        <td style="text-align:center;">${r.id}</td>
        <td><strong>${esc(r.school)}</strong></td>
        <td>${esc(cName(r.center_id))}</td>
        <td style="text-align:center;">${r.year || 2026}</td>
        <td style="text-align:center;">${esc(r.academic_session || "First Term")}</td>
        <td style="text-align:center;">${esc(r.class_level || "Not specified")}</td>
        <td class="date">${esc(r.date || "")}</td>
        <td class="num">${Number(r.students) || 0}</td>
        <td>${esc(r.member_name || "Unknown")}</td>
        <td>${esc(phoneStr)}</td>
        <td>${esc(r.attendance || "")}</td>
        <td>${esc(r.details || "")}</td>
        <td>${esc(r.remarks || "")}</td>
        <td>${esc(r.challenges || "")}</td>
      </tr>`;
  }).join('');

  const excelHtml = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: Calibri, Arial, sans-serif; }
        .title-hdr { background-color: #1034A6; color: #ffffff; font-size: 15pt; font-weight: bold; text-align: left; padding: 10px; }
        .meta-hdr { background-color: #f1f5f9; color: #334155; font-size: 10pt; font-weight: bold; padding: 6px; }
        .kpi-hdr { background-color: #e0e7ff; color: #1034A6; font-weight: bold; text-align: center; border: 1px solid #cbd5e1; }
        .kpi-val { background-color: #f8fafc; font-size: 12pt; font-weight: bold; text-align: center; border: 1px solid #cbd5e1; }
        th { background-color: #1034A6; color: #ffffff; font-weight: bold; border: 1px solid #0a1128; padding: 7px 8px; text-align: left; font-size: 10pt; }
        td { border: 1px solid #cbd5e1; padding: 6px 8px; font-size: 9.5pt; vertical-align: top; }
        .num { mso-number-format: "\\#\\,\\#\\#0"; text-align: right; font-weight: bold; }
        .date { mso-number-format: "yyyy-mm-dd"; text-align: center; }
      </style>
    </head>
    <body>
      <table>
        <tr><td colspan="14" class="title-hdr">THE EXCELLENCE EVANGELICAL NETWORK (TEENETWORK) - OUTREACH REPORTS MASTER DATABASE</td></tr>
        <tr><td colspan="14" class="meta-hdr">Timeframe: ${esc(timeframeTitle)} &bull; Scope: ${esc(school && school !== 'all' ? school : 'All Schools')} &bull; Exported On: ${new Date().toLocaleString()}</td></tr>
        <tr><td colspan="14">&nbsp;</td></tr>
        <tr>
          <td class="kpi-hdr" colspan="2">Total Reports</td>
          <td class="kpi-hdr" colspan="2">Schools Covered</td>
          <td class="kpi-hdr" colspan="3">Total Student Attendance</td>
          <td class="kpi-hdr" colspan="3">Distinct Students Reached (Avg)</td>
          <td class="kpi-hdr" colspan="4">Active Outreach Ministers</td>
        </tr>
        <tr>
          <td class="kpi-val" colspan="2">${sorted.length}</td>
          <td class="kpi-val" colspan="2">${schoolList.length}</td>
          <td class="kpi-val" colspan="3" style="color:#1034A6;">${totalStudents.toLocaleString()}</td>
          <td class="kpi-val" colspan="3" style="color:#E2252B;">${distinctStudents.toLocaleString()}</td>
          <td class="kpi-val" colspan="4">${uniqueMinisters.length}</td>
        </tr>
        <tr><td colspan="14">&nbsp;</td></tr>
        <thead>
          <tr>
            <th style="width:70px; text-align:center;">Report ID</th>
            <th style="width:220px;">School Name</th>
            <th style="width:160px;">Assigned Center</th>
            <th style="width:80px; text-align:center;">Year</th>
            <th style="width:120px; text-align:center;">Academic Session</th>
            <th style="width:110px; text-align:center;">Class Level</th>
            <th style="width:100px; text-align:center;">Session Date</th>
            <th style="width:100px; text-align:right;">Students Count</th>
            <th style="width:180px;">Reporting Minister</th>
            <th style="width:140px;">Minister WhatsApp</th>
            <th style="width:200px;">Key Attendees / Audience</th>
            <th style="width:340px;">Topic & Session Details</th>
            <th style="width:260px;">Remarks / Breakthroughs</th>
            <th style="width:260px;">Challenges Faced</th>
          </tr>
        </thead>
        <tbody>${excelRows}</tbody>
      </table>
    </body>
    </html>`;

  res.setHeader("Content-Type", "application/vnd.ms-excel; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="teenetwork-master-report-${timeframe || 'all'}-${new Date().toISOString().slice(0, 10)}.xls"`);
  res.send("\uFEFF" + excelHtml);
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
