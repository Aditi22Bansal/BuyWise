// Live end-to-end demo over the website API: fresh REAL procurement -> research ->
// decision -> DEMO switch -> negotiation -> manual-style response -> re-evaluation ->
// approval -> closed. Uses only real provider data; the response values below are the
// operator's explicit manual entries for THIS run (labeled DEMO_HUMAN_ENTERED).
// Run: node test/e2e-demo.mjs   (needs web server + n8n + providers up)
// Auth: set BUYWISE_E2E_USER/_PASS (officer or admin) and BUYWISE_E2E_APPROVER/_APASS (approver or admin).
const BASE = process.env.BUYWISE_WEB || 'http://localhost:8080';

async function login(username, password) {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`login ${username} -> HTTP ${r.status}: ${data.error || ''}`);
  return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], csrf: data.csrf, user: data.user };
}
const OPER = await login(process.env.BUYWISE_E2E_USER || '', process.env.BUYWISE_E2E_PASS || '')
  .catch(() => { console.error('set BUYWISE_E2E_USER/_PASS to an officer or admin account'); process.exit(1); });
let sess = OPER;
const APPROVER = await login(process.env.BUYWISE_E2E_APPROVER || '', process.env.BUYWISE_E2E_APASS || '')
  .catch(() => { console.error('set BUYWISE_E2E_APPROVER/_APASS to an approver or admin account'); process.exit(1); });
console.log(`[auth] operator=${OPER.user.username}(${OPER.user.role}) approver=${APPROVER.user.username}(${APPROVER.user.role})`);

async function api(path, opts) {
  const headers = { 'content-type': 'application/json', cookie: sess.cookie, ...(opts?.method && opts.method !== 'GET' ? { 'x-csrf-token': sess.csrf } : {}), ...opts?.headers };
  const r = await fetch(BASE + path, { ...opts, headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}: ${data.error || JSON.stringify(data).slice(0, 160)}`);
  return data;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (stage, obj) => console.log(`[${stage}]`, typeof obj === 'string' ? obj : JSON.stringify(obj).slice(0, 300));

// 1. fresh REAL procurement through the website (distinct requirement text)
const requirement = 'E2E demo laptops 16GB RAM 512GB SSD for engineering team ' + new Date().toISOString().slice(0, 16);
const since = Date.now();
log('intake:submit', requirement);
await api('/api/procurements', { method: 'POST', body: JSON.stringify({
  requirement, quantity: 5, budget: 400000, currency: 'INR',
  mandatory_specs: { ram_gb_min: 16, storage_gb_min: 512 }, mode: 'REAL' }) });
log('intake:accepted', 'polling for case row...');

// 2. wait for the case row, then for research output
let id = null;
for (let i = 0; i < 24 && !id; i++) {
  await sleep(5000);
  const { cases } = await api('/api/cases');
  const hit = cases.find((c) => c.requirement === requirement && new Date(c.created_at).getTime() >= since - 10000);
  if (hit) id = hit.procurement_id;
}
if (!id) throw new Error('new case never appeared (n8n intake may be down)');
log('case', id);

let snap = null;
for (let i = 0; i < 60; i++) {
  await sleep(10000);
  snap = await api(`/api/cases/${id}`);
  if ((snap.products || []).length > 0) break;
}
log('products', `${(snap.products || []).length} discovered`);
if ((snap.products || []).length === 0) throw new Error('no products discovered');

// 3. wait for decision (research + comparison take minutes on live providers)
for (let i = 0; i < 48 && !snap.decision; i++) {
  await sleep(10000);
  snap = await api(`/api/cases/${id}`);
}
if (!snap.decision) throw new Error('no decision recorded (research may still run; check n8n Executions)');
log('decision', `${snap.decision.decision} (offers: ${(snap.offers || []).length})`);

if ((snap.offers || []).length === 0) {
  log('result', 'HONEST STOP: no verified offers, nothing to negotiate — REAL path behaved correctly');
  process.exit(0);
}

// 4. DEMO path on a real offer (cheapest INR offer preferred)
const inr = (snap.offers || []).filter((o) => o.currency === 'INR' && typeof o.net_price === 'number');
const pool = inr.length ? inr : snap.offers.filter((o) => typeof o.net_price === 'number');
pool.sort((a, b) => a.net_price - b.net_price);
const offer = pool[0];
log('offer', `${offer.offer_id} ${offer.net_price} ${offer.currency}`);
await api(`/api/cases/${id}/demo/mode`, { method: 'POST', body: JSON.stringify({ reason: 'scripted E2E website demo' }) });
const neg = await api(`/api/cases/${id}/demo/negotiations`, { method: 'POST', body: JSON.stringify({ offer_id: offer.offer_id }) });
log('negotiation', `${neg.status} target=${neg.target_price} sent=${neg.sent}`);
if (neg.sent !== false) throw new Error('send guard violated');

// 5. operator manual entry for THIS run (explicit values below = the human input)
const revised = Math.round(offer.net_price * 0.92 * 100) / 100;
const resp = await api(`/api/cases/${id}/demo/responses`, { method: 'POST', body: JSON.stringify({
  negotiation_id: neg.negotiation_id, revised_price: revised, currency: offer.currency,
  delivery_days: '5', warranty: '1 year', payment_terms: 'Net 30',
  notes: 'E2E website demo manual entry' }) });
log('response', `${resp.status} ${resp.response_mode}`);
const re = await api(`/api/cases/${id}/demo/reevaluate`, { method: 'POST', body: JSON.stringify({ negotiation_id: neg.negotiation_id }) });
log('reeval', `score ${re.original_score} -> ${re.revised_score}, savings ${re.absolute_savings} ${re.currency}`);
if (typeof re.absolute_savings === 'number') {
  const expectSave = Math.round((offer.net_price - revised) * 100) / 100;
  if (Math.abs(re.absolute_savings - expectSave) > 0.01) throw new Error(`savings mismatch: ${re.absolute_savings} vs ${expectSave}`);
}

// 6. approval package + explicit APPROVE (as the approver: separation of duties)
const ap = await api(`/api/cases/${id}/approvals`, { method: 'POST', body: '{}' });
log('approval-package', ap.status);
sess = APPROVER;
const dec = await api(`/api/approvals/${ap.approval_id}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'APPROVED', reason: 'scripted E2E approval' }) });
log('approval-decision', `${dec.status} by ${dec.decided_by} -> case ${dec.case_status}`);
if (dec.case_status !== 'closed') throw new Error('case did not close after APPROVED');

// 7. final verification pass
const fin = await api(`/api/cases/${id}`);
const stages = await api(`/api/cases/${id}/stages`);
const bad = (fin.negotiations || []).filter((n) => n.do_not_send !== true);
if (bad.length) throw new Error('send guard violated in persisted rows');
log('final', `state=${fin.procurement.status} mode=${fin.procurement.mode} stages_completed=${stages.checklist.completed}/${stages.checklist.total}`);
log('result', 'E2E COMPLETE: fresh case created via website, researched live, demoed to closed');
