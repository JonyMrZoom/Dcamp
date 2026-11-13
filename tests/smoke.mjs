import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";

const read = path => readFile(new URL("../" + path, import.meta.url), "utf8");
const [server, schema, publicHtml, publicJs, adminHtml, adminJs] = await Promise.all([
  read("server.mjs"), read("server/schema.sql"), read("web/index.html"),
  read("web/app.js"), read("web/admin.html"), read("web/admin.js")
]);

for (const route of [
  'app.get("/api/public/shifts"',
  'app.post("/api/public/bookings"',
  'app.post("/api/public/waitlist"',
  'app.post("/api/admin/login"',
  'app.get("/api/admin/dashboard"',
  'app.get("/api/admin/bookings"',
  'app.get("/api/admin/exports/shifts/:id/participants.xlsx"',
  'app.get("/api/admin/exports/shifts/:id/transfer.docx"',
  'app.post("/api/admin/import/legacy-xlsx"'
]) assert.ok(server.includes(route), `Missing route: ${route}`);

for (const table of ["admins","admin_sessions","shifts","bookings","children","child_documents","waitlist","audit_log"]) {
  assert.ok(schema.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `Missing table: ${table}`);
}
assert.ok(publicHtml.includes('id="bookingDialog"'));
assert.ok(publicHtml.includes('id="shiftGrid"'));
assert.ok(publicJs.includes("/api/public/bookings"));
assert.ok(publicJs.includes("certificate"));
assert.ok(adminHtml.includes('id="participantRows"'));
assert.ok(adminHtml.includes('id="migrationForm"'));
assert.ok(adminJs.includes("participants.xlsx"));
assert.ok(adminJs.includes("transfer.docx"));
assert.ok(!server.includes("script.google.com"));
assert.ok(!server.includes("googleapis.com"));

for (const path of ["render.yaml",".env.example","web/site.css","web/admin.css"]) {
  await access(new URL("../"+path, import.meta.url));
}
console.log("Cloud platform smoke checks passed.");
