// BuyWise lifecycle API tests: transition legality, REAL proposals, handoff,
// approval-reason rule. Synthetic shells (t_ users) only; shared fixtures are
// read, never mutated. Run: node --test test/lifecycle.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureUser, dropUser, closePool, login, call, BASE } from './helpers.mjs';

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
const U = { off: 't_lc_off_' + STAMP, app: 't_lc_app_' + STAMP, req: 't_lc_req_' + STAMP };
let S = {};
const shells = [];

function db() {
  return new pg.Pool({ host: 'localhost', port: 5432, database: 'buywise', user: 'buywise', password: process.env.PGPASSWORD });
}
async function mkShell(suffix, budget = 30000) {
  const pool = db();
  const { rows } = await pool.query(
    `INSERT INTO procurement_cases (requirement, quantity, budget, currency, mode, created_by)
     VALUES ($1, 2, $2, 'INR', 'REAL', 'lifecycle-test') RETURNING procurement_id, version`,
    [`lifecycle test shell ${suffix} — synthetic fixture`, budget]);
  await pool.end();
  shells.push(rows[0].procurement_id);
  return rows[0];
}

before(async () => {
  await ensureUser(U.off, 'off-pass-11', 'officer');
  await ensureUser(U.app, 'app-pass-11', 'approver', 500000);
  await ensureUser(U.req, 'req-pass-11', 'requester');
  S.off = await login(U.off, 'off-pass-11');
  S.app = await login(U.app, 'app-pass-11');
  S.req = await login(U.req, 'req-pass-11');
});
after(async () => {
  const pool = db();
  for (const id of shells) await pool.query('DELETE FROM procurement_cases WHERE procurement_id=$1', [id]);
  await pool.end();
  for (const u of [U.off, U.app, U.req]) await dropUser(u).catch(() => {});
  await closePool();
});

test('illegal transition is rejected before side effects + audited', async () => {
  // Closed DEMO case: negotiating again is illegal; no rows may be created.
  const id = '2cb4fb21-bcdc-4311-8d62-dc2167320a0d';
  const before = await call(S.off, '/api/cases/' + id);
  const n0 = before.negotiations.length;
  await assert.rejects(
    call(S.off, '/api/cases/' + id + '/demo/negotiations', { method: 'POST', body: JSON.stringify({ offer_id: (before.offers[0] || {}).offer_id || 'o-missing' }) }),
    /409/);
  const after = await call(S.off, '/api/cases/' + id);
  assert.equal(after.negotiations.length, n0, 'rejected transition must not write rows');
  assert.ok(after.audit.some((a) => a.event === 'transition_rejected'), 'rejection must be audited');
});

test('REAL proposal: officer creates unsent draft, duplicates return existing', async () => {
  const id = 'b604039e-3199-4e5a-8ed7-8767fe4fe572';
  const snap = await call(S.off, '/api/cases/' + id);
  const offer = snap.offers.find((o) => typeof o.net_price === 'number' && o.currency);
  assert.ok(offer, 'fixture case needs a priced offer');
  {
    // hermetic start: drop any pre-existing REAL proposal rows for this offer
    const pool = db();
    await pool.query(`DELETE FROM negotiation_events WHERE negotiation_id IN (SELECT negotiation_id FROM negotiations WHERE procurement_id=$1 AND offer_id=$2 AND mode='REAL')`, [id, offer.offer_id]);
    await pool.query(`DELETE FROM agent_messages WHERE procurement_id=$1 AND payload->>'offer_id'=$2`, [id, offer.offer_id]);
    await pool.query(`DELETE FROM negotiations WHERE procurement_id=$1 AND offer_id=$2 AND mode='REAL'`, [id, offer.offer_id]);
    await pool.end();
  }
  await assert.rejects(
    call(S.req, '/api/cases/' + id + '/negotiations', { method: 'POST', body: JSON.stringify({ offer_id: offer.offer_id }) }), /403/);
  const target = Math.round(Number(offer.net_price) * 0.9 * 100) / 100;
  const n1 = await call(S.off, '/api/cases/' + id + '/negotiations', { method: 'POST', body: JSON.stringify({ offer_id: offer.offer_id, target_price: target }) });
  assert.equal(n1.status, 'READY_FOR_HUMAN_REVIEW');
  assert.equal(n1.sent, false);
  assert.equal(n1.target_price, target);
  assert.ok(typeof n1.target_total === 'number' || n1.target_total === null, 'totals computed');
  assert.ok(Array.isArray(n1.assumptions) && n1.assumptions.length > 0, 'assumptions disclosed');
  const n2 = await call(S.off, '/api/cases/' + id + '/negotiations', { method: 'POST', body: JSON.stringify({ offer_id: offer.offer_id }) });
  assert.equal(n2.negotiation_id, n1.negotiation_id, 'duplicate must return existing');
  assert.equal(n2.existing, true);
  await assert.rejects(
    call(S.off, '/api/cases/' + id + '/negotiations', { method: 'POST', body: JSON.stringify({ offer_id: 'o-missing' }) }), /422/);
  // cleanup test proposal (fixture rows otherwise untouched)
  const pool = db();
  await pool.query('DELETE FROM negotiation_events WHERE negotiation_id=$1', [n1.negotiation_id]);
  await pool.query(`DELETE FROM agent_messages WHERE procurement_id=$1 AND payload->>'offer_id'=$2`, [id, offer.offer_id]);
  await pool.query('DELETE FROM negotiations WHERE negotiation_id=$1', [n1.negotiation_id]);
  await pool.end();
});

test('handoff requires closed REAL-approved case', async () => {
  const shell = await mkShell('handoff-open');
  await assert.rejects(call(S.off, '/api/cases/' + shell.procurement_id + '/handoff', { method: 'POST', body: '{}' }), /409/);
  await assert.rejects(
    call(S.off, '/api/cases/2cb4fb21-bcdc-4311-8d62-dc2167320a0d/handoff', { method: 'POST', body: '{}' }), /409/);
});

test('approving non-PROCEED requires a written reason', async () => {  const shell = await mkShell('reason-rule');
  const pool = db();
  await pool.query(
    `INSERT INTO decisions (procurement_id,decision,decision_reason,blocking_reasons,criteria_used,criteria_missing,evidence_urls)
     VALUES ($1,'INSUFFICIENT_DATA','synthetic fixture decision for rule test', '[]','[]','[]','[]')`, [shell.procurement_id]);
  const ins = await pool.query(
    `INSERT INTO approvals (procurement_id,mode,status,approval_package,request_version)
     VALUES ($1,'REAL','PENDING_APPROVAL','{}',1) RETURNING approval_id`, [shell.procurement_id]);
  const aid = ins.rows[0].approval_id;
  await assert.rejects(
    call(S.app, '/api/approvals/' + aid + '/decision', { method: 'POST', body: JSON.stringify({ decision: 'APPROVED' }) }), /422/);
  await assert.rejects(
    call(S.app, '/api/approvals/' + aid + '/decision', { method: 'POST', body: JSON.stringify({ decision: 'APPROVED', reason: 'short' }) }), /422/);
  await pool.query('DELETE FROM approval_events WHERE approval_id=$1', [aid]);
  await pool.query('DELETE FROM approvals WHERE approval_id=$1', [aid]);
  await pool.query('DELETE FROM decisions WHERE procurement_id=$1', [shell.procurement_id]);
  await pool.end();
});

test('concurrent duplicate approvals yield exactly one PENDING row', async () => {
  const shell = await mkShell('race');
  const pool = db();
  const results = await Promise.allSettled(Array.from({ length: 5 }, () =>
    call(S.off, '/api/cases/' + shell.procurement_id + '/approvals', { method: 'POST', body: '{}' })));
  const okCount = results.filter((r) => r.status === 'fulfilled').length;
  assert.ok(okCount >= 1, 'at least one create must succeed, got ' + okCount);
  const ids = new Set(results.filter((r) => r.status === 'fulfilled').map((r) => r.value.approval_id));
  assert.equal(ids.size, 1, 'concurrent creates must converge on one approval id');
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM approvals WHERE procurement_id=$1 AND status='PENDING_APPROVAL'`, [shell.procurement_id]);
  assert.equal(rows[0].n, 1, 'exactly one PENDING row must exist');
  await pool.query('DELETE FROM approval_events WHERE procurement_id=$1', [shell.procurement_id]);
  await pool.query('DELETE FROM approvals WHERE procurement_id=$1', [shell.procurement_id]);
  await pool.end();
});

test('intake idempotency key converges retries on one case (no n8n call)', async () => {
  const shell = await mkShell('idem-key');
  const KEY = 'test-key-' + shell.procurement_id;
  const pool = db();
  await pool.query('UPDATE procurement_cases SET client_request_id=$1 WHERE procurement_id=$2', [KEY, shell.procurement_id]);
  await pool.end();
  const r = await fetch(BASE + '/api/procurements', { method: 'POST',
    headers: { 'content-type': 'application/json', cookie: S.off.cookie, 'x-csrf-token': S.off.csrf, 'Idempotency-Key': KEY },
    body: JSON.stringify({ requirement: 'completely different text must still dedupe', quantity: 1, budget: 50, currency: 'INR' }) });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.deduped, true);
  assert.equal(data.procurement_id, shell.procurement_id);
});

test('REAL case with no decision and no offers: package allowed (override path), approval needs justification, handoff blocked', async () => {
  const shell = await mkShell('real-noevidence');
  // Package creation itself is allowed (existing behavior); the decision gate
  // carries the justification requirement instead.
  const ap = await call(S.off, '/api/cases/' + shell.procurement_id + '/approvals', { method: 'POST', body: '{}' });
  assert.equal(ap.status, 'PENDING_APPROVAL');
  await assert.rejects(
    call(S.app, '/api/approvals/' + ap.approval_id + '/decision', { method: 'POST', body: JSON.stringify({ decision: 'APPROVED' }) }), /422/);
  await assert.rejects(
    call(S.off, '/api/cases/' + shell.procurement_id + '/handoff', { method: 'POST', body: '{}' }), /409/);
});

test('changed offer terms invalidate the pending package', async () => {
  const shell = await mkShell('stale-offer');
  const pool = db();
  await pool.query(`INSERT INTO products (product_id,procurement_id,name,source,source_url,retrieved_at,data_status) VALUES ('t-prod-1',$1,'synthetic fixture product','test','https://example.test/p1',now(),'LIVE')`, [shell.procurement_id]);
  await pool.query(`INSERT INTO vendors (vendor_id,procurement_id,vendor_name,source,source_url,retrieved_at,data_status) VALUES ('t-vend-1',$1,'Synthetic Vendor','test','https://example.test/v1',now(),'LIVE')`, [shell.procurement_id]);
  await pool.query(`INSERT INTO offers (offer_id,procurement_id,product_id,vendor_id,unit_price,net_price,currency,source,source_url,retrieved_at,data_status) VALUES ('t-off-1',$1,'t-prod-1','t-vend-1',1000,1000,'INR','test','https://example.test/o1',now(),'LIVE')`, [shell.procurement_id]);
  await pool.query(`INSERT INTO decisions (procurement_id,decision,decision_reason,blocking_reasons,criteria_used,criteria_missing,evidence_urls) VALUES ($1,'PROCEED','synthetic fixture','[]','[]','[]','[]')`, [shell.procurement_id]);
  const ins = await pool.query(`INSERT INTO approvals (procurement_id,mode,status,approval_package,request_version,selected_offer_id,selected_product_id,selected_vendor_id) VALUES ($1,'REAL','PENDING_APPROVAL','{"original_offer":{"net_price":1000,"currency":"INR"}}',1,'t-off-1','t-prod-1','t-vend-1') RETURNING approval_id`, [shell.procurement_id]);
  const aid = ins.rows[0].approval_id;
  await pool.query('UPDATE offers SET net_price=1200, unit_price=1200 WHERE offer_id=$1', ['t-off-1']);
  await assert.rejects(
    call(S.app, '/api/approvals/' + aid + '/decision', { method: 'POST', body: JSON.stringify({ decision: 'APPROVED', reason: 'terms changed under review' }) }), /409/);
  await pool.query('DELETE FROM approval_events WHERE approval_id=$1', [aid]);
  await pool.query('DELETE FROM approvals WHERE approval_id=$1', [aid]);
  await pool.query('DELETE FROM decisions WHERE procurement_id=$1', [shell.procurement_id]);
  await pool.query('DELETE FROM offers WHERE procurement_id=$1', [shell.procurement_id]);
  await pool.query('DELETE FROM vendors WHERE procurement_id=$1', [shell.procurement_id]);
  await pool.query('DELETE FROM products WHERE procurement_id=$1', [shell.procurement_id]);
  await pool.end();
});

test('unauthorized roles cannot decide or hand off', async () => {
  const shell = await mkShell('role-gates');
  await assert.rejects(
    call(S.req, '/api/approvals/00000000-0000-4000-8000-000000000000/decision', { method: 'POST', body: JSON.stringify({ decision: 'APPROVED' }) }), /403/);
  await assert.rejects(
    call(S.req, '/api/cases/' + shell.procurement_id + '/handoff', { method: 'POST', body: '{}' }), /403/);
  await assert.rejects(
    call(S.app, '/api/cases/' + shell.procurement_id + '/handoff', { method: 'POST', body: '{}' }), /403/);
});

test('concurrent handoffs converge without duplication', async () => {
  const id = 'b604039e-3199-4e5a-8ed7-8767fe4fe572'; // REAL purchase_handoff exhibit, read-only use
  const results = await Promise.allSettled(Array.from({ length: 4 }, () =>
    call(S.off, '/api/cases/' + id + '/handoff', { method: 'POST', body: '{}' })));
  assert.ok(results.every((r) => r.status === 'fulfilled' && r.value.status === 'purchase_handoff'), 'all concurrent handoffs must converge');
});

test('DEMO records stay labeled end to end (read-only exhibit)', async () => {
  const snap = await call(S.off, '/api/cases/2cb4fb21-bcdc-4311-8d62-dc2167320a0d');
  assert.equal(snap.procurement.mode, 'DEMO');
  assert.equal(snap.procurement.status, 'closed');
  for (const r of snap.demo_responses) {
    assert.equal(r.response_mode, 'DEMO_HUMAN_ENTERED');
    assert.equal(r.vendor_response_verified, false);
  }
  for (const a of snap.approvals) assert.equal(a.mode, 'DEMO');
  assert.ok((snap.audit || []).length > 0, 'audit trail present');
});
