// Shared test helpers: DB users + session login (no mocks of the app itself).
// Imported by api.test.mjs and auth.test.mjs. Test users use the t_ prefix
// and are removed by each file's teardown; team accounts are never touched.
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../../tools/_lib/passwords.mjs';

export const BASE = process.env.BUYWISE_WEB || 'http://localhost:8080';

function pgPassword() {
  if (process.env.PGPASSWORD) return process.env.PGPASSWORD;
  try {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
    for (const line of fs.readFileSync(root, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*POSTGRES_PASSWORD\s*=\s*(.*?)\s*$/);
      if (m && m[1]) return m[1];
    }
  } catch { /* no .env */ }
  return '';
}

const pool = new pg.Pool({ host: 'localhost', port: 5432, database: 'buywise', user: 'buywise', password: pgPassword() });

export async function ensureUser(username, password, role, approval_limit = null) {
  await pool.query('DELETE FROM sessions WHERE user_id IN (SELECT user_id FROM users WHERE username=$1)', [username]);
  await pool.query('DELETE FROM users WHERE username=$1', [username]);
  const hash = await hashPassword(password);
  const { rows } = await pool.query(
    'INSERT INTO users (username, password_hash, role, approval_limit) VALUES ($1,$2,$3,$4) RETURNING user_id, username, role',
    [username, hash, role, approval_limit]);
  return rows[0];
}

export async function dropUser(username) {
  await pool.query('DELETE FROM sessions WHERE user_id IN (SELECT user_id FROM users WHERE username=$1)', [username]);
  await pool.query('DELETE FROM users WHERE username=$1', [username]);
}

export async function closePool() { await pool.end(); }

export async function login(username, password) {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('HTTP ' + r.status + ': ' + (data.error || '')); e.status = r.status; throw e; }
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return { user: data.user, csrf: data.csrf, cookie };
}

export async function call(sess, path, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (sess?.cookie) headers.cookie = sess.cookie;
  if (sess?.csrf && opts.method && opts.method !== 'GET') headers['x-csrf-token'] = sess.csrf;
  const r = await fetch(BASE + path, { ...opts, headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('HTTP ' + r.status + ': ' + (data.error || '')); e.status = r.status; e.data = data; throw e; }
  return data;
}
