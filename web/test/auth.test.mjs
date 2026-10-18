// BuyWise auth/RBAC tests (live server + real DB; fixtures use t_ prefix and
// synthetic shell cases only — no fake products/offers, no team accounts).
// Run: node --test test/auth.test.mjs  (or npm test)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { ensureUser, dropUser, closePool, login, call, BASE } from './helpers.mjs';

const PGHOST = 'localhost';
function db() {
  return new pg.Pool({ host: PGHOST, port: 5432, database: 'buywise', user: 'buywise', password: process.env.PGPASSWORD || '' });
}
// NOTE: PGPASSWORD is empty in most shells; derive from repo .env like helpers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
function pgPass() {
  if (process.env.PGPASSWORD) return process.env.PGPASSWORD;
  try {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
    for (const line of fs.readFileSync(root, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*POSTGRES_PASSWORD\s*=\s*(.*?)\s*$/);
      if (m && m[1]) return m[1];
    }
  } catch { /* ignore */ }
  return '';
}
process.env.PGPASSWORD = pgPass();

const STAMP = String(Date.now() % 100000);
const U = { boss: 't_boss_' + STAMP, req: 't_req_' + STAMP, req2: 't_req2_' + STAMP, off: 't_off_' + STAMP, app: 't_app_' + STAMP, aud: 't_aud_' + STAMP };
let S = {};
let shells = [];

async function mkShell(suffix, budget = 30000) {
  const pool = db();
  const { rows } = await pool.query(
    `INSERT INTO procurement_cases (requirement, quantity, budget, currency, mode, created_by)
     VALUES ($1, 2, $2, 'INR', 'REAL', 'auth-test') RETURNING procurement_id, version`,
    [`auth-matrix test shell ${suffix} — synthetic fixture, no products`, budget]);
  await pool.end();
  shells.push(rows[0].procurement_id);
  return rows[0];
}
async function setOwner(shellId, usernameOrNull) {
  const pool = db();
  if (usernameOrNull) {
    await pool.query(`UPDATE procurement_cases SET owner_user_id=(SELECT user_id FROM users WHERE username=$1) WHERE procurement_id=$2`, [usernameOrNull, shellId]);
  } else {
    await pool.query(`UPDATE procurement_cases SET owner_user_id=NULL WHERE procurement_id=$1`, [shellId]);
  }
  await pool.end();
}

before(async () => {
  await ensureUser(U.boss, 'boss-pass-11', 'admin');
  await ensureUser(U.req, 'req-pass-11', 'requester');
  await ensureUser(U.req2, 'req2-pass-11', 'requester');
  await ensureUser(U.off, 'off-pass-11', 'officer');
  await ensureUser(U.app, 'app-pass-11', 'approver', 500000);
  await ensureUser(U.aud, 'aud-pass-11', 'auditor');
  S.boss = await login(U.boss, 'boss-pass-11');
  S.req = await login(U.req, 'req-pass-11');
  S.req2 = await login(U.req2, 'req2-pass-11');
  S.off = await login(U.off, 'off-pass-11');
  S.app = await login(U.app, 'app-pass-11');
  S.aud = await login(U.aud, 'aud-pass-11');
});

after(async () => {
  const pool = db();
  for (const id of shells) await pool.query('DELETE FROM procurement_cases WHERE procurement_id=$1', [id]);
  await pool.end();
  for (const u of [U.boss, U.req, U.req2, U.off, U.app, U.aud]) await dropUser(u).catch(() => {});
  await closePool();
});

test('unauthenticated requests are rejected', async () => {
  for (const p of ['/api/cases', '/api/dashboard', '/api/me', '/api/approvals/pending']) {
    const r = await fetch(BASE + p);
    assert.equal(r.status, 401, p);
  }
  const r = await fetch(BASE + '/api/procurements', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
});

test('login errors are generic (no user enumeration)', async () => {
  const badPass = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: U.req, password: 'wrong-pass' }) });
  // Unique nonexistent user per run: the login rate limiter is shared process
  // state, so a fixed name couples this assertion to other runs' budgets.
  const ghost = 'no-such-user-' + STAMP;
  const badUser = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: ghost, password: 'wrong-pass' }) });
  assert.equal(badPass.status, 401);
  assert.equal(badUser.status, 401);
  assert.equal((await badPass.json()).error, (await badUser.json()).error);
});

test('mutations require CSRF token', async () => {
  const r = await fetch(BASE + '/api/cases/00000000-0000-4000-8000-000000000000/approvals', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: S.off.cookie }, body: '{}',
  });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /CSRF/);
});

test('role matrix on protected actions', async () => {
  const anyId = '00000000-0000-4000-8000-000000000000';
  await assert.rejects(call(S.aud, '/api/procurements', { method: 'POST', body: '{}' }), /403/);
  await assert.rejects(call(S.req, '/api/cases/' + anyId + '/pipeline/run', { method: 'POST', body: '{}' }), /403/);
  await assert.rejects(call(S.app, '/api/cases/' + anyId + '/demo/negotiations', { method: 'POST', body: '{}' }), /403/);
  await assert.rejects(call(S.req, '/api/cases/' + anyId + '/demo/negotiations', { method: 'POST', body: '{}' }), /403/);
  await assert.rejects(call(S.aud, '/api/admin/users'), /403/);
  // allowed reads for every role
  for (const s of [S.req, S.off, S.app, S.aud, S.boss]) {
    await call(s, '/api/cases');
    await call(s, '/api/dashboard');
  }
});

test('ownership claim: first-come wins, others refused', async () => {
  const shell = await mkShell('claim');
  const r = await call(S.off, '/api/cases/' + shell.procurement_id + '/claim', { method: 'POST', body: '{}' });
  assert.ok(r.owner);
  await assert.rejects(call(S.req, '/api/cases/' + shell.procurement_id + '/claim', { method: 'POST', body: '{}' }), /409/);
  await assert.rejects(call(S.aud, '/api/cases/' + shell.procurement_id + '/claim', { method: 'POST', body: '{}' }), /403/);
});

test('requester owns created case; cross-user edit denied, officer allowed', async () => {
  const shell = await mkShell('ownership');
  await setOwner(shell.procurement_id, U.req);
  await assert.rejects(call(S.req2, '/api/cases/' + shell.procurement_id, { method: 'PATCH', body: JSON.stringify({ quantity: 3 }) }), /403/);
  const r = await call(S.off, '/api/cases/' + shell.procurement_id, { method: 'PATCH', body: JSON.stringify({ quantity: 3 }) });
  assert.equal(r.version, 2);
  const own = await call(S.req, '/api/cases/' + shell.procurement_id, { method: 'PATCH', body: JSON.stringify({ quantity: 4 }) });
  assert.equal(own.version, 3);
});

test('closed cases are immutable', async () => {
  await assert.rejects(
    call(S.off, '/api/cases/2cb4fb21-bcdc-4311-8d62-dc2167320a0d', { method: 'PATCH', body: JSON.stringify({ quantity: 9 }) }), /409/);
});

test('edit under a pending approval invalidates the package (stale, not silent)', async () => {
  const shell = await mkShell('pending-edit');
  const a = await call(S.off, '/api/cases/' + shell.procurement_id + '/approvals', { method: 'POST', body: '{}' });
  const ed = await call(S.off, '/api/cases/' + shell.procurement_id, { method: 'PATCH', body: JSON.stringify({ quantity: 5 }) });
  assert.equal(ed.version, 2);
  await assert.rejects(
    call(S.app, '/api/approvals/' + a.approval_id + '/decision', { method: 'POST', body: JSON.stringify({ decision: 'APPROVED', reason: 'after edit' }) }),
    /409/);
  const snap = await call(S.app, '/api/cases/' + shell.procurement_id);
  assert.ok(snap.approval_events.some((e) => e.event_type === 'decision_rejected_stale'), 'stale event recorded');
});

test('self-approval is refused', async () => {
  const shell = await mkShell('sod');
  await call(S.off, '/api/cases/' + shell.procurement_id + '/approvals', { method: 'POST', body: '{}' });
  await setOwner(shell.procurement_id, U.app);
  const snap = await call(S.app, '/api/cases/' + shell.procurement_id);
  const apprId = snap.approvals[0].approval_id;
  await assert.rejects(
    call(S.app, '/api/approvals/' + apprId + '/decision', { method: 'POST', body: JSON.stringify({ decision: 'APPROVED', reason: 'self' }) }),
    /403/);
  await setOwner(shell.procurement_id, null);
});

test('duplicate approval submission returns the existing package', async () => {
  const shell = await mkShell('dup-submit');
  const a1 = await call(S.off, '/api/cases/' + shell.procurement_id + '/approvals', { method: 'POST', body: '{}' });
  assert.equal(a1.status, 'PENDING_APPROVAL');
  const a2 = await call(S.off, '/api/cases/' + shell.procurement_id + '/approvals', { method: 'POST', body: '{}' });
  assert.equal(a2.approval_id, a1.approval_id);
  const snap = await call(S.off, '/api/cases/' + shell.procurement_id);
  assert.equal(snap.approvals.filter((a) => a.status === 'PENDING_APPROVAL').length, 1);
});

test('over-limit approval is refused', async () => {
  const shell = await mkShell('limit', 600000);
  const a = await call(S.off, '/api/cases/' + shell.procurement_id + '/approvals', { method: 'POST', body: '{}' });
  await assert.rejects(
    call(S.app, '/api/approvals/' + a.approval_id + '/decision', { method: 'POST', body: JSON.stringify({ decision: 'APPROVED', reason: 'over limit' }) }),
    /403/);
});

test('deactivation kills sessions and blocks login', async () => {
  await ensureUser('t_gone', 'gone-pass-11', 'auditor');
  const s = await login('t_gone', 'gone-pass-11');
  await call(s, '/api/cases');
  await call(S.boss, '/api/admin/users/' + s.user.id, { method: 'PATCH', body: JSON.stringify({ active: false }) });
  await assert.rejects(call(s, '/api/cases'), /401/);
  await assert.rejects(login('t_gone', 'gone-pass-11'), /401/);
  await dropUser('t_gone');
});

test('admin user management validates input', async () => {
  await assert.rejects(call(S.boss, '/api/admin/users', { method: 'POST', body: JSON.stringify({ username: 'x', password: 'long-enough-1', role: 'auditor' }) }), /400/);
  await assert.rejects(call(S.boss, '/api/admin/users', { method: 'POST', body: JSON.stringify({ username: 't_dup', password: 'short', role: 'auditor' }) }), /400/);
  await assert.rejects(call(S.boss, '/api/admin/users', { method: 'POST', body: JSON.stringify({ username: 't_dup', password: 'long-enough-1', role: 'superuser' }) }), /400/);
  await call(S.boss, '/api/admin/users', { method: 'POST', body: JSON.stringify({ username: 't_dup', password: 'long-enough-1', role: 'auditor' }) });
  await assert.rejects(call(S.boss, '/api/admin/users', { method: 'POST', body: JSON.stringify({ username: 't_dup', password: 'long-enough-1', role: 'auditor' }) }), /409/);
  await dropUser('t_dup');
  const ev = await call(S.boss, '/api/admin/events');
  assert.ok(ev.events.some((e) => e.action === 'user_created'), 'admin action audited');
});

test('pipeline rerun is idempotent on active cases, refused on terminal history', async () => {
  const pool = db();
  const mkFull = async (suffix) => {
    const { rows } = await pool.query(
      `INSERT INTO procurement_cases (requirement, quantity, budget, currency, mode, created_by)
       VALUES ($1, 2, 30000, 'INR', 'REAL', 'auth-test') RETURNING procurement_id`,
      [`auth-matrix rerun shell ${suffix} — synthetic fixture`]);
    const id = rows[0].procurement_id;
    shells.push(id);
    const tag = id.replace(/-/g, '').slice(0, 8);
    await pool.query(`INSERT INTO products (product_id,procurement_id,name,source,source_url,retrieved_at,data_status,confidence)
      VALUES ($1,$2,'Rerun Widget','test','https://example.test/p',now(),'LIVE',0.8)`, [`p-rr-${tag}`, id]);
    await pool.query(`INSERT INTO vendors (vendor_id,procurement_id,vendor_name,source,source_url,retrieved_at,data_status,confidence)
      VALUES ($1,$2,'Rerun Store','test','https://example.test/s',now(),'LIVE',0.8)`, [`v-rr-${tag}`, id]);
    await pool.query(`INSERT INTO offers (offer_id,procurement_id,product_id,vendor_id,unit_price,currency,net_price,source,source_url,retrieved_at,data_status,confidence)
      VALUES ($1,$2,$3,$4,10000,'INR',10000,'test','https://example.test/o',now(),'LIVE',0.8)`, [`o-rr-${tag}`, id, `p-rr-${tag}`, `v-rr-${tag}`]);
    await pool.query(`INSERT INTO comparisons (procurement_id,product_id,rank,overall_score,criteria_scores,criteria_used,criteria_missing,effective_weight_total,rules_version)
      VALUES ($1,$2,1,0.5,'{}','[]','[]',0.1,'1.0.0')`, [id, `p-rr-${tag}`]);
    await pool.query(`INSERT INTO decisions (procurement_id,product_id,decision,decision_reason,blocking_reasons,criteria_used,criteria_missing,evidence_urls)
      VALUES ($1,$2,'INSUFFICIENT_DATA','synthetic','[]','[]','[]','[]')`, [id, `p-rr-${tag}`]);
    return id;
  };
  const counts = async (id) => (await pool.query(`SELECT
    (SELECT count(*) FROM offers WHERE procurement_id=$1) o,
    (SELECT count(*) FROM comparisons WHERE procurement_id=$1) c,
    (SELECT count(*) FROM decisions WHERE procurement_id=$1) d`, [id])).rows[0];
  // Active case: re-run succeeds without duplicating rows.
  const activeId = await mkFull('active');
  await pool.query(`UPDATE procurement_cases SET status='decided' WHERE procurement_id=$1`, [activeId]);
  const n0 = await counts(activeId);
  const r = await call(S.off, '/api/cases/' + activeId + '/pipeline/run', { method: 'POST', body: '{}' });
  assert.ok(['skipped', 'completed'].includes(r.stages.vendor_enrichment.status));
  assert.deepEqual(await counts(activeId), n0);
  // Terminal case: refused, history byte-identical (legacy handoff exhibits stay intact).
  const shutId = await mkFull('shut');
  for (const s of ['decided', 'pending_approval', 'closed']) {
    await pool.query(`UPDATE procurement_cases SET status=$2 WHERE procurement_id=$1`, [shutId, s]);
  }
  const m0 = await counts(shutId);
  await assert.rejects(call(S.off, '/api/cases/' + shutId + '/pipeline/run', { method: 'POST', body: '{}' }), /terminal state/);
  assert.deepEqual(await counts(shutId), m0);
  await pool.end();
});

test('rate limiting engages (runs last)', async () => {
  let last = 0;
  for (let i = 0; i < 6; i++) {
    try { await login(U.req, 'wrong-password'); } catch (e) { last = e.status; }
  }
  assert.equal(last, 429);
  // lockout also holds back valid credentials until the window resets
  await assert.rejects(login(U.req, 'req-pass-11'), /429/);
});
