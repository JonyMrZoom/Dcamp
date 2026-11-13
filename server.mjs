import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pg from "pg";
import ExcelJS from "exceljs";
import multer from "multer";
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, BorderStyle, AlignmentType, HeadingLevel } from "docx";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const app = express();
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
  max: 8,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});
const PORT = Number(process.env.PORT || 3000);
const SESSION_COOKIE = "dr_admin";
const SESSION_HOURS = 10;
const MAX_CERT_BYTES = 5 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" }, contentSecurityPolicy: false }));
app.use(express.json({ limit: "40mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: "draft-8", legacyHeaders: false }));

const scryptHash = (password, salt = randomBytes(16).toString("hex")) =>
  `${salt}:${scryptSync(String(password), salt, 64).toString("hex")}`;
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hex] = stored.split(":");
  const actual = scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hex, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
const sha256 = value => createHash("sha256").update(value).digest("hex");
function cookieValue(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}
function setSessionCookie(res, token) {
  const attrs = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${SESSION_HOURS * 3600}`];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
}
const text = value => String(value ?? "").trim();
const asArray = value => Array.isArray(value) ? value.map(text).filter(Boolean) : String(value || "").split(/[;\n]/).map(text).filter(Boolean);
const phoneDigits = value => String(value || "").replace(/\D/g, "");
const makeCode = () => "DR-" + new Date().toISOString().slice(0, 10).replaceAll("-", "") + "-" + randomBytes(3).toString("hex").toUpperCase();
const ageAt = (birthValue, startValue) => {
  const b = new Date(birthValue + "T12:00:00Z"), s = new Date(startValue + "T12:00:00Z");
  let age = s.getUTCFullYear() - b.getUTCFullYear();
  if (s.getUTCMonth() < b.getUTCMonth() || (s.getUTCMonth() === b.getUTCMonth() && s.getUTCDate() < b.getUTCDate())) age--;
  return age;
};
const isoDate = value => {
  if (!value) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const ru = raw.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (ru) return `${ru[3]}-${ru[2].padStart(2,"0")}-${ru[1].padStart(2,"0")}`;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
};
const formatDate = value => {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "long", year: "numeric", timeZone: "Europe/Moscow" }).format(new Date(value));
};
const rub = value => new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 }).format(Number(value || 0));
const publicShiftSql = `
  SELECT s.*,
    COALESCE((SELECT COUNT(*) FROM children c JOIN bookings b ON b.id=c.booking_id WHERE b.shift_id=s.id AND b.status <> 'cancelled'),0)::int AS taken
  FROM shifts s
`;
const shiftToPublic = row => ({
  id: row.id, slug: row.slug, title: row.title,
  start: String(row.start_date).slice(0, 10), end: String(row.end_date).slice(0, 10),
  price: Number(row.price), capacity: Number(row.capacity), taken: Number(row.taken),
  available: Math.max(0, Number(row.capacity) - Number(row.taken)),
  ages: `${row.age_min}–${row.age_max}`, ageMin: row.age_min, ageMax: row.age_max,
  place: row.place, cover: row.cover_url, short: row.short_description,
  description: row.description, program: row.program, included: row.included,
  styles: row.styles, coaches: row.coaches, groups: row.groups,
  transferInfo: row.transfer_info, schedule: row.schedule,
  open: row.open_for_booking, published: row.published
});
async function migrate() {
  const sql = await readFile(join(ROOT, "server", "schema.sql"), "utf8");
  await pool.query(sql);
  const email = text(process.env.ADMIN_EMAIL).toLowerCase();
  const password = text(process.env.ADMIN_PASSWORD);
  if (!email || !password || password === "change-this-before-launch" || password.length < 12) throw new Error("Set ADMIN_EMAIL and an ADMIN_PASSWORD with at least 12 characters before starting the application");
  if (email && password && password !== "change-this-before-launch") {
    const hash = scryptHash(password);
    await pool.query(
      `INSERT INTO admins(email,password_hash,display_name,role,active) VALUES($1,$2,'Владелец','owner',TRUE)
       ON CONFLICT(email) DO NOTHING`,
      [email, hash]
    );
  }
}

async function requireAdmin(req, res, next) {
  try {
    const token = cookieValue(req, SESSION_COOKIE);
    if (!token) return res.status(401).json({ ok: false, error: "Нужен вход в кабинет" });
    const result = await pool.query(
      `SELECT a.id,a.email,a.display_name,a.role
       FROM admin_sessions s JOIN admins a ON a.id=s.admin_id
       WHERE s.token_hash=$1 AND s.expires_at>NOW() AND a.active=TRUE`,
      [sha256(token)]
    );
    if (!result.rowCount) { clearSessionCookie(res); return res.status(401).json({ ok: false, error: "Сессия истекла. Войдите снова." }); }
    req.admin = result.rows[0];
    next();
  } catch (error) { next(error); }
}
function audit(adminId, action, type, id, details = {}) {
  return pool.query(
    "INSERT INTO audit_log(admin_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5)",
    [adminId, action, type, id ? String(id) : null, JSON.stringify(details)]
  );
}
async function notifyTelegram(message) {
  const token = process.env.TG_BOT_TOKEN, chat = process.env.TG_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: message, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(7000)
    });
  } catch (error) { console.error("Telegram notification failed:", error.message); }
}

app.get("/healthz", async (_req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true, service: "delo-ritma", database: "connected" }); }
  catch { res.status(503).json({ ok: false, database: "unavailable" }); }
});

/* Public API — no external spreadsheet or Apps Script */
app.get("/api/public/shifts", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(publicShiftSql + " WHERE s.published=TRUE AND s.end_date >= CURRENT_DATE ORDER BY s.start_date");
    res.json({ ok: true, shifts: rows.map(shiftToPublic) });
  } catch (error) { next(error); }
});

app.post("/api/public/bookings", rateLimit({ windowMs: 10 * 60_000, limit: 8, standardHeaders: "draft-8", legacyHeaders: false }), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const parentName = text(req.body.parentName), phone = phoneDigits(req.body.phone);
    const childrenIn = Array.isArray(req.body.children) ? req.body.children : [];
    if (parentName.length < 2) return res.status(400).json({ ok: false, error: "Укажите имя родителя" });
    if (phone.length < 10 || phone.length > 15) return res.status(400).json({ ok: false, error: "Проверьте номер телефона" });
    if (req.body.consent !== true) return res.status(400).json({ ok: false, error: "Нужно согласие на обработку персональных данных" });
    if (!childrenIn.length || childrenIn.length > 5) return res.status(400).json({ ok: false, error: "В одной заявке можно записать от одного до пяти детей" });
    await client.query("BEGIN");
    const shiftResult = await client.query("SELECT * FROM shifts WHERE id=$1 AND published=TRUE FOR UPDATE", [req.body.shiftId]);
    if (!shiftResult.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ ok: false, error: "Смена не найдена" }); }
    const shift = shiftResult.rows[0];
    if (!shift.open_for_booking) { await client.query("ROLLBACK"); return res.status(409).json({ ok: false, error: "Запись на эту смену закрыта" }); }
    if (new Date(shift.start_date) < new Date(new Date().toISOString().slice(0,10))) { await client.query("ROLLBACK"); return res.status(409).json({ ok: false, error: "Смена уже началась" }); }
    const taken = await client.query(
      "SELECT COUNT(*)::int AS n FROM children c JOIN bookings b ON b.id=c.booking_id WHERE b.shift_id=$1 AND b.status <> 'cancelled'",
      [shift.id]
    );
    if (Number(taken.rows[0].n) + childrenIn.length > Number(shift.capacity)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok: false, error: `Свободно мест: ${Math.max(0, Number(shift.capacity)-Number(taken.rows[0].n))}. Измените количество детей или напишите администратору.` });
    }
    const normalized = [];
    for (const child of childrenIn) {
      const firstName = text(child.firstName), lastName = text(child.lastName), birthDate = isoDate(child.birthDate);
      if (firstName.length < 2 || lastName.length < 2 || !birthDate) throw Object.assign(new Error("Заполните имя, фамилию и дату рождения каждого ребёнка"), { status: 400 });
      const age = ageAt(birthDate, isoDate(shift.start_date));
      if (age < Number(shift.age_min) || age > Number(shift.age_max)) throw Object.assign(new Error(`${firstName}: возраст на начало смены должен быть от ${shift.age_min} до ${shift.age_max} лет`), { status: 400 });
      const duplicate = await client.query(
        `SELECT 1 FROM children c JOIN bookings b ON b.id=c.booking_id
         WHERE b.shift_id=$1 AND b.status <> 'cancelled' AND LOWER(c.first_name)=LOWER($2)
         AND LOWER(c.last_name)=LOWER($3) AND c.birth_date=$4 LIMIT 1`,
        [shift.id, firstName, lastName, birthDate]
      );
      if (duplicate.rowCount) throw Object.assign(new Error(`${firstName} ${lastName} уже записан(а) на эту смену`), { status: 409 });
      normalized.push({ ...child, firstName, lastName, birthDate, age });
    }
    const bookingCode = makeCode();
    const booking = await client.query(
      `INSERT INTO bookings(code,shift_id,parent_name,phone,email,transfer_requested,transfer_note,comment,status,consent_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'new',NOW()) RETURNING id,code,status`,
      [bookingCode, shift.id, parentName, phone, text(req.body.email) || null,
       Boolean(req.body.transferRequested), text(req.body.transferNote), text(req.body.comment)]
    );
    const createdChildren = [];
    for (const child of normalized) {
      const certificate = child.certificate;
      let certStatus = child.certificateLater ? "send_later" : "not_provided";
      if (certificate?.data) {
        const match = String(certificate.data).match(/^data:(image\/(?:jpeg|png)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/);
        if (!match) throw Object.assign(new Error("Файл свидетельства должен быть JPG, PNG или PDF"), { status: 400 });
        const buffer = Buffer.from(match[2], "base64");
        if (buffer.length > MAX_CERT_BYTES) throw Object.assign(new Error("Файл свидетельства больше 5 МБ"), { status: 400 });
        certStatus = "uploaded";
        const childRow = await client.query(
          `INSERT INTO children(booking_id,first_name,last_name,birth_date,age_at_shift,coach,dance_style,allergies,restrictions,certificate_status)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,first_name,last_name,age_at_shift`,
          [booking.rows[0].id, child.firstName, child.lastName, child.birthDate, child.age, text(child.coach), text(child.style), text(child.allergies), text(child.restrictions), certStatus]
        );
        await client.query(
          "INSERT INTO child_documents(child_id,file_name,mime_type,file_data,size_bytes) VALUES($1,$2,$3,$4,$5)",
          [childRow.rows[0].id, text(certificate.name) || "certificate", match[1], buffer, buffer.length]
        );
        createdChildren.push(childRow.rows[0]);
      } else {
        const childRow = await client.query(
          `INSERT INTO children(booking_id,first_name,last_name,birth_date,age_at_shift,coach,dance_style,allergies,restrictions,certificate_status)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,first_name,last_name,age_at_shift`,
          [booking.rows[0].id, child.firstName, child.lastName, child.birthDate, child.age, text(child.coach), text(child.style), text(child.allergies), text(child.restrictions), certStatus]
        );
        createdChildren.push(childRow.rows[0]);
      }
    }
    await client.query("COMMIT");
    await notifyTelegram(
      `🆕 Заявка ${bookingCode}\n${shift.title} · ${formatDate(shift.start_date)} — ${formatDate(shift.end_date)}\n${createdChildren.map(c => `${c.first_name} ${c.last_name}, ${c.age_at_shift} лет`).join("\n")}\nРодитель: ${parentName} · ${phone}\nТрансфер: ${req.body.transferRequested ? "да" : "нет"}\nСумма: ${rub(shift.price * createdChildren.length)}`
    );
    res.status(201).json({ ok: true, booking: { id: booking.rows[0].id, code: bookingCode, status: "new" }, shift: { title: shift.title, price: Number(shift.price) }, children: createdChildren });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally { client.release(); }
});

app.post("/api/public/waitlist", rateLimit({ windowMs: 10 * 60_000, limit: 6, standardHeaders: "draft-8", legacyHeaders: false }), async (req, res, next) => {
  try {
    const shiftId = text(req.body.shiftId), parentName = text(req.body.parentName), phone = phoneDigits(req.body.phone);
    const childName = text(req.body.childName), childAge = Number(req.body.childAge);
    if (phone.length < 10 || phone.length > 15 || parentName.length < 2 || childName.length < 2) return res.status(400).json({ ok: false, error: "Проверьте контактные данные" });
    if (req.body.consent !== true) return res.status(400).json({ ok: false, error: "Нужно согласие на обработку данных" });
    const shift = await pool.query("SELECT * FROM shifts WHERE id=$1 AND published=TRUE", [shiftId]);
    if (!shift.rowCount) return res.status(404).json({ ok: false, error: "Смена не найдена" });
    if (childAge < shift.rows[0].age_min || childAge > shift.rows[0].age_max) return res.status(400).json({ ok: false, error: "Возраст не подходит для этой смены" });
    const result = await pool.query(
      `INSERT INTO waitlist(shift_id,parent_name,phone,child_name,child_age,comment,consent_at)
       VALUES($1,$2,$3,$4,$5,$6,NOW()) RETURNING id`,
      [shiftId, parentName, phone, childName, childAge, text(req.body.comment)]
    );
    await notifyTelegram(`⏳ Лист ожидания\n${shift.rows[0].title}\n${childName}, ${childAge} лет\n${parentName} · ${phone}`);
    res.status(201).json({ ok: true, id: result.rows[0].id });
  } catch (error) { next(error); }
});

/* Admin authentication — signed, httpOnly cookie with server-side session revocation */
app.post("/api/admin/login", rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: "draft-8", legacyHeaders: false }), async (req, res, next) => {
  try {
    const email = text(req.body.email).toLowerCase(), password = String(req.body.password || "");
    const found = await pool.query("SELECT * FROM admins WHERE email=$1 AND active=TRUE", [email]);
    if (!found.rowCount || !verifyPassword(password, found.rows[0].password_hash)) return res.status(401).json({ ok: false, error: "Неверная почта или пароль" });
    const token = randomBytes(32).toString("base64url");
    await pool.query("INSERT INTO admin_sessions(token_hash,admin_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '10 hours')", [sha256(token), found.rows[0].id]);
    setSessionCookie(res, token);
    res.json({ ok: true, admin: { email, name: found.rows[0].display_name, role: found.rows[0].role } });
  } catch (error) { next(error); }
});
app.post("/api/admin/logout", requireAdmin, async (req, res, next) => {
  try { const token = cookieValue(req, SESSION_COOKIE); await pool.query("DELETE FROM admin_sessions WHERE token_hash=$1", [sha256(token)]); clearSessionCookie(res); res.json({ ok: true }); }
  catch (error) { next(error); }
});
app.get("/api/admin/me", requireAdmin, (req, res) => res.json({ ok: true, admin: req.admin }));

app.get("/api/admin/dashboard", requireAdmin, async (_req, res, next) => {
  try {
    const [shifts, bookings, participants, transfers, revenue] = await Promise.all([
      pool.query("SELECT COUNT(*)::int n FROM shifts WHERE published=TRUE AND end_date>=CURRENT_DATE"),
      pool.query("SELECT COUNT(*)::int n FROM bookings WHERE status<>'cancelled'"),
      pool.query("SELECT COUNT(*)::int n FROM children c JOIN bookings b ON b.id=c.booking_id WHERE b.status<>'cancelled'"),
      pool.query("SELECT COUNT(*)::int n FROM bookings WHERE status<>'cancelled' AND transfer_requested=TRUE"),
      pool.query("SELECT COALESCE(SUM(s.price * (SELECT COUNT(*) FROM children c WHERE c.booking_id=b.id)),0)::bigint n FROM bookings b JOIN shifts s ON s.id=b.shift_id WHERE b.status IN ('confirmed','paid')")
    ]);
    res.json({ ok: true, stats: { activeShifts: shifts.rows[0].n, bookings: bookings.rows[0].n, participants: participants.rows[0].n, transfers: transfers.rows[0].n, confirmedRevenue: Number(revenue.rows[0].n) } });
  } catch (error) { next(error); }
});

app.get("/api/admin/shifts", requireAdmin, async (_req, res, next) => {
  try {
    const { rows } = await pool.query(publicShiftSql + " ORDER BY s.start_date DESC");
    res.json({ ok: true, shifts: rows.map(shiftToPublic) });
  } catch (error) { next(error); }
});
const shiftInput = body => ({
  slug: text(body.slug) || text(body.title).toLowerCase().replace(/[^a-zа-яё0-9]+/gi, "-").replace(/^-|-$/g, "") + "-" + (text(body.startDate) || new Date().toISOString().slice(0,10)),
  title: text(body.title), startDate: isoDate(body.startDate), endDate: isoDate(body.endDate || body.startDate),
  price: Math.max(0, Number(body.price) || 0), capacity: Math.max(1, Number(body.capacity) || 40),
  ageMin: Math.max(1, Number(body.ageMin) || 7), ageMax: Math.max(1, Number(body.ageMax) || 16),
  place: text(body.place) || "Тюмень", coverUrl: text(body.coverUrl),
  shortDescription: text(body.shortDescription), description: text(body.description),
  program: asArray(body.program), included: asArray(body.included), styles: asArray(body.styles),
  coaches: asArray(body.coaches), groups: asArray(body.groups), transferInfo: text(body.transferInfo),
  schedule: asArray(body.schedule), openForBooking: body.openForBooking !== false,
  published: body.published !== false
});
const SHIFT_COLUMNS = "slug,title,start_date,end_date,price,capacity,age_min,age_max,place,cover_url,short_description,description,program,included,styles,coaches,groups,transfer_info,schedule,open_for_booking,published";
const shiftValues = s => [s.slug,s.title,s.startDate,s.endDate,s.price,s.capacity,s.ageMin,s.ageMax,s.place,s.coverUrl || null,s.shortDescription,s.description,s.program,s.included,s.styles,s.coaches,s.groups,s.transferInfo,s.schedule,s.openForBooking,s.published];
app.post("/api/admin/shifts", requireAdmin, async (req, res, next) => {
  try {
    const s = shiftInput(req.body);
    if (!s.title || !s.startDate || !s.endDate || s.endDate < s.startDate || s.ageMax < s.ageMin) return res.status(400).json({ ok: false, error: "Проверьте название, даты и возраст" });
    const placeholders = shiftValues(s).map((_,i)=>"$"+(i+1)).join(",");
    const { rows } = await pool.query(`INSERT INTO shifts(${SHIFT_COLUMNS}) VALUES(${placeholders}) RETURNING id,slug`, shiftValues(s));
    await audit(req.admin.id,"shift.create","shift",rows[0].id,{title:s.title});
    res.status(201).json({ ok: true, shift: rows[0] });
  } catch (error) { next(error); }
});
app.patch("/api/admin/shifts/:id", requireAdmin, async (req, res, next) => {
  try {
    const s = shiftInput(req.body);
    if (!s.title || !s.startDate || !s.endDate || s.endDate < s.startDate || s.ageMax < s.ageMin) return res.status(400).json({ ok: false, error: "Проверьте название, даты и возраст" });
    const values = [...shiftValues(s), req.params.id];
    const set = SHIFT_COLUMNS.split(",").map((col,i)=>col+"=$"+(i+1)).join(",");
    const { rows } = await pool.query(`UPDATE shifts SET ${set},updated_at=NOW() WHERE id=$${values.length} RETURNING id,slug`,values);
    if (!rows.length) return res.status(404).json({ ok: false, error: "Смена не найдена" });
    await audit(req.admin.id,"shift.update","shift",req.params.id,{title:s.title});
    res.json({ ok: true, shift: rows[0] });
  } catch (error) { next(error); }
});
app.delete("/api/admin/shifts/:id", requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(
      `DELETE FROM shifts s WHERE s.id=$1 AND NOT EXISTS(SELECT 1 FROM bookings b WHERE b.shift_id=s.id) RETURNING id`,
      [req.params.id]
    );
    if (!result.rowCount) return res.status(409).json({ ok: false, error: "Смену нельзя удалить: либо она не найдена, либо на неё уже есть заявки. Снимите публикацию." });
    await audit(req.admin.id,"shift.delete","shift",req.params.id);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

const BOOKING_LIST_SQL = `
 SELECT b.id,b.code,b.parent_name,b.phone,b.email,b.transfer_requested,b.transfer_note,b.comment,b.status,b.created_at,
   s.id shift_id,s.title shift_title,s.start_date,s.end_date,s.price,
   COALESCE(json_agg(json_build_object(
     'id',c.id,'firstName',c.first_name,'lastName',c.last_name,'birthDate',c.birth_date,
     'age',c.age_at_shift,'coach',c.coach,'style',c.dance_style,'allergies',c.allergies,
     'restrictions',c.restrictions,'certificateStatus',c.certificate_status,'certificateLegacyUrl',c.certificate_legacy_url,'documentId',d.id
   )) FILTER(WHERE c.id IS NOT NULL),'[]'::json) children
 FROM bookings b JOIN shifts s ON s.id=b.shift_id LEFT JOIN children c ON c.booking_id=b.id
 LEFT JOIN child_documents d ON d.child_id=c.id
`;
app.get("/api/admin/bookings", requireAdmin, async (req, res, next) => {
  try {
    const where = [], args = [];
    if (req.query.shiftId) { args.push(req.query.shiftId); where.push(`b.shift_id=$${args.length}`); }
    if (req.query.status && req.query.status !== "all") { args.push(req.query.status); where.push(`b.status=$${args.length}`); }
    if (req.query.q) {
      args.push("%"+text(req.query.q).replace(/[%_]/g,"\\$&")+"%");
      where.push(`(b.code ILIKE $${args.length} OR b.parent_name ILIKE $${args.length} OR b.phone ILIKE $${args.length} OR EXISTS(SELECT 1 FROM children cx WHERE cx.booking_id=b.id AND (cx.first_name ILIKE $${args.length} OR cx.last_name ILIKE $${args.length})))`);
    }
    const sql = BOOKING_LIST_SQL + (where.length ? " WHERE "+where.join(" AND ") : "") + " GROUP BY b.id,s.id ORDER BY b.created_at DESC LIMIT 1000";
    const { rows } = await pool.query(sql,args);
    res.json({ ok: true, bookings: rows });
  } catch (error) { next(error); }
});
app.patch("/api/admin/bookings/:id/status", requireAdmin, async (req, res, next) => {
  try {
    const status = text(req.body.status);
    if (!["new","confirmed","paid","cancelled"].includes(status)) return res.status(400).json({ ok: false, error: "Неизвестный статус заявки" });
    const { rows } = await pool.query("UPDATE bookings SET status=$1,updated_at=NOW() WHERE id=$2 RETURNING code,status", [status,req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: "Заявка не найдена" });
    await audit(req.admin.id,"booking.status","booking",req.params.id,{status});
    res.json({ ok: true, booking: rows[0] });
  } catch (error) { next(error); }
});
app.get("/api/admin/documents/:id", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT file_name,mime_type,file_data FROM child_documents WHERE id=$1",[req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: "Документ не найден" });
    res.setHeader("Content-Type",rows[0].mime_type);
    res.setHeader("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(rows[0].file_name)}`);
    res.send(rows[0].file_data);
  } catch (error) { next(error); }
});

/* Migration utility: upload Google Sheets workbook exported as .xlsx */
const legacyUpload = upload.single("workbook");
app.post("/api/admin/import/legacy-xlsx", requireAdmin, legacyUpload, async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "Выберите Excel-файл Google Таблицы" });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const shiftsSheet = workbook.getWorksheet("Смены");
    const appsSheet = workbook.getWorksheet("Заявки");
    if (!shiftsSheet) return res.status(400).json({ ok: false, error: "В файле нет листа «Смены»" });
    const cell = (row,n) => {
      const v = row.getCell(n).value;
      if (v && typeof v === "object" && "text" in v) return v.text;
      if (v && typeof v === "object" && "result" in v) return v.result;
      return v ?? "";
    };
    await client.query("BEGIN");
    let shiftsImported=0, bookingsImported=0, duplicates=0, skipped=0;
    const ids = new Map();
    for (let n=2;n<=shiftsSheet.rowCount;n++) {
      const r=shiftsSheet.getRow(n), slug=text(cell(r,1)), title=text(cell(r,2));
      if (!slug || !title) continue;
      const startDate=isoDate(cell(r,3)), endDate=isoDate(cell(r,4)) || startDate;
      if (!startDate || endDate<startDate) { skipped++; continue; }
      const s={
        slug,title,startDate,endDate,price:Number(cell(r,6))||0,capacity:Number(cell(r,5))||40,
        ageMin:Number(String(cell(r,7)).match(/\d+/)?.[0])||7,ageMax:Number(String(cell(r,7)).match(/\d+\D+(\d+)/)?.[1])||16,
        place:text(cell(r,8))||"Тюмень",coverUrl:text(cell(r,17)),shortDescription:text(cell(r,11)),
        description:text(cell(r,12)),program:asArray(cell(r,13)),included:asArray(cell(r,14)),
        styles:asArray(cell(r,9)),coaches:asArray(cell(r,10)),groups:asArray(cell(r,27)),
        transferInfo:text(cell(r,25)),schedule:asArray(cell(r,22)),
        openForBooking:!/^нет$/i.test(text(cell(r,16))),published:true
      };
      const vals=shiftValues(s);
      const placeholders=vals.map((_,i)=>"$"+(i+1)).join(",");
      const columns=SHIFT_COLUMNS.split(",");
      const set=columns.slice(1).map((col,i)=>col+"=EXCLUDED."+col).join(",");
      const saved=await client.query(
        `INSERT INTO shifts(${SHIFT_COLUMNS}) VALUES(${placeholders}) ON CONFLICT(slug) DO UPDATE SET ${set},updated_at=NOW() RETURNING id,slug`,vals
      );
      ids.set(slug,saved.rows[0].id); shiftsImported++;
    }
    if (appsSheet) {
      for (let n=2;n<=appsSheet.rowCount;n++) {
        const r=appsSheet.getRow(n), legacyCode=text(cell(r,1)), slug=text(cell(r,3));
        if (!legacyCode || !slug) continue;
        let shiftId=ids.get(slug);
        if (!shiftId) {
          const existing=await client.query("SELECT id FROM shifts WHERE slug=$1",[slug]);
          shiftId=existing.rows[0]?.id;
        }
        if (!shiftId) { skipped++; continue; }
        const lastName=text(cell(r,5)), firstName=text(cell(r,6)), birthDate=isoDate(cell(r,7)), phone=phoneDigits(cell(r,9));
        if (!lastName || !firstName || !birthDate || phone.length<10) { skipped++; continue; }
        const exists=await client.query("SELECT id FROM bookings WHERE legacy_code=$1",[legacyCode]);
        if (exists.rowCount) { duplicates++; continue; }
        const shift=await client.query("SELECT start_date FROM shifts WHERE id=$1",[shiftId]);
        const age=Number(cell(r,8)) || ageAt(birthDate,isoDate(shift.rows[0].start_date));
        const oldStatus=text(cell(r,18));
        const status=/оплачен/i.test(oldStatus)?"paid":/подтвержд/i.test(oldStatus)?"confirmed":/отмен/i.test(oldStatus)?"cancelled":"new";
        const transfer=/^да|yes|true/i.test(text(cell(r,15)));
        const saved=await client.query(
          `INSERT INTO bookings(code,legacy_code,shift_id,parent_name,phone,transfer_requested,comment,status,consent_at,source)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'legacy_import') RETURNING id`,
          [legacyCode,legacyCode,shiftId,text(cell(r,10)),phone,transfer,text(cell(r,17)),status,
           cell(r,20) instanceof Date ? cell(r,20) : new Date()]
        );
        const cert=text(cell(r,16)), certStatus=cert && !/пришлют позже/i.test(cert)?"legacy_link":/пришлют позже/i.test(cert)?"send_later":"not_provided";
        await client.query(
          `INSERT INTO children(booking_id,first_name,last_name,birth_date,age_at_shift,coach,dance_style,allergies,restrictions,certificate_status,certificate_legacy_url)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [saved.rows[0].id,firstName,lastName,birthDate,age,text(cell(r,11)),text(cell(r,12)),text(cell(r,13)),text(cell(r,14)),certStatus,certStatus==="legacy_link"?cert:null]
        );
        bookingsImported++;
      }
    }
    await client.query("COMMIT");
    await audit(req.admin.id,"legacy.import","workbook",null,{shiftsImported,bookingsImported,duplicates,skipped});
    res.json({ ok:true, shiftsImported, bookingsImported, duplicates, skipped });
  } catch (error) {
    await client.query("ROLLBACK").catch(()=>{});
    next(error);
  } finally { client.release(); }
});

async function getShiftRoster(shiftId) {
  const { rows }=await pool.query(
    `SELECT s.*,b.code,b.parent_name,b.phone,b.status,b.transfer_requested,b.transfer_note,b.created_at,
       c.id child_id,c.first_name,c.last_name,c.birth_date,c.age_at_shift,c.coach,c.dance_style,c.allergies,c.restrictions,c.certificate_status,c.certificate_legacy_url,
       d.id document_id
     FROM shifts s JOIN bookings b ON b.shift_id=s.id
     JOIN children c ON c.booking_id=b.id
     LEFT JOIN child_documents d ON d.child_id=c.id
     WHERE s.id=$1 AND b.status<>'cancelled'
     ORDER BY c.last_name,c.first_name`,
    [shiftId]
  );
  return rows;
}
app.get("/api/admin/exports/shifts/:id/participants.xlsx", requireAdmin, async (req, res, next) => {
  try {
    const rows=await getShiftRoster(req.params.id);
    if (!rows.length) {
      const shift=await pool.query("SELECT title,start_date,end_date FROM shifts WHERE id=$1",[req.params.id]);
      if (!shift.rowCount) return res.status(404).json({ok:false,error:"Смена не найдена"});
    }
    const shift=rows[0] || (await pool.query("SELECT * FROM shifts WHERE id=$1",[req.params.id])).rows[0];
    const book=new ExcelJS.Workbook();
    book.creator="Дело Ритма"; book.created=new Date();
    const sheet=book.addWorksheet("Участники",{views:[{state:"frozen",ySplit:4}]});
    sheet.mergeCells("A1:P1"); sheet.getCell("A1").value="ДЕЛО РИТМА · СПИСОК УЧАСТНИКОВ";
    sheet.getCell("A1").font={bold:true,size:16,color:{argb:"FFFFFFFF"}};
    sheet.getCell("A1").fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF171A17"}};
    sheet.mergeCells("A2:P2"); sheet.getCell("A2").value=`${shift.title} · ${formatDate(shift.start_date)} — ${formatDate(shift.end_date)} · ${shift.place}`;
    sheet.getCell("A2").font={bold:true,size:11};
    sheet.addRow([]);
    const header=["№","Заявка","Фамилия","Имя","Дата рождения","Возраст","Телефон родителя","ФИО родителя","Тренер","Стиль","Аллергии","Ограничения","Трансфер","Свидетельство","Статус заявки","Дата заявки"];
    sheet.addRow(header);
    const headerRow=sheet.getRow(4); headerRow.height=30;
    headerRow.eachCell(c=>{c.font={bold:true,color:{argb:"FFFFFFFF"},size:10};c.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF41483D"}};c.alignment={vertical:"middle",wrapText:true};});
    rows.forEach((r,i)=>sheet.addRow([
      i+1,r.code,r.last_name,r.first_name,isoDate(r.birth_date),r.age_at_shift,r.phone,r.parent_name,r.coach,r.dance_style,
      r.allergies,r.restrictions,r.transfer_requested?"Да":"Нет",
      r.certificate_status==="uploaded"?"Загружено":r.certificate_status==="send_later"?"Пришлют позже":r.certificate_status==="legacy_link"?"Ссылка из старой базы":"Нет",
      ({new:"Новая",confirmed:"Подтверждена",paid:"Оплачена",cancelled:"Отменена"})[r.status]||r.status,r.created_at
    ]));
    sheet.columns=[
      {width:6},{width:18},{width:20},{width:18},{width:15},{width:10},{width:20},{width:22},
      {width:20},{width:18},{width:30},{width:25},{width:12},{width:18},{width:18},{width:20}
    ];
    sheet.autoFilter={from:"A4",to:"P4"};
    sheet.eachRow((r,n)=>{if(n>4){r.alignment={vertical:"top",wrapText:true};if(n%2===1)r.eachCell(c=>c.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFF4F5F1"}});}});
    const buffer=await book.xlsx.writeBuffer();
    const filename=encodeURIComponent(`Участники — ${shift.title}.xlsx`);
    res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition",`attachment; filename*=UTF-8''${filename}`);
    res.send(Buffer.from(buffer));
  } catch(error){next(error);}
});
app.get("/api/admin/exports/shifts/:id/transfer.docx", requireAdmin, async (req,res,next)=>{
  try{
    const {rows}=await pool.query(
      `SELECT s.title,s.start_date,s.end_date,s.place,b.code,b.parent_name,b.phone,b.transfer_note,
        c.first_name,c.last_name,c.age_at_shift
       FROM shifts s JOIN bookings b ON b.shift_id=s.id JOIN children c ON c.booking_id=b.id
       WHERE s.id=$1 AND b.status<>'cancelled' AND b.transfer_requested=TRUE
       ORDER BY c.last_name,c.first_name`,[req.params.id]);
    if(!rows.length)return res.status(404).json({ok:false,error:"На эту смену пока нет участников с трансфером"});
    const s=rows[0];
    const borders={top:{style:BorderStyle.SINGLE,size:4,color:"D5D8D0"},bottom:{style:BorderStyle.SINGLE,size:4,color:"D5D8D0"},left:{style:BorderStyle.SINGLE,size:4,color:"D5D8D0"},right:{style:BorderStyle.SINGLE,size:4,color:"D5D8D0"}};
    const cell=(value,bold=false)=>new TableCell({children:[new Paragraph({children:[new TextRun({text:String(value??""),bold,size:18})]})],borders,margins:{top:90,bottom:90,left:100,right:100},verticalAlign:"center"});
    const head=new TableRow({tableHeader:true,children:["№","ФИО ребёнка","Возраст","Телефон родителя","Туда","Обратно","Отметка"].map(x=>cell(x,true))});
    const lines=rows.map((r,i)=>new TableRow({children:[
      cell(i+1),cell(r.last_name+" "+r.first_name),cell(r.age_at_shift),cell(r.phone),cell("□"),cell("□"),cell("")
    ]}));
    const doc=new Document({sections:[{properties:{page:{size:{orientation:"landscape"}}},children:[
      new Paragraph({text:"ДЕЛО РИТМА",heading:HeadingLevel.HEADING_1,spacing:{after:90}}),
      new Paragraph({text:"СПИСОК НА ТРАНСФЕР",heading:HeadingLevel.HEADING_2,spacing:{after:180}}),
      new Paragraph({children:[new TextRun({text:"Смена: ",bold:true}),new TextRun(s.title)]}),
      new Paragraph({children:[new TextRun({text:"Даты: ",bold:true}),new TextRun(formatDate(s.start_date)+" — "+formatDate(s.end_date))]}),
      new Paragraph({children:[new TextRun({text:"Место: ",bold:true}),new TextRun(s.place||"")]}),
      new Paragraph({children:[new TextRun({text:"Маршрут: ",bold:true}),new TextRun("Тюмень — ______________________________ — лагерь")]}),
      new Paragraph({children:[new TextRun({text:"Время выезда: ",bold:true}),new TextRun("______________    "),new TextRun({text:"Время возвращения: ",bold:true}),new TextRun("______________")],spacing:{after:220}}),
      new Table({width:{size:100,type:WidthType.PERCENTAGE},columnWidths:[650,2200,700,1800,650,750,1100],rows:[head,...lines],borders:{top:borders.top,bottom:borders.bottom,insideHorizontal:borders.bottom,insideVertical:borders.left}}),
      new Paragraph({text:"Ответственный за посадку: ____________________________________    Подпись: ____________________",spacing:{before:260}}),
      new Paragraph({text:"Ответственный за возвращение: _______________________________    Подпись: ____________________",spacing:{before:140}}),
      new Paragraph({children:[new TextRun({text:"Всего детей: ",bold:true}),new TextRun(String(rows.length)),new TextRun({text:"       Примечания: ",bold:true}),new TextRun("__________________________________________________________")],spacing:{before:180}})
    ]}]});
    const buffer=await Packer.toBuffer(doc);
    res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent("Трансфер — "+s.title+".docx")}`);
    res.send(buffer);
  }catch(error){next(error);}
});

app.use(express.static(join(ROOT,"web"),{extensions:["html"],maxAge:process.env.NODE_ENV==="production"?"1h":0}));
app.use("/img",express.static(join(ROOT,"img"),{maxAge:"7d"}));
app.use("/icons",express.static(join(ROOT,"icons"),{maxAge:"7d"}));
app.get("/admin",(_req,res)=>res.sendFile(join(ROOT,"web","admin.html")));
app.use((req,res,next)=>{
  if(req.method!=="GET")return next();
  if(req.path.startsWith("/api/"))return res.status(404).json({ok:false,error:"API route not found"});
  res.sendFile(join(ROOT,"web","index.html"),error=>error&&next(error));
});
app.use((error,_req,res,_next)=>{
  console.error(error);
  const status=Number(error.status)||500;
  res.status(status).json({ok:false,error:status<500?error.message:"Внутренняя ошибка сервера. Попробуйте ещё раз."});
});

async function main(){
  if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is required");
  await migrate();
  app.listen(PORT,"0.0.0.0",()=>console.log(`Дело Ритма cloud server listening on :${PORT}`));
}
main().catch(error=>{console.error("Startup failed:",error);process.exit(1);});
