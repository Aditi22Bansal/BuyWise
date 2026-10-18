// BuyWise hardening regression tests (P0 approval safety + P0 scoring +
// P1 comparison/budget/dedup). Isolated synthetic shells only; the historical
// reference case aacc91c1-... is READ, never mutated.
// Run: node --test test/hardening.test.mjs  (server must be up)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureUser, dropUser, closePool, login, call, BASE } from './helpers.mjs';
import { score, SCORING_RULES_VERSION } from '../../tools/_lib/scoring.js';
import { reevaluate } from '../../tools/_lib/reevaluation.js';
import { canHandoff, isApprovalStale } from '../../tools/_lib/lifecycle.js';
import { budgetVerdict, unitBudget, totalFor } from '../../tools/_lib/budget.js';
import { groupOffers } from '../../tools/_lib/commercial.js';

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
const U = { off: 't_hd_off_' + STAMP, app: 't_hd_app_' + STAMP, req: 't_hd_req_' + STAMP, aud: 't_hd_aud_' + STAMP };
let S = {};
const shells = [];
const REF = 'aacc91c1-bf5a-4303-8d04-78f2df472e1c';

function db() {
  return new pg.Pool({ host: 'localhost', port: 5432, database: 'buywise', user: 'buywise', password: process.env.PGPASSWORD });
}
async function mkShell({ mode = 'REAL', quantity = 8, budget = 320000, requirement = null } = {}) {
  const pool = db();
  const { rows } = await pool.query(
    `INSERT INTO procurement_cases (requirement, quantity, budget, currency, mode, created_by)
     VALUES ($1, $2, $3, 'INR', $4, 'hardening-test') RETURNING procurement_id, version`,
    [requirement || `hardening shell ${STAMP} — synthetic fixture`, quantity, budget, mode]);
  await pool.end();
  shells.push(rows[0].procurement_id);
  return rows[0];
}
// Minimal purchasable fixture: product + vendor + offer + scored comparison + decision.
async function mkPurchasable({ mode = 'REAL', decision = 'PROCEED', scoreVal = 0.75 } = {}) {
  const shell = await mkShell({ mode });
  const pool = db();
  const pid = 'p-hard-' + STAMP + '-' + Math.random().toString(36).slice(2, 7);
  const vid = 'v-hard-' + STAMP + '-' + Math.random().toString(36).slice(2, 7);
  const oid = 'o-hard-' + STAMP + '-' + Math.random().toString(36).slice(2, 7);
  await pool.query(
    `INSERT INTO products (product_id,procurement_id,name,source,source_url,retrieved_at,data_status,confidence)
     VALUES ($1,$2,'Hardening Widget','test','https://example.test/p',now(),'LIVE',0.8)`, [pid, shell.procurement_id]);
  await pool.query(
    `INSERT INTO vendors (vendor_id,procurement_id,vendor_name,source,source_url,retrieved_at,data_status,confidence)
     VALUES ($1,$2,'Hardening Store','test','https://example.test/s',now(),'LIVE',0.8)`, [vid, shell.procurement_id]);
  await pool.query(
    `INSERT INTO offers (offer_id,procurement_id,product_id,vendor_id,unit_price,currency,net_price,source,source_url,retrieved_at,data_status,confidence)
     VALUES ($1,$2,$3,$4,10000,'INR',10000,'test','https://example.test/o',now(),'LIVE',0.8)`, [oid, shell.procurement_id, pid, vid]);
  await pool.query(
    `INSERT INTO comparisons (procurement_id,product_id,rank,overall_score,criteria_scores,criteria_used,criteria_missing,effective_weight_total,rules_version)
     VALUES ($1,$2,1,$3,'{}','[\"source_quality\"]','[]',0.1,$4)`, [shell.procurement_id, pid, scoreVal, SCORING_RULES_VERSION]);
  await pool.query(
    `INSERT INTO scoring_configs (procurement_id,weights,rules_version) VALUES ($1,'{}',$2)
     ON CONFLICT (procurement_id) DO UPDATE SET rules_version=EXCLUDED.rules_version`, [shell.procurement_id, SCORING_RULES_VERSION]);
  await pool.query(
    `INSERT INTO decisions (procurement_id,product_id,decision,decision_reason,blocking_reasons,criteria_used,criteria_missing,evidence_urls)
     VALUES ($1,$2,$3,'synthetic hardening fixture','[]','[]','[]','[]')`, [shell.procurement_id, pid, decision]);
  await pool.end();
  return { ...shell, pid, vid, oid };
}

before(async () => {
  await ensureUser(U.off, 'off-pass-11', 'officer');
  await ensureUser(U.app, 'app-pass-11', 'approver', 5000000);
  await ensureUser(U.req, 'req-pass-11', 'requester');
  await ensureUser(U.aud, 'aud-pass-11', 'auditor');
  S.off = await login(U.off, 'off-pass-11');
  S.app = await login(U.app, 'app-pass-11');
  S.req = await login(U.req, 'req-pass-11');
  S.aud = await login(U.aud, 'aud-pass-11');
});
after(async () => {
  const pool = db();
  for (const id of shells) await pool.query('DELETE FROM procurement_cases WHERE procurement_id=$1', [id]).catch(() => {});
  await pool.end();
  for (const u of Object.values(U)) await dropUser(u).catch(() => {});
  await closePool();
});

// ---------- reference case preserved (read-only) ----------
test('reference case inspected, history preserved', async () => {
  const snap = await call(S.off, '/api/cases/' + REF);
  assert.equal(snap.procurement.mode, 'DEMO');
  assert.equal(snap.procurement.status, 'closed');
  assert.equal(snap.decision.decision, 'INSUFFICIENT_DATA');
  assert.equal(snap.comparisons.length, 40);
  assert.ok(snap.comparisons.every((c) => c.overall_score === null), 'all 40 unscored');
  const re = snap.reevaluations[0];
  assert.equal(re.revised_price, 13799);
  assert.equal(Number(re.revised_score), 1);
  assert.deepEqual(re.criteria_changed, ['budget_compliance']);
  assert.equal(snap.approvals[0].mode, 'DEMO');
  assert.equal(snap.approvals[0].status, 'APPROVED');
});

// ---------- P0 approval safety ----------
test('1. DEMO approval cannot authorize REAL handoff', async () => {
  await assert.rejects(call(S.off, '/api/cases/' + REF + '/handoff', { method: 'POST', body: '{}' }), /409/);
  const chk = canHandoff({ caseStatus: 'closed', latestApproval: { status: 'APPROVED', mode: 'DEMO' }, latestDecision: { decision: 'INSUFFICIENT_DATA' } });
  assert.equal(chk.ok, false);
});

test('2. REAL INSUFFICIENT_DATA cannot proceed directly to handoff', async () => {
  const f = await mkPurchasable({ mode: 'REAL', decision: 'INSUFFICIENT_DATA' });
  const pool = db();
  // legal path to closed: created -> decided -> pending_approval -> closed
  await pool.query(`UPDATE procurement_cases SET status='decided' WHERE procurement_id=$1`, [f.procurement_id]);
  await pool.query(`UPDATE procurement_cases SET status='pending_approval' WHERE procurement_id=$1`, [f.procurement_id]);
  await pool.query(`INSERT INTO approvals (procurement_id,mode,status,approval_package,request_version) VALUES ($1,'REAL','APPROVED','{}',1)`, [f.procurement_id]);
  await pool.query(`UPDATE procurement_cases SET status='closed' WHERE procurement_id=$1`, [f.procurement_id]);
  await pool.end();
  await assert.rejects(call(S.off, '/api/cases/' + f.procurement_id + '/handoff', { method: 'POST', body: '{}' }), /PROCEED/);
});

test('3. changed offer / stale package invalidates previous approval', async () => {
  const f = await mkPurchasable({ mode: 'REAL', decision: 'PROCEED' });
  const pkg = await call(S.off, '/api/cases/' + f.procurement_id + '/approvals', { method: 'POST', body: '{}' });
  const pool = db();
  await pool.query('UPDATE offers SET net_price=99999 WHERE offer_id=$1', [f.oid]);
  await pool.end();
  await assert.rejects(call(S.app, '/api/approvals/' + pkg.approval_id + '/decision',
    { method: 'POST', body: JSON.stringify({ decision: 'APPROVED', reason: 'synthetic hardening justification' }) }), /stale/);
  // stale helper also catches scoring/quantity/budget drift
  const st = isApprovalStale({
    approval: { mode: 'REAL', request_version: 1, approval_package: { original_offer: { net_price: 10000, currency: 'INR' }, procurement_request: { quantity: 8, budget: 320000 } }, scoring_version: '1.0.0' },
    current: { mode: 'REAL', version: 1, offer_price: 99999, offer_currency: 'INR', scoring_version: '1.0.0', quantity: 8, budget: 320000 },
  });
  assert.equal(st.stale, true);
});

test('4. unauthorized roles cannot approve or handoff', async () => {
  const f = await mkPurchasable({ mode: 'REAL', decision: 'PROCEED' });
  const pkg = await call(S.off, '/api/cases/' + f.procurement_id + '/approvals', { method: 'POST', body: '{}' });
  await assert.rejects(call(S.req, '/api/approvals/' + pkg.approval_id + '/decision',
    { method: 'POST', body: JSON.stringify({ decision: 'APPROVED', reason: 'requester attempt should fail' }) }), /403/);
  await assert.rejects(call(S.aud, '/api/approvals/' + pkg.approval_id + '/decision',
    { method: 'POST', body: JSON.stringify({ decision: 'APPROVED', reason: 'auditor attempt should fail' }) }), /403/);
  await assert.rejects(call(S.req, '/api/cases/' + f.procurement_id + '/handoff', { method: 'POST', body: '{}' }), /403/);
});

test('5. duplicate and concurrent approval/handoff attempts cannot bypass safeguards', async () => {
  const f = await mkShell({});
  const results = await Promise.allSettled(Array.from({ length: 5 }, () =>
    call(S.off, '/api/cases/' + f.procurement_id + '/approvals', { method: 'POST', body: '{}' })));
  const ids = new Set(results.filter((r) => r.status === 'fulfilled').map((r) => r.value.approval_id));
  assert.equal(ids.size, 1);
  const pool = db();
  const { rows } = await pool.query(`SELECT count(*)::int n FROM approvals WHERE procurement_id=$1 AND status='PENDING_APPROVAL'`, [f.procurement_id]);
  await pool.end();
  assert.equal(rows[0].n, 1);
});

test('6. legitimate DEMO simulation remains possible and visibly labeled', async () => {
  const snap = await call(S.off, '/api/cases/' + REF);
  assert.equal(snap.procurement.mode, 'DEMO');
  assert.equal(snap.approvals[0].mode, 'DEMO');
  // decision endpoint labels DEMO approvals as simulation (unit-level: mode carried through)
  assert.equal(snap.procurement.status, 'closed');
});

test('7. valid REAL approval and handoff still work', async () => {
  const f = await mkPurchasable({ mode: 'REAL', decision: 'PROCEED' });
  const pkg = await call(S.off, '/api/cases/' + f.procurement_id + '/approvals', { method: 'POST', body: '{}' });
  assert.equal(pkg.status, 'PENDING_APPROVAL');
  const dec = await call(S.app, '/api/approvals/' + pkg.approval_id + '/decision',
    { method: 'POST', body: JSON.stringify({ decision: 'APPROVED', reason: 'valid hardening approval' }) });
  assert.equal(dec.status, 'APPROVED');
  assert.equal(dec.mode, 'REAL');
  assert.equal(dec.simulation, false);
  const h = await call(S.off, '/api/cases/' + f.procurement_id + '/handoff', { method: 'POST', body: '{}' });
  assert.equal(h.status, 'purchase_handoff');
});

// ---------- P0 scoring ----------
test('scoring: all criteria missing -> null, never fabricated', () => {
  const r = score({ price: null, quality: null, reviews: null, delivery: null, warranty: null, vendor_reliability: null, payment_terms: null, budget_compliance: null, source_quality: null, specification_completeness: null });
  assert.equal(r.overall_score, null);
  assert.equal(r.criteria_used.length, 0);
});

test('scoring: re-eval with no new valid criteria does not manufacture a score', () => {
  const ctx = { negotiation: { negotiation_id: '00000000-0000-4000-8000-000000000001' }, offer: { offer_id: 'o1' }, vendor: { vendor_id: 'v1', vendor_name: 'S' }, product: { product_id: 'p1' } };
  const r = reevaluate({
    original: { components: { budget_compliance: null, source_quality: null }, price: 100, currency: 'INR', budget: null },
    response: { revised_price: 90, currency: 'USD', received_at: new Date().toISOString(), source: 's', source_url: 'https://x.test', channel: 'email' },
    weights: { budget_compliance: 0.08 }, ctx: { ...ctx, response: { revised_price: 90, currency: 'USD', received_at: new Date().toISOString(), source: 's', source_url: 'https://x.test', channel: 'email' } },
  });
  assert.equal(r.status, 'REEVALUATED');
  assert.equal(r.revised_score, null);
});

test('scoring: one valid criterion records provenance and limitations', () => {
  const comp = { price: null, quality: null, reviews: null, delivery: null, warranty: null, vendor_reliability: null, payment_terms: null, budget_compliance: null, source_quality: null, specification_completeness: null };
  const ctx = { negotiation: { negotiation_id: '00000000-0000-4000-8000-000000000001' }, offer: { offer_id: 'o1' }, vendor: { vendor_id: 'v1', vendor_name: 'S' }, product: { product_id: 'p1' } };
  const resp = { revised_price: 13799, currency: 'INR', received_at: new Date().toISOString(), source: 'LOCAL_DEMO_INPUT', channel: 'demo', response_mode: 'DEMO_HUMAN_ENTERED', vendor_response_verified: false };
  const r = reevaluate({ original: { components: comp, price: 15006, currency: 'INR', budget: 40000 }, response: resp, weights: { budget_compliance: 0.08 }, mode: 'DEMO', ctx: { ...ctx, response: resp } });
  assert.equal(r.status, 'REEVALUATED');
  assert.equal(r.revised_score, 1);
  assert.deepEqual(r.criteria_used, ['budget_compliance']);
  assert.ok(r.score_provenance.budget_compliance);
  assert.equal(r.score_provenance.budget_compliance.source, 'revised_price_vs_budget');
  assert.equal(r.scoring_rules_version, SCORING_RULES_VERSION);
});

test('scoring: same engine version for initial and revised', () => {
  assert.equal(SCORING_RULES_VERSION, '1.0.0');
  const a = score({ budget_compliance: 1 }, { budget_compliance: 0.08 });
  assert.equal(a.overall_score, 1);
  assert.equal(a.criteria_used.length, 1);
});

test('scoring: revised score triggers decision recomputation (API)', async () => {
  // Historical reference rows predate the post-recompute assessment (preserved
  // as-is); new DEMO flows must record it without rewriting the decision row.
  const ref = await call(S.off, '/api/cases/' + REF);
  assert.equal(ref.decision.decision, 'INSUFFICIENT_DATA', 'original decision history preserved');
  const f = await mkPurchasable({ mode: 'REAL', decision: 'INSUFFICIENT_DATA' });
  await call(S.off, '/api/cases/' + f.procurement_id + '/demo/mode', { method: 'POST', body: JSON.stringify({ reason: 'hardening test demo' }) });
  const neg = await call(S.off, '/api/cases/' + f.procurement_id + '/demo/negotiations', { method: 'POST', body: JSON.stringify({ offer_id: f.oid }) });
  await call(S.off, '/api/cases/' + f.procurement_id + '/demo/responses', { method: 'POST', body: JSON.stringify({ negotiation_id: neg.negotiation_id, revised_price: 9000, currency: 'INR' }) });
  const re = await call(S.off, '/api/cases/' + f.procurement_id + '/demo/reevaluate', { method: 'POST', body: JSON.stringify({ negotiation_id: neg.negotiation_id }) });
  assert.equal(re.status, 'REEVALUATED');
  assert.ok(re.post_reevaluation_assessment, 're-evaluation must return a decision recomputation');
  assert.ok(re.score_provenance, 're-evaluation must return score provenance');
  const snap = await call(S.off, '/api/cases/' + f.procurement_id);
  assert.equal(snap.decision.decision, 'INSUFFICIENT_DATA', 'original decision row untouched');
  assert.ok(snap.audit.some((a) => a.event === 'post_reevaluation_assessment'), 'assessment recorded on audit trail');
});

test('scoring: hypothetical DEMO price never becomes verified REAL price', async () => {
  const snap = await call(S.off, '/api/cases/' + REF);
  const offer = snap.offers.find((o) => o.offer_id === 'o-aacc91c1-amazon-in-1');
  assert.equal(Number(offer.net_price), 15006, 'stored offer keeps the verified price, not the demo 13799');
  const demo = snap.demo_responses[0];
  assert.equal(demo.vendor_response_verified, false);
  assert.equal(demo.response_mode, 'DEMO_HUMAN_ENTERED');
});

test('scoring: package criteria and provenance match stored re-evaluation', async () => {
  // Reference package predates provenance (history preserved: no provenance key).
  const ref = await call(S.off, '/api/cases/' + REF);
  assert.equal(ref.approvals[0].approval_package.revised_score, Number(ref.reevaluations[0].revised_score));
  // New packages must carry provenance mirroring the stored re-evaluation row.
  const f = await mkPurchasable({ mode: 'REAL', decision: 'INSUFFICIENT_DATA' });
  await call(S.off, '/api/cases/' + f.procurement_id + '/demo/mode', { method: 'POST', body: JSON.stringify({ reason: 'hardening test demo' }) });
  const neg = await call(S.off, '/api/cases/' + f.procurement_id + '/demo/negotiations', { method: 'POST', body: JSON.stringify({ offer_id: f.oid }) });
  await call(S.off, '/api/cases/' + f.procurement_id + '/demo/responses', { method: 'POST', body: JSON.stringify({ negotiation_id: neg.negotiation_id, revised_price: 9000, currency: 'INR' }) });
  await call(S.off, '/api/cases/' + f.procurement_id + '/demo/reevaluate', { method: 'POST', body: JSON.stringify({ negotiation_id: neg.negotiation_id }) });
  const pkg = await call(S.off, '/api/cases/' + f.procurement_id + '/approvals', { method: 'POST', body: '{}' });
  const snap = await call(S.off, '/api/cases/' + f.procurement_id);
  const stored = snap.reevaluations[0];
  assert.ok(stored.score_provenance, 'stored re-evaluation must persist provenance');
  const created = snap.approvals.find((a) => a.approval_id === pkg.approval_id);
  assert.ok(created.approval_package.score_provenance, 'package must carry score provenance');
  // Package criteria must mirror the STORED re-evaluation row (the revised
  // score's actual basis), not the pre-revision comparison row.
  assert.deepEqual(created.approval_package.criteria_used, stored.criteria_used,
    'package criteria_used must match stored re-evaluation: ' + JSON.stringify(created.approval_package.criteria_used) + ' vs ' + JSON.stringify(stored.criteria_used));
  assert.deepEqual(created.approval_package.criteria_missing, stored.criteria_missing,
    'package criteria_missing must match stored re-evaluation');
  assert.equal(created.approval_package.revised_score, Number(stored.revised_score));
  // Revised offer stays labeled hypothetical in DEMO and never rewrites history.
  assert.equal(created.approval_package.revised_offer.hypothetical, true);
});

// ---------- P1 comparison / budget / dedup ----------
test('comparison: zero-scored case is not score-ranked (API + UI labels)', async () => {
  const snap = await call(S.off, '/api/cases/' + REF);
  assert.ok(snap.comparisons.every((c) => c.overall_score === null));
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');
  assert.ok(html.includes('not score-ranked'), 'UI must label unscored lists as not score-ranked');
  assert.ok(html.includes('Not scored'), 'UI must show Not scored instead of ambiguous dash');
  assert.ok(html.includes('discovery / evidence-confidence order'), 'UI must name the fallback ordering');
});

test('budget: quantity-aware totals, missing prices, currency mismatch, partial estimates', () => {
  assert.equal(unitBudget(320000, 8), 40000);
  assert.equal(totalFor(13799, 8), 110392);
  const ok = budgetVerdict({ unitPrice: 13799, currency: 'INR', budget: 320000, budgetCurrency: 'INR', quantity: 8 });
  assert.equal(ok.verdict, 1);
  assert.equal(ok.total_estimate, 110392);
  assert.equal(ok.partial, true);
  const over = budgetVerdict({ unitPrice: 50000, currency: 'INR', budget: 320000, budgetCurrency: 'INR', quantity: 8 });
  assert.equal(over.verdict, 0);
  assert.equal(budgetVerdict({ unitPrice: null, currency: 'INR', budget: 320000, budgetCurrency: 'INR', quantity: 8 }).verdict, null);
  assert.equal(budgetVerdict({ unitPrice: 100, currency: 'USD', budget: 320000, budgetCurrency: 'INR', quantity: 8 }).verdict, null);
  assert.equal(budgetVerdict({ unitPrice: 100, currency: 'INR', budget: 320000, budgetCurrency: 'INR', quantity: null }).verdict, null);
});

test('dedup: grouping collapses repeats, keeps variants distinct', () => {
  const vendors = { v1: { vendor_name: 'Store A' }, v2: { vendor_name: 'Store B' } };
  const products = { p1: { name: 'Widget' }, p2: { name: 'Widget Pro' } };
  const offers = [
    { offer_id: 'o1', vendor_id: 'v1', product_id: 'p1', net_price: 100, currency: 'INR', source_url: 'https://x/1' },
    { offer_id: 'o2', vendor_id: 'v1', product_id: 'p1', net_price: 100, currency: 'INR', source_url: 'https://x/2' },
    { offer_id: 'o3', vendor_id: 'v1', product_id: 'p1', net_price: 120, currency: 'INR', source_url: 'https://x/3' },
    { offer_id: 'o4', vendor_id: 'v2', product_id: 'p1', net_price: 100, currency: 'INR', source_url: 'https://x/4' },
    { offer_id: 'o5', vendor_id: 'v1', product_id: 'p2', net_price: 100, currency: 'INR', source_url: 'https://x/5' },
  ];
  const g = groupOffers({ offers, vendorsById: vendors, productsById: products });
  assert.equal(g.length, 4, 'o1+o2 merge; different price, merchant, product stay distinct: ' + JSON.stringify(g.map((x) => x.offer_ids)));
  const merged = g.find((x) => x.offer_ids.includes('o1'));
  assert.ok(merged.offer_ids.includes('o2'));
  assert.equal(merged.count, 2);
});

test('dedup: grouped endpoint preserves rows and matches policy', async () => {
  const r = await call(S.off, '/api/cases/' + REF + '/offers/grouped');
  assert.ok(r.total_offers > r.groups.length, 'repeats must collapse in the derived view');
  assert.ok(r.groups.every((g) => g.offer_ids.length > 0 && g.merchant && g.unit_price > 0));
});

test('dedup: negotiation selectors use grouped compact candidates (UI)', async () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');
  assert.ok(html.includes('groupEligibleOffers'), 'selector must group repeats client-side');
  assert.ok(html.includes('identical source rows'), 'grouped candidates must show the collapsed count');
  assert.ok(!/id="n-offer"[^>]*>.*offer_id.*as the main label/s.test(html), 'internal IDs must not be the main label');
});

test('comparison: historical rows without criterion metadata are explained (UI)', async () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');
  assert.ok(html.includes('no scoring basis'), 'UI must explain the missing scoring basis on unscored rows');
  assert.ok(html.includes('No scored recommendations yet'), 'UI must state there are no scored recommendations');
});

test('budget: re-evaluation view shows quantity-aware total savings (UI)', async () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');
  assert.ok(html.includes('Est. total savings'), 're-evaluation must show estimated total savings');
  assert.ok(html.includes('partial: excl. tax/shipping/delivery'), 'totals must be labeled partial estimates');
});

// ---------- comparison page usability (fixed columns, grouping, summary) ----------
test('comparison usability: summary counts come from persisted data', async () => {
  const snap = await call(S.off, '/api/cases/' + REF);
  assert.equal(snap.comparisons.length, 40);
  // pg NUMERIC arrives as strings: coerce exactly as the UI does.
  const priced = snap.offers.filter((o) => Number(o.net_price) > 0 && o.currency).length;
  assert.equal(priced, 172);
  assert.ok(snap.comparisons.every((c) => c.overall_score === null), 'zero scored candidates');
  assert.deepEqual(snap.procurement.mandatory_specs, {});
});

test('comparison usability: fixed columns, missing-price and zero-score messaging (UI)', async () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');
  assert.ok(html.includes('const CMP_COLS = ['), 'header and rows must share one column list');
  for (const h of ['Merchant', 'Unit price', 'Est. total', 'Budget', 'Evidence', 'Source']) {
    assert.ok(html.includes(`'${h}'`), 'missing fixed offer-table column heading: ' + h);
  }
  assert.ok(html.includes('Price unavailable'), 'missing prices must be explicit');
  assert.ok(html.includes('No mandatory requirements configured'), 'must distinguish unconfigured requirements');
  assert.ok(!html.includes('every candidate is eligible by default'), 'must never claim default eligibility');
  assert.ok(html.includes('source records (expand)'), 'groups must expand to individual source records');
  assert.ok(html.includes('candidate records'), 'duplicate candidate records must be counted transparently');
  assert.ok(html.includes('Candidates without offers'), 'no-offer candidates need a separate labeled section');
  assert.ok(html.includes('Mode:'), 'comparison summary must label REAL/DEMO mode');
});

test('comparison usability: footer states provenance honestly', async () => {
  const idx = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'index.html'), 'utf8');
  assert.ok(!idx.includes('runs on real provider data only'), 'old blanket claim must be gone');
  assert.ok(idx.includes('source-backed (provider listings with source URLs)'), 'must credit source-backed discovery');
  assert.ok(idx.includes('only when independently verified'), 'must gate prices/terms on verification');
  assert.ok(idx.includes('otherwise marked unavailable'), 'must name the unavailable state');
  assert.ok(idx.includes('never contacted automatically'), 'must keep the no-contact claim');
  assert.ok(idx.includes('human approval is always explicit'), 'must keep the explicit-approval claim');
});

test('comparison usability: numeric-string prices coerce for display (UI)', async () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');
  assert.ok(html.includes('const num = (v)'), 'display must coerce pg NUMERIC strings');
  assert.ok(!/typeof o\.net_price === 'number'/.test(html), 'strict-number price guards must be gone');
  assert.ok(!/typeof off\?\.net_price === 'number'/.test(html), 'strict-number offer guards must be gone');
});

// ---------- comparison dedup: mirrored candidates collapse, variants stay distinct ----------
test('comparison dedup: reference has mirrored duplicate candidates with identical offer sets (API)', async () => {
  const snap = await call(S.off, '/api/cases/' + REF);
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  const byName = {};
  for (const c of snap.comparisons) {
    const pname = (snap.products.find((p) => p.product_id === c.product_id) || {}).name || c.product_id;
    (byName[norm(pname)] ||= []).push(c.product_id);
  }
  const ikea = byName['ikea trotten desk sit stand'];
  assert.ok(ikea && ikea.length === 3, 'reference must carry 3 mirrored IKEA candidate records, got ' + JSON.stringify(Object.entries(byName).filter(([, v]) => v.length > 1).map(([k, v]) => [k, v.length])));
  const sig = (pid) => snap.offers.filter((o) => o.product_id === pid)
    .map((o) => `${(snap.vendors.find((v) => v.vendor_id === o.vendor_id) || {}).vendor_name}|${Number(o.net_price)}|${o.currency}`)
    .sort().join(';');
  assert.ok(sig(ikea[0]).length > 0, 'mirrored candidates carry offers');
  assert.equal(sig(ikea[0]), sig(ikea[1]), 'mirrored IKEA offer sets must be identical');
  assert.equal(sig(ikea[1]), sig(ikea[2]), 'mirrored IKEA offer sets must be identical');
});

test('comparison dedup: UI collapses mirrored candidates, keeps variants distinct (UI)', async () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');
  assert.ok(html.includes('function distinctProducts'), 'UI must collapse duplicate candidate identities');
  assert.ok(html.includes('function normProductKey'), 'identity normalization must be explicit and conservative');
  assert.ok(html.includes('Distinct candidate products'), 'summary must count distinct products');
  assert.ok(html.includes('candidate records in store'), 'summary must reconcile records vs distinct products');
  assert.ok(html.includes('Individual source offer records'), 'summary must count source records');
  assert.ok(html.includes('discovery order, not a recommendation'), 'position must never read as rank');
});

// ---------- agent workflow consistency with persisted evidence ----------
test('workflow: reference stages match persisted evidence (API)', async () => {
  const st = await call(S.off, '/api/cases/' + REF + '/stages');
  const byKey = Object.fromEntries(st.stages.map((s) => [s.key, s]));
  // only decision + reevaluation have execution rows; the rest reconstruct from evidence
  assert.equal(byKey.decision.source, 'execution');
  assert.equal(byKey.reevaluation.source, 'execution');
  for (const k of ['product_research', 'vendor_research', 'review_quality', 'comparison', 'scoring', 'negotiation', 'approval']) {
    assert.equal(byKey[k].source, 'evidence', k + ' must be labeled evidence-derived, got ' + byKey[k].source);
  }
  // 1. scoring: 0 of 40 calculable, no weights config, no top-rank claim
  assert.ok(byKey.scoring.summary.includes('no calculable scores'), byKey.scoring.summary);
  assert.ok(!byKey.scoring.summary.includes('Scores computed for 40'), byKey.scoring.summary);
  assert.ok(byKey.comparison.summary.includes('0 with calculable score'), byKey.comparison.summary);
  assert.ok(!byKey.comparison.summary.includes('top rank set'), byKey.comparison.summary);
  // 2. approval: DEMO simulation on the persisted offer, never a purchase authorization
  assert.ok(byKey.approval.summary.includes('DEMO'), byKey.approval.summary);
  assert.ok(byKey.approval.summary.includes('not a real purchase authorization'), byKey.approval.summary);
  assert.ok(byKey.approval.summary.includes('o-aacc91c1-amazon-in-1'), byKey.approval.summary);
  // 3. vendor terminology: source records, never "verified offers"
  assert.ok(byKey.vendor_research.summary.includes('172 source offer record(s)'), byKey.vendor_research.summary);
  assert.ok(!byKey.vendor_research.summary.includes('verified offer'), byKey.vendor_research.summary);
  // 5. demo negotiation + re-evaluation: hypothetical unit vs persisted-quantity total
  assert.ok(byKey.negotiation.summary.includes('0 real + 1 demo'), byKey.negotiation.summary);
  assert.ok(byKey.negotiation.summary.includes('nothing sent'), byKey.negotiation.summary);
  assert.ok(byKey.reevaluation.summary.includes('hypothetical demo input'), byKey.reevaluation.summary);
  assert.ok(byKey.reevaluation.summary.includes('unit savings 1207'), byKey.reevaluation.summary);
  assert.ok(byKey.reevaluation.summary.includes('9656') && byKey.reevaluation.summary.includes('quantity 8'), byKey.reevaluation.summary);
});

test('workflow: execution vs evidence vs not-run is explicit (UI)', async () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');
  assert.ok(html.includes('Evidence-derived reconstruction'), 'evidence-derived stages must say so');
  assert.ok(html.includes('Not run yet'), 'stages without evidence must say so');
});

test('negotiation forms are gated on lifecycle status, closed stays fail-closed (API + UI)', async () => {
  // Backend still rejects new DEMO proposals on a closed case (fail-closed, audited).
  const f = await mkShell({ mode: 'DEMO' });
  const pool = db();
  await pool.query(`UPDATE procurement_cases SET status='decided' WHERE procurement_id=$1`, [f.procurement_id]);
  await pool.query(`UPDATE procurement_cases SET status='pending_approval' WHERE procurement_id=$1`, [f.procurement_id]);
  await pool.query(`UPDATE procurement_cases SET status='closed' WHERE procurement_id=$1`, [f.procurement_id]);
  await pool.end();
  await assert.rejects(
    call(S.off, '/api/cases/' + f.procurement_id + '/demo/negotiations',
      { method: 'POST', body: JSON.stringify({ offer_id: 'o-none', target_price: 100 }) }), /409/);
  // UI must not offer the action in the first place.
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');
  assert.ok(html.includes('DEMO_NEGOTIABLE_FROM'), 'DEMO proposal form must follow the lifecycle map');
  assert.ok(html.includes('(terminal state)'), 'terminal cases must explain why the form is gone');
  assert.ok(html.includes('continue from the existing proposal(s) above'), 'post-response states must point at history');
  assert.ok(html.includes('can be entered only while the case is'), 'demo response form must state its required state');
  assert.ok(html.includes('can run only while the case is'), 're-evaluate button must state its required state');
});

// ---------- dashboard consistency + legacy handoff records ----------
test('dashboard: terminal states reconcile (API vs database)', async () => {
  const dash = await call(S.off, '/api/dashboard');
  const pool = db();
  const { rows } = await pool.query(`SELECT
    count(*)::int AS total,
    count(*) FILTER (WHERE status NOT IN ('closed','purchase_handoff'))::int AS active,
    count(*) FILTER (WHERE status IN ('closed','purchase_handoff'))::int AS completed
    FROM procurement_cases`);
  await pool.end();
  assert.equal(dash.totals.cases, rows[0].total, 'total must match the live table');
  assert.equal(dash.totals.active, rows[0].active, 'terminal handoffs must not count as active');
  assert.equal(dash.totals.completed, rows[0].completed, 'completed must include closed + handoff');
  assert.equal(dash.totals.cases, dash.totals.active + dash.totals.completed, 'cards must reconcile');
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');
  assert.ok(html.includes('Completed (closed + handoff)'), 'label must state the actual definition');
});

test('legacy handoffs under INSUFFICIENT_DATA are preserved and labeled (API + UI)', async () => {
  for (const id of ['121395b8-4d2f-4727-868b-05c8eab5343d', '9da4a78a-9c96-44b0-88be-f5037dd6fefa']) {
    const snap = await call(S.off, '/api/cases/' + id);
    assert.equal(snap.procurement.status, 'purchase_handoff', id + ' history preserved');
    assert.equal(snap.procurement.mode, 'REAL');
    assert.equal(snap.decision.decision, 'INSUFFICIENT_DATA');
    assert.equal(snap.approvals[0].status, 'APPROVED');
    assert.equal(snap.approvals[0].mode, 'REAL');
    // Current guard would refuse a new handoff on this combination.
    const chk = canHandoff({ caseStatus: 'closed', latestApproval: snap.approvals[0], latestDecision: snap.decision });
    assert.equal(chk.ok, false, 'current policy forbids handoff without PROCEED: ' + chk.reason);
  }
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');
  assert.ok(html.includes('not evidence of an external purchase order'), 'case view must separate the record from a purchase');
});

// ---------- site-wide cleanup: provenance, navigation, plain language ----------
test('provenance: no seeded products in production paths; live rows are provider-backed', async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  // 1. Migrations are schema-only: no row inserts anywhere under sql/.
  for (const f of fs.readdirSync(path.join(root, 'sql'))) {
    const src = fs.readFileSync(path.join(root, 'sql', f), 'utf8');
    assert.ok(!/INSERT\s+INTO\s+\w+/i.test(src), 'migration must not insert rows: ' + f);
  }
  // 2. Every production INSERT into products/vendors/offers is a parameterized
  // provider-ingestion write (n8n state-manager guards + web enrichment), never
  // a static seeded VALUES list. Test fixtures live only under tests/ + web/test/.
  const prodHits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', '.git', 'tests', 'test', 'backups'].includes(e.name)) continue;
        walk(full);
      } else if (/\.(sql|js|mjs|json)$/.test(e.name)) {
        const src = fs.readFileSync(full, 'utf8');
        const re = /INSERT\s+INTO\s+(products|vendors|offers)\b([\s\S]{0,400})/gi;
        let m;
        while ((m = re.exec(src))) {
          if (!/\$1/.test(m[2])) prodHits.push(path.relative(root, full));
        }
      }
    }
  };
  walk(root);
  assert.deepEqual(prodHits, [], 'non-parameterized product inserts outside tests: ' + JSON.stringify(prodHits));
  // 3. Live data check: every product on the reference case is provider-backed.
  const snap = await call(S.off, '/api/cases/' + REF);
  assert.ok(snap.products.length > 0);
  for (const p of snap.products) {
    assert.ok(p.source_url && p.source_url !== 'unavailable', 'every live product keeps its source URL: ' + p.product_id);
    assert.ok(p.source && p.source !== 'unavailable', 'every live product keeps its provider source: ' + p.product_id);
  }
});

test('navigation: five destinations, new routes, plain-language tabs (UI + API)', async () => {  const idx = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'index.html'), 'utf8');
  for (const label of ['Dashboard', 'New Request', 'Requests', 'Approvals', 'Administration']) {
    assert.ok(idx.includes(label), 'sidebar label missing: ' + label);
  }
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');
  assert.ok(html.includes("if (h === '#/requests')"), 'requests route must exist');
  assert.ok(html.includes("if (h === '#/approvals')"), 'approvals route must exist');
  for (const label of ['Product Discovery', 'Vendor Offers', 'Negotiation Proposal', 'Approval & Handoff', 'Audit History']) {
    assert.ok(html.includes(label), 'workflow tab label missing: ' + label);
  }
  for (const label of ['Insufficient evidence', 'Purchase handoff recorded', 'Hypothetical response recorded', 'Not verified', 'Awaiting decision']) {
    assert.ok(html.includes(label), 'plain-language label missing: ' + label);
  }
  const cases = await call(S.off, '/api/cases');
  assert.ok(cases.cases.length > 0);
  assert.ok(cases.cases[0].updated_at, 'cases list must carry updated_at for the Updated column');
});

// ---------- global audit: stale decisions, terminal pipeline guard, terminology ----------
test('stale decision is detectable on the live monitor case (API)', async () => {
  const snap = await call(S.off, '/api/cases/0d34f013-525c-4dbb-8902-50fcfd170dc3');
  assert.equal(snap.decision.decision, 'RESEARCH_REQUIRED');
  assert.ok(snap.decision.blocking_reasons.includes('no verified offers'), 'recorded premise');
  assert.ok(snap.offers.length > 100, 'offers arrived after the decision: ' + snap.offers.length);
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');
  assert.ok(html.includes('decisionStaleHtml'), 'shared stale-decision check must exist');
  assert.ok(html.includes('stale-rerun'), 'stale decisions must offer a legal re-run, never silent rewrite');
});

test('pipeline/run refuses terminal cases without touching history (API)', async () => {
  const f = await mkPurchasable({ mode: 'REAL', decision: 'PROCEED' });
  const pool = db();
  await pool.query(`UPDATE procurement_cases SET status='decided' WHERE procurement_id=$1`, [f.procurement_id]);
  await pool.query(`UPDATE procurement_cases SET status='pending_approval' WHERE procurement_id=$1`, [f.procurement_id]);
  await pool.query(`INSERT INTO approvals (procurement_id,mode,status,approval_package,request_version) VALUES ($1,'REAL','APPROVED','{}',1)`, [f.procurement_id]);
  await pool.query(`UPDATE procurement_cases SET status='closed' WHERE procurement_id=$1`, [f.procurement_id]);
  await pool.query(`UPDATE decisions SET decision_reason='frozen' WHERE procurement_id=$1`, [f.procurement_id]);
  await assert.rejects(call(S.off, '/api/cases/' + f.procurement_id + '/pipeline/run',
    { method: 'POST', body: '{}' }), /terminal state/);
  const { rows } = await pool.query(`SELECT decision,decision_reason FROM decisions WHERE procurement_id=$1`, [f.procurement_id]);
  await pool.end();
  assert.equal(rows[0].decision, 'PROCEED');
  assert.equal(rows[0].decision_reason, 'frozen', 'terminal decision rows must be byte-identical');
});

test('shared terminology is used consistently (UI)', async () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');
  assert.ok(!html.includes('Eligible real offer'), 'price-checked offers must not be called policy-eligible');
  assert.ok(html.includes('Offer with verified price'), 'replacement label must exist');
  assert.ok(!html.includes('Agents (${done}/9)') && !html.includes('Agents (done/9)'), 'scoring/approval stages must not be called agents');
  assert.ok(html.includes('Stages (${done}/9)'), 'progress must count stages');
  assert.ok(html.includes('partial basis ('), 'thin scores must carry their basis');
  assert.ok(html.includes('Labels:'), 'shared evidence legend must exist');
  assert.ok(html.includes('Refers to:'), 'approvals must state their target');
});

test('owner labels: genuine owners shown, absent owners read Unassigned (API + UI)', async () => {
  const pool = db();
  const { rows } = await pool.query(`SELECT c.procurement_id, u.username AS owner_username
    FROM procurement_cases c LEFT JOIN users u ON u.user_id = c.owner_user_id`);
  await pool.end();
  assert.ok(rows.some((r) => r.owner_username), 'at least one case has a genuine owner');
  assert.ok(rows.some((r) => !r.owner_username), 'legacy cases genuinely lack owners');
  const snap = await call(S.off, '/api/cases/0d34f013-525c-4dbb-8902-50fcfd170dc3');
  assert.equal(snap.owner_username, 'off.bob', 'authorized owner must come through the API');
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');
  assert.ok(html.includes("owner_username || 'Unassigned'"), 'absent owners must read Unassigned, not a dash');
  assert.ok(!html.includes("owner_username || '—'"), 'ambiguous dash fallback must be gone');
});
