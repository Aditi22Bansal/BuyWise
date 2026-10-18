// BuyWise render tests: evaluate the real browser bundle with DOM stubs and a
// stubbed API, then assert the rendered structure (navigation, dashboard,
// gating). No network, no database, no mocks of business logic — the
// production code paths run unchanged.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const dummyEl = () => ({ textContent: '', innerHTML: '', className: '', style: {}, dataset: {},
  classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, appendChild() {},
  querySelectorAll: () => [], querySelector: () => null, focus: () => {} });
let appHtml = '';
let extraHtml = '';
const els = {};
function docStub() {
  return {
    getElementById: (id) => {
      if (id === 'app') return { set innerHTML(v) { appHtml = v; }, get innerHTML() { return appHtml; } };
      if (!els[id]) {
        let held = '';
        els[id] = { ...dummyEl(), set innerHTML(v) { held = v; extraHtml += '\n' + v; }, get innerHTML() { return held; } };
      }
      return els[id];
    },
    activeElement: null, querySelectorAll: () => [], createElement: () => dummyEl(),
  };
}
const allHtml = () => appHtml + extraHtml;
const dashFixture = {
  totals: { cases: 3, active: 1, completed: 2, awaiting_approval: 1 },
  recent_runs: [
    { procurement_id: '11111111-1111-4111-8111-111111111111', requirement: 'Test widgets', status: 'decided', mode: 'REAL', owner_username: 'off', decision: 'INSUFFICIENT_DATA', created_at: '2026-10-09T00:00:00Z', updated_at: '2026-10-09T01:00:00Z' },
  ],
  recent_executions: [], recent_decisions: [],
};
const routes = {
  '/api/me': { user: { username: 'off', role: 'officer', canCreate: true, canRunPipeline: true, canDemo: true, canApprove: false, canAdmin: false }, csrf: 'x' },
  '/api/health': { ok: true },
  '/api/dashboard': dashFixture,
  '/api/providers': { tavily: { configured: false }, serpapi: { configured: true }, n8n: { reachable: true, latency_ms: 3 } },
  '/api/reasoning-mode': { mode: 'LLM_UNAVAILABLE' },
  '/api/approvals/pending': { pending: [] },
  '/api/cases': { cases: dashFixture.recent_runs },
};
function fetchStub(url) {
  const u = String(url).split('?')[0];
  const data = routes[u] ?? {};
  return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => data });
}
let T = null;
before(async () => {
  globalThis.document = docStub();
  globalThis.window = { addEventListener() {} };
  globalThis.location = { hash: '#/' };
  globalThis.fetch = fetchStub;
  const src = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
  (0, eval)(src + '\n;globalThis.__T = { tabNegotiation, tabComparison, tabProducts, tabVendors, tabQuality, tabDecision, tabApproval, viewRequests, viewApprovals, route };');  T = globalThis.__T;
  await new Promise((r) => setTimeout(r, 50)); // let auto-route settle on #/
  delete globalThis.__T;
});

test('dashboard renders linked cards, aligned table, honest providers', () => {
  const html = allHtml();
  assert.ok(html.includes('href="#/requests"'), 'metric cards must link somewhere meaningful');
  assert.ok(html.includes('href="#/approvals"'), 'approval card must link to approvals');
  for (const h of ['<th>Request</th>', '<th>Reference</th>', '<th>Status</th>', '<th>Mode</th>', '<th>Owner</th>', '<th>Decision</th>', '<th>Updated</th>']) {
    assert.ok(html.includes(h), 'dashboard table heading missing: ' + h);
  }
  assert.ok(!html.includes('>11111111-1111-4111-8111-111111111111<'), 'full UUIDs must not be displayed as primary labels (links/copy payloads may carry them)');
  assert.ok(html.includes('11111111'), 'short reference must be shown');
  assert.ok(html.includes('Copy'), 'short refs need a copy action');
  assert.ok(html.includes('not live-tested'), 'presence-only providers must not claim operation');
  assert.ok(html.includes('tested just now'), 'live-checked n8n must say so');
  assert.ok(!html.includes('nothing is simulated'), 'absolute no-simulation claim must be gone');
});

test('sidebar has five distinct destinations', () => {
  const idx = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  for (const [href, label] of [['#/', 'Dashboard'], ['#/new', 'New Request'], ['#/requests', 'Requests'], ['#/approvals', 'Approvals'], ['#/admin', 'Administration']]) {
    assert.ok(idx.includes(`href="${href}"`), 'nav href missing: ' + href);
    assert.ok(idx.includes(label), 'nav label missing: ' + label);
  }
});

test('new routes render without errors', async () => {
  globalThis.location.hash = '#/requests';
  await T.route();
  assert.ok(appHtml.includes('Requests ('), 'requests view must render, got: ' + appHtml.slice(0, 120));
  assert.ok(appHtml.includes('My requests only'), 'requests view needs the ownership filter');
  globalThis.location.hash = '#/approvals';
  await T.route();
  assert.ok(appHtml.includes('Approvals ('), 'approvals view must render, got: ' + appHtml.slice(0, 120));
  globalThis.location.hash = '#/';
});

test('closed DEMO negotiation shows history, no generation form', () => {
  const snap = {
    procurement: { procurement_id: 'p', requirement: 'r', quantity: 1, budget: 100, currency: 'INR', mode: 'DEMO', status: 'closed', version: 1 },
    products: [], vendors: [], offers: [],
    negotiations: [{ negotiation_id: 'n', mode: 'DEMO', status: 'DEMO_RESPONSE_RECEIVED', offer_id: 'o', vendor_id: 'v', target_price: '90', currency: 'INR', do_not_send: true, human_confirmation: false }],
    comparisons: [], decision: null, reevaluations: [], approvals: [],
  };
  const el = { innerHTML: '' };
  T.tabNegotiation(el, snap);
  assert.ok(!el.innerHTML.includes('id="n-go"'), 'closed case must not offer proposal generation');
  assert.ok(el.innerHTML.includes('Existing proposals (1)'), 'history must stay visible');
});

test('comparison collapses mirrored products, keeps sections', () => {
  const snap = {
    procurement: { procurement_id: 'p', requirement: 'r', quantity: 1, budget: 100, currency: 'INR', mode: 'REAL', status: 'decided', version: 1, mandatory_specs: {} },
    products: [{ product_id: 'a1', name: 'Same Widget' }, { product_id: 'a2', name: 'Same Widget' }],
    vendors: [{ vendor_id: 'v', vendor_name: 'Store' }],
    offers: [
      { offer_id: 'o1', product_id: 'a1', vendor_id: 'v', net_price: '10', currency: 'INR', data_status: 'LIVE', source_url: 'https://x/1', retrieved_at: '2026-10-09T00:00:00Z', delivery_days: 'u', warranty_months: 'u', payment_terms: 'u' },
      { offer_id: 'o2', product_id: 'a2', vendor_id: 'v', net_price: '10', currency: 'INR', data_status: 'LIVE', source_url: 'https://x/2', retrieved_at: '2026-10-09T00:00:00Z', delivery_days: 'u', warranty_months: 'u', payment_terms: 'u' },
    ],
    comparisons: [
      { product_id: 'a1', rank: 1, overall_score: null, criteria_scores: {}, criteria_used: [], criteria_missing: [] },
      { product_id: 'a2', rank: 2, overall_score: null, criteria_scores: {}, criteria_used: [], criteria_missing: [] },
    ],
    eligibility: [], scoring_configs: [{ weights: {}, notes: '' }],
    decision: { decision: 'INSUFFICIENT_DATA', decision_reason: 'thin', blocking_reasons: ['x'] },
    negotiations: [], demo_responses: [], reevaluations: [], approvals: [],
  };
  const el = { innerHTML: '' };
  T.tabComparison(el, snap);
  const titles = [...el.innerHTML.matchAll(/<p><b>([^<]*)<\/b><\/p>/g)].map((m) => m[1]);
  assert.equal(titles.filter((t) => t === 'Same Widget').length, 1, 'mirrored product shown once: ' + JSON.stringify(titles));
  assert.ok(el.innerHTML.includes('Candidates with offers (1)'), 'one distinct product with offers');
  assert.ok(el.innerHTML.includes('Not scored'), 'unscored state explicit');
  assert.ok(!el.innerHTML.includes('₹0'), 'missing values must never render as ₹0');
});

test('empty provider results explain why and what next', () => {
  const empty = {
    procurement: { procurement_id: 'p', requirement: 'r', quantity: 1, budget: 100, currency: 'INR', mode: 'REAL', status: 'created', version: 1 },
    products: [], vendors: [], offers: [], comparisons: [], eligibility: [], scoring_configs: [],
    decision: null, negotiations: [], demo_responses: [], reevaluations: [], approvals: [],
  };
  const { tabProducts, tabVendors, tabQuality, tabDecision } = T;
  for (const [fn, label] of [[tabProducts, 'products'], [tabVendors, 'vendors'], [tabQuality, 'quality'], [tabDecision, 'decision']]) {
    const el = { innerHTML: '' };
    fn(el, empty);
    assert.ok(!el.innerHTML.includes('undefined') && !el.innerHTML.includes('NaN'), label + ' empty state must not leak internals');
    assert.ok(/no .*yet|run the pipeline|research/i.test(el.innerHTML), label + ' empty state must explain next step');
  }
});

const box = () => ({ innerHTML: '', querySelector: () => null, querySelectorAll: () => [] });

test('stale decision is flagged with a legal re-run, never rewritten', () => {  const snap = {
    procurement: { procurement_id: 'p', requirement: 'r', quantity: 6, budget: 180000, currency: 'INR', mode: 'REAL', status: 'decided', version: 1 },
    products: [], vendors: [],
    offers: [{ offer_id: 'o', product_id: 'x', vendor_id: 'v', net_price: '100', currency: 'INR', data_status: 'LIVE', source_url: 'https://x', retrieved_at: '2026-10-09T00:00:00Z', delivery_days: 'u', warranty_months: 'u', payment_terms: 'u' }],
    comparisons: [], eligibility: [], scoring_configs: [],
    decision: { decision: 'RESEARCH_REQUIRED', decision_reason: 'blocked only by fillable gaps', blocking_reasons: ['no verified offers'], criteria_used: [], criteria_missing: [], evidence_urls: [] },
    negotiations: [], demo_responses: [], reevaluations: [], approvals: [],
  };
  const el = box();
  T.tabDecision(el, snap);
  assert.ok(el.innerHTML.includes('outdated'), 'stale premise must be named');
  assert.ok(el.innerHTML.includes('1 source offer record(s)'), 'arrived evidence must be counted');
  assert.ok(el.innerHTML.includes('Why this decision'), 'reasons live in one expandable section');
  const closed = { ...snap, procurement: { ...snap.procurement, status: 'closed' } };
  const el2 = box();
  T.tabDecision(el2, closed);
  assert.ok(!el2.innerHTML.includes('stale-rerun'), 'terminal cases must not offer a re-run');
});

test('thin scores are marked partial with their real basis', () => {
  const snap = {
    procurement: { procurement_id: 'p', requirement: 'r', quantity: 1, budget: 100, currency: 'INR', mode: 'REAL', status: 'decided', version: 1, mandatory_specs: {} },
    products: [{ product_id: 'a', name: 'Widget' }],
    vendors: [{ vendor_id: 'v', vendor_name: 'Store' }],
    offers: [],
    comparisons: [{ product_id: 'a', rank: 1, overall_score: 0.15, criteria_scores: {}, criteria_used: ['source_quality', 'specification_completeness'], criteria_missing: ['price', 'quality', 'reviews', 'delivery', 'warranty', 'vendor_reliability', 'payment_terms', 'budget_compliance'] }],
    eligibility: [], scoring_configs: [{ weights: {}, notes: '' }],
    decision: { decision: 'INSUFFICIENT_DATA', decision_reason: 'thin', blocking_reasons: ['x'], criteria_used: [], criteria_missing: [], evidence_urls: [] },
    negotiations: [], demo_responses: [], reevaluations: [], approvals: [],
  };
  const el = { innerHTML: '' };
  T.tabComparison(el, snap);
  assert.ok(el.innerHTML.includes('partial basis (2 of 10 criteria'), 'thin score must carry its basis: ' + el.innerHTML.slice(0, 200));
  assert.ok(el.innerHTML.includes('not a complete overall evaluation'), 'partial must never read as complete');
});

test('approval states its target and legacy gaps', () => {
  const snap = {
    procurement: { procurement_id: 'p', requirement: 'r', quantity: 1, budget: 100, currency: 'INR', mode: 'REAL', status: 'closed', version: 1 },
    products: [], vendors: [], offers: [], comparisons: [], eligibility: [], scoring_configs: [],
    decision: { decision: 'INSUFFICIENT_DATA', decision_reason: 'x', blocking_reasons: [], criteria_used: [], criteria_missing: [], evidence_urls: [] },
    negotiations: [], demo_responses: [], reevaluations: [],
    approvals: [{ approval_id: 'a', status: 'APPROVED', mode: 'REAL', approved_by: 't', approved_at: '2026-10-09T00:00:00Z', selected_offer_id: 'o-12345678', request_version: 1, scoring_version: null, approval_package: {}, decided_by_user_id: 'u' }],
    approval_events: [],
  };
  const el = box();
  T.tabApproval(el, snap);
  assert.ok(el.innerHTML.includes('Refers to:'), 'approval must state its target');
  assert.ok(el.innerHTML.includes('unrecorded (legacy package)'), 'missing snapshot columns must be labeled, not blank');
});

test('legacy handoff warning is conditional on decision vs policy', () => {
  const base = {
    procurement: { procurement_id: 'p', requirement: 'r', quantity: 1, budget: 100, currency: 'INR', mode: 'REAL', status: 'purchase_handoff', version: 1 },
    products: [], vendors: [], offers: [], comparisons: [], eligibility: [], scoring_configs: [],
    negotiations: [], demo_responses: [], reevaluations: [],
    approvals: [{ approval_id: 'a', status: 'APPROVED', mode: 'REAL', approved_by: 't', approved_at: '2026-10-09T00:00:00Z', selected_offer_id: 'o-1', request_version: 1, scoring_version: '1.0.0', approval_package: {}, decided_by_user_id: 'u' }],
    approval_events: [],
  };
  const flagged = { ...base, decision: { decision: 'INSUFFICIENT_DATA', decision_reason: 'x', blocking_reasons: [], criteria_used: [], criteria_missing: [], evidence_urls: [] } };
  const clean = { ...base, decision: { decision: 'PROCEED', decision_reason: 'ok', blocking_reasons: [], criteria_used: [], criteria_missing: [], evidence_urls: [] } };
  const el1 = box();
  T.tabApproval(el1, flagged);
  assert.ok(el1.innerHTML.includes('not evidence of an external purchase order'), 'legacy conflict must warn');
  const el2 = box();
  T.tabApproval(el2, clean);
  assert.ok(!el2.innerHTML.includes('not evidence of an external purchase order'), 'policy-consistent handoff must not warn');
});
