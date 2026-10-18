// BuyWise initial administrator bootstrap (local only).
// Usage (PowerShell):
//   $env:ADMIN_USERNAME = "owner"; $env:ADMIN_PASSWORD = "long-secret-here"
//   node scripts/create-admin.mjs            (run from D:\flexi\web)
// Refuses when any user already exists — use the admin UI afterwards.
// Never prints secrets.
// Run from D:\flexi\web so ../tools and ../.env resolve.
import { readFileSync } from "node:fs";
import pg from "pg";
import { hashPassword, validateUsername, validatePassword } from "../../tools/_lib/passwords.mjs";

for (const line of readFileSync("../.env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && m[2] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const username = String(process.env.ADMIN_USERNAME || "");
const password = String(process.env.ADMIN_PASSWORD || "");
const vu = validateUsername(username);
if (!vu.ok) { console.error("bad ADMIN_USERNAME:", vu.reason); process.exit(1); }
const vp = validatePassword(password);
if (!vp.ok) { console.error("bad ADMIN_PASSWORD:", vp.reason); process.exit(1); }

const c = new pg.Client({
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB || "buywise",
  user: process.env.POSTGRES_USER || "buywise",
  password: process.env.POSTGRES_PASSWORD || "",
});
await c.connect();
const existing = await c.query("SELECT count(*)::int AS n FROM users");
if (existing.rows[0].n > 0) {
  console.error("users already exist — create further accounts as admin in the UI");
  await c.end();
  process.exit(1);
}
const hash = await hashPassword(password);
await c.query("INSERT INTO users (username, password_hash, role) VALUES ($1,$2,'admin')", [username, hash]);
console.log(`admin '${username}' created. Delete ADMIN_PASSWORD from your shell history/env now.`);
await c.end();
