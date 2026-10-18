/* BuyWise console — vanilla JS, no build step. Every dynamic value is HTML-escaped.
   Rankings, scores and decisions always come from the backend; this file never
   computes them. */
'use strict';

const app = document.getElementById('app');
const titleEl = document.getElementById('page-title');
const subEl = document.getElementById('page-sub');
const badgeEl = document.getElementById('case-badge');
let pollTimer = null;
let pollCount = 0;
let currentRefresh = null;
let ME = null;   // authenticated user (+role flags) from /api/me
let CSRF = null; // session CSRF token for mutations
function refreshCaseView(pid, tab) {
  if (typeof currentRefresh === 'function') { currentRefresh(); return; }
  viewCase(pid, tab);
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMoney = (n, c) => (typeof n === 'number' && isFinite(n) ? n.toLocaleString('en-IN') + ' ' + esc(c || '') : esc(n));
const fmtDate = (s) => { try { const d = new Date(s); return isNaN(d) ? '—' : d.toLocaleString(); } catch { return '—'; } };
const pill = (text, cls, title) => `<span class="pill ${cls || ''}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
const statusPill = (s) => {
  const v = String(s || '');
  const good = ['compared', 'decided', 'closed', 'approved', 'reevaluated', 'negotiating', 'quality_done', 'product_done', 'vendor_done', 'purchase_handoff'].includes(v.toLowerCase());
  return `<span class="pill ${good ? 'ok' : 'warn'}" title="${esc(v || '')}">${esc(v ? humanStatus(v) : '—')}</span>`;
};
const modePill = (m) => pill(m || 'REAL', (m || 'REAL') === 'DEMO' ? 'demo' : 'real');
const stagePill = (s) => pill(s, s === 'completed' ? 'ok' : s === 'failed' ? 'bad' : s === 'blocked' ? 'warn' : s === 'running' ? 'real' : '');
const rawBlock = (obj, label) => `<details class="raw"><summary>${esc(label || 'Technical details (raw JSON)')}</summary><pre>${esc(JSON.stringify(obj, null, 2))}</pre></details>`;
const evLinks = (urls) => (urls || []).slice(0, 4).map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">[${i + 1}]</a>`).join(' ');
const missingList = (arr) => (!arr || !arr.length)
  ? '<p class="ev">Nothing flagged missing.</p>'
  : `<ul class="tight">${arr.map((m) => `<li>Missing: ${esc(m)} — left blank, never invented.</li>`).join('')}</ul>`;

/* ---- negotiation candidate grouping (presentation only; rows preserved) ----
   Mirrors the backend groupOffers policy: same product + same normalized
   merchant + same unit price + same currency group into one compact
   candidate. Distinct variants, sellers, prices, or products never merge. */
function groupEligibleOffers(elig, snap) {
  const vendorsById = Object.fromEntries((snap.vendors || []).map((v) => [v.vendor_id, v]));
  const groups = new Map();
  for (const o of elig) {
    const v = vendorsById[o.vendor_id] || {};
    const merch = String(v.vendor_name || o.vendor_id || 'unknown').trim().toLowerCase();
    const price = num(o.net_price);
    const key = [String(o.product_id || 'unknown'), merch, price === null ? 'no-price' : price.toFixed(2), o.currency ? String(o.currency).toUpperCase() : 'UNKNOWN'].join('|');
    if (!groups.has(key)) groups.set(key, { candidate: o, count: 0, sources: [] });
    const g = groups.get(key);
    g.count += 1;
    if (o.source_url && !g.sources.includes(o.source_url)) g.sources.push(o.source_url);
  }
  return [...groups.values()].sort((a, b) =>
    (num(a.candidate.net_price) ?? Infinity) - (num(b.candidate.net_price) ?? Infinity) ||
    String(a.candidate.offer_id).localeCompare(String(b.candidate.offer_id)));
}
function offerOption(o, snap, extra) {
  const v = (snap.vendors || []).find((x) => x.vendor_id === o.vendor_id);
  const prod = (snap.products || []).find((x) => x.product_id === o.product_id);
  const dup = extra && extra.count > 1 ? ` ×${extra.count} identical source rows` : '';
  const src = (extra && extra.sources[0]) || o.source_url || '';
  return `<option value="${esc(o.offer_id)}">${esc(String(prod?.name || o.product_id).slice(0, 44))} · ${esc(v?.vendor_name || o.vendor_id)} · ${num(o.net_price) !== null ? fmtINR(num(o.net_price), o.currency) : 'price unavailable'} ${esc(o.currency || '')} · ${esc(o.data_status || 'evidence')}${esc(dup)}</option>`;
}
/* ---- plain-language labels (presentation only; codes stay in details) ---- */
const HUMAN_DECISION = { PROCEED: 'Proceed', NEGOTIATE: 'Negotiation recommended', NO_ELIGIBLE_OFFERS: 'No eligible offers', RESEARCH_REQUIRED: 'More research needed', INSUFFICIENT_DATA: 'Insufficient evidence' };
const HUMAN_STATUS = { created: 'Draft', product_done: 'Products found', vendor_done: 'Offers gathered', quality_done: 'Evidence reviewed', compared: 'Compared', decided: 'Decided', negotiating: 'Negotiating', demo_negotiating: 'Demo proposal', demo_response_received: 'Hypothetical response recorded', reevaluated: 'Re-evaluated', pending_approval: 'Awaiting approval', changes_requested: 'Changes requested', closed: 'Closed', purchase_handoff: 'Purchase handoff recorded', partial: 'Partial results', failed: 'Needs attention', needs_human_intervention: 'Needs attention' };
const HUMAN_VERDICT = { PASS: 'Pass', FAIL: 'Fail', UNKNOWN: 'Not verified' };
const HUMAN_APPROVAL = { PENDING_APPROVAL: 'Awaiting decision', APPROVED: 'Approved', REJECTED: 'Rejected', CHANGES_REQUESTED: 'Changes requested', EXPIRED: 'Expired', CANCELLED: 'Cancelled' };
const humanApproval = (s) => HUMAN_APPROVAL[s] || s || '—';
const HUMAN_PKG_SECTION = { procurement_request: 'Request', selected_product: 'Selected product', selected_vendor: 'Selected vendor', original_offer: 'Quoted offer (source listing)', revised_offer: 'Revised offer', original_score: 'Score before re-evaluation', revised_score: 'Score after re-evaluation', savings: 'Savings', quality_evidence: 'Quality evidence', review_evidence: 'Review evidence', delivery_information: 'Delivery', warranty_information: 'Warranty', payment_terms: 'Payment terms', criteria_used: 'Criteria used', criteria_missing: 'Criteria missing', limitations: 'Limitations', evidence_urls: 'Evidence links', negotiation_history: 'Proposal history', status: 'Package status' };
const HUMAN_EVENT = { status_transition: 'Status changed', transition_rejected: 'Blocked transition rejected', decision_persisted: 'Decision recorded', offers_enriched: 'Offers gathered', quality_evaluations_persisted: 'Evidence reviewed', comparisons_persisted: 'Comparison saved', eligibility_persisted: 'Eligibility checked', reevaluation_completed: 'Re-evaluation completed', post_reevaluation_assessment: 'Decision reassessed', approval_created: 'Approval requested', approval_approved: 'Approved', approval_rejected: 'Rejected', approval_changes_requested: 'Changes requested', approval_viewed: 'Approval viewed', purchase_handoff_recorded: 'Purchase handoff recorded', demo_mode_selected: 'Demo mode selected', demo_negotiation_created: 'Demo proposal drafted', demo_response_received: 'Hypothetical response recorded', negotiation_created: 'Proposal drafted', negotiation_failed: 'Proposal not ready', evaluated_not_ready: 'Not ready — no proposal', ownership_claimed: 'Ownership claimed', request_edited: 'Request edited' };
const humanDecision = (d) => HUMAN_DECISION[d] || d || '—';
const humanStatus = (s) => HUMAN_STATUS[s] || s || '—';
const humanVerdict = (v) => HUMAN_VERDICT[v] || v || '—';
const humanEvent = (e) => HUMAN_EVENT[e] || e || '—';
// Short case/product references for display; full IDs stay in expandable details.
const shortRef = (id) => esc(String(id || '').slice(0, 8));
function copyRefHtml(id) { return `<span class="mono ev">${shortRef(id)}</span> <button class="secondary mini-btn" data-copy="${esc(id)}">Copy</button>`; }
function wireCopyButtons(root) {
  (root || document).querySelectorAll('[data-copy]').forEach((b) => {
    if (b.dataset.wired) return; b.dataset.wired = '1';
    b.addEventListener('click', () => copyId(b, b.dataset.copy));
  });
}
function emptyState(title, why, next) {
  return `<div class="card"><h3>${esc(title)}</h3><p class="muted">${esc(why)}</p>${next ? `<p>${esc(next)}</p>` : ''}</div>`;
}
// Shared evidence legend: one precise meaning for capture-status labels on
// every page. Neither status is an independently confirmed vendor quotation.
function evidenceLegendHtml() {
  return `<p class="ev">Labels: <b>source-backed</b> = provider listing captured with merchant, price, currency and source link · <b>partial evidence</b> = listing captured with gaps in provider data · neither means the vendor confirmed the quotation, stock, delivery, warranty, or terms.</p>`;
}
// Display-only staleness check: the decision's own recorded premise ("no
// verified offers") is falsified by offers that arrived afterwards. History is
// never rewritten here — the user is pointed at a legal re-run instead.
function decisionStaleHtml(snap) {
  const d = snap.decision;
  if (!d || ['closed', 'purchase_handoff'].includes(snap.procurement.status)) return '';
  const blockedOnOffers = (d.blocking_reasons || []).includes('no verified offers');
  const offers = (snap.offers || []).length;
  if (!blockedOnOffers || !offers) return '';
  return `<div class="notice">This decision says “no verified offers”, but <b>${offers} source offer record(s)</b> have since arrived — the decision is outdated, not wrong for its time. ` +
    (typeof ME !== 'undefined' && ME?.canRunPipeline
      ? `Re-run the pipeline to reassess. <button id="stale-rerun" class="secondary">Re-run pipeline</button><div id="stale-out"></div>`
      : `Ask a procurement officer to re-run the pipeline to reassess.`) + `</div>`;
}
/* ---- display helpers (presentation only; no business logic) ---- */
// PostgreSQL NUMERIC columns arrive as strings in JSON snapshots — coerce for
// display only (never for scoring/decisions, which stay server-side).
const num = (v) => {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
  return null;
};
const fmtINR = (n, ccy) => {
  if (typeof n !== 'number' || !isFinite(n)) return pill('price unavailable', 'warn');
  if (String(ccy || '').toUpperCase() === 'INR') return '₹' + Math.round(n).toLocaleString('en-IN');
  return fmtMoney(n, ccy);
};
const isNonEmptyObj = (o) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length > 0;
const rawBlockIf = (obj, label) => (isNonEmptyObj(obj) ? rawBlock(obj, label) : '');
function copyId(btn, full) {
  const done = () => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1200); };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(full).then(done).catch(done);
  else done();
}
// items needing evidence, computed from the displayed arrays only
function incompleteCount(snap) {
  const noSpecs = (snap.products || []).filter((p) => !Object.entries(p.specifications || {}).some(([, v]) => !unverified(v))).length;
  const noRating = (snap.quality_evaluations || []).filter((q) => q.review_rating == null).length;
  const noTerms = (snap.offers || []).filter((o) => (o.delivery_days ?? 'unavailable') === 'unavailable' && (o.warranty_months ?? 'unavailable') === 'unavailable' && (o.payment_terms ?? 'unavailable') === 'unavailable').length;
  return { noSpecs, noRating, noTerms, total: noSpecs + noRating + noTerms };
}
function enrichmentStats(snap) {
  const ev = (snap.audit || []).find((a) => a.event === 'offers_enriched');
  const d = ev?.detail;
  return (d && typeof d.offers === 'number') ? d : null;
}
function nextStepInfo(snap) {
  const p = snap.procurement;
  const appr = (snap.approvals || [])[0] || null;
  if (p.status === 'closed') return { owner: '—', action: 'Completed. See the audit trail below.' };
  if (p.status === 'purchase_handoff') return { owner: '—', action: 'Purchase handoff recorded. Procurement complete.' };
  if (appr?.status === 'PENDING_APPROVAL') return { owner: 'Approver', action: 'An approver must record APPROVED, REJECTED, or CHANGES_REQUESTED (separation of duties and limits enforced).' };
  if (p.status === 'changes_requested') return { owner: 'Procurement officer', action: 'Revise the request, then prepare a new approval package (history is kept).' };
  if (!snap.decision) return { owner: 'System', action: (snap.products || []).length ? 'Run the pipeline to score and decide.' : 'Waiting for research — stages start automatically.' };
  if ((snap.negotiations || []).length) return { owner: 'Procurement officer', action: 'Continue negotiation, re-evaluation, then human approval.' };
  return { owner: 'Procurement officer', action: 'Review evidence and continue in DEMO, or request targeted research.' };
}
function nextActionText(d) {
  if (!d) return 'Run the pipeline to produce a decision.';
  return d.decision === 'PROCEED' ? 'A verified, in-budget offer exists. Next: human approval of the package.'
    : d.decision === 'NEGOTIATE' ? 'A real offer exists but terms could improve. Next: generate a negotiation proposal (nothing is sent automatically).'
    : d.decision === 'NO_ELIGIBLE_OFFERS' ? 'No candidate meets the mandatory requirements or has a verified offer. Next: revise the request (loosen constraints or budget) or stop.'
    : d.decision === 'RESEARCH_REQUIRED' ? 'Only fillable gaps block the decision. Next: run targeted research, or clarify the missing specifications.'
    : 'Evidence is insufficient for a reliable recommendation. Next: gather real prices/offers, or demonstrate the remainder in DEMO mode.';
}
function pagerHtml(page, pages, total) {
  return `<div class="pager"><button data-pg="prev" ${page <= 0 ? 'disabled' : ''}>← Prev</button><span>Page ${page + 1} of ${Math.max(pages, 1)} · ${total} row${total === 1 ? '' : 's'}</span><button data-pg="next" ${page + 1 >= pages ? 'disabled' : ''}>Next →</button></div>`;
}

async function api(path, opts) {
  const o = opts || {};
  const headers = { 'content-type': 'application/json', ...(o.headers || {}) };
  if (CSRF && o.method && o.method !== 'GET') headers['x-csrf-token'] = CSRF;
  const r = await fetch(path, { credentials: 'include', ...o, headers });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && ME) { ME = null; location.hash = '#/login'; throw new Error('Session expired — please log in again.'); }
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}
function setHead(title, sub, badge) {
  titleEl.textContent = title; subEl.textContent = sub || ''; badgeEl.innerHTML = badge || '';
}
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
function userTyping() {
  const a = document.activeElement;
  return a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
}

async function refreshHealth() {
  const el = document.getElementById('health');
  const mini = document.getElementById('prov-mini');
  try {
    await api('/api/health');
    el.textContent = 'backend + db OK'; el.className = 'health ok';
    try {
      const p = await api('/api/providers');
      mini.innerHTML = `Tavily <b>${p.tavily.configured ? 'on' : 'off'}</b> · SerpAPI <b>${p.serpapi.configured ? 'on' : 'off'}</b> · n8n <b>${p.n8n.reachable ? 'up' : 'down'}</b>`;
    } catch { mini.textContent = ''; }
    try {
      const rm = await api('/api/reasoning-mode');
      document.getElementById('llm-mode').innerHTML =
        rm.mode === 'LLM_REASONING' ? `Reasoning <b>LLM-assisted</b> <span class="ev">(${esc(rm.model || rm.provider)})</span>` : 'Reasoning <b>deterministic fallback</b>';
    } catch { /* leave blank */ }
  } catch { el.textContent = 'backend DOWN'; el.className = 'health down'; }
}
function navActive(name) {
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
}
function paintUser() {
  const chip = document.getElementById('user-chip');
  if (!chip) return;
  chip.innerHTML = ME ? `Signed in as <b>${esc(ME.username)}</b> (${esc(ME.role)}) · <a href="#/logout" style="color:#fff">Log out</a>` : '';
  const na = document.getElementById('nav-admin');
  if (na) na.style.display = ME?.canAdmin ? '' : 'none';
}

/* ================= login ================= */
async function viewLogin() {
  navActive(''); stopPoll(); currentRefresh = null;
  setHead('Log in', 'Separate accounts per role. Sessions expire after 12 hours.', '');
  paintUser();
  app.innerHTML = `<div class="card" style="max-width:440px"><h3 style="margin-top:0">Log in to BuyWise</h3>
  <div id="lmsg"></div>
  <label>Username<input id="l-user" maxlength="40" autocomplete="username"></label>
  <label>Password<input id="l-pass" type="password" maxlength="200" autocomplete="current-password"></label>
  <button id="l-go">Log in</button>
  <p class="ev">Accounts are created by an administrator (no self-registration). Failed logins are rate-limited; messages stay generic on purpose.</p></div>`;
  const go = async () => {
    const msg = document.getElementById('lmsg'); msg.innerHTML = '';
    try {
      const r = await fetch('/api/auth/login', { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: document.getElementById('l-user').value, password: document.getElementById('l-pass').value }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      ME = data.user; CSRF = data.csrf; paintUser();
      location.hash = '#/';
    } catch (e) { msg.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  document.getElementById('l-go').addEventListener('click', go);
  document.getElementById('l-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}
async function viewLogout() {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch { /* ignore */ }
  ME = null; CSRF = null; paintUser();
  location.hash = '#/login';
}

/* ================= requests & approvals (list views) ================= */
async function viewRequests() {
  navActive('requests'); stopPoll(); currentRefresh = null;
  setHead('Requests', 'Every procurement request visible to you, newest first.', '');
  app.innerHTML = '<p class="muted">Loading requests…</p>';
  try {
    const { cases } = await api('/api/cases');
    app.innerHTML = `<div class="card"><h2 style="margin-top:0">Requests (${(cases || []).length})</h2>
    <label class="ev" style="display:block;margin-bottom:6px"><input type="checkbox" id="mine-only2" style="width:auto"> My requests only</label>
    <div class="scrollbox tall"><table><tr><th>Request</th><th>Reference</th><th>Status</th><th>Mode</th><th>Owner</th><th>Decision</th><th>Updated</th><th></th></tr><tbody id="all-rows"></tbody></table></div></div>`;
    const draw = (mine) => {
      const rows = mine ? (cases || []).filter((c) => c.owner_username === ME.username) : (cases || []);
      document.getElementById('all-rows').innerHTML = rows.map((c) => `<tr>
        <td>${esc(String(c.requirement || '').slice(0, 70))}</td>
        <td>${copyRefHtml(c.procurement_id)}</td>
        <td>${statusPill(c.status)}</td><td>${modePill(c.mode)}</td><td class="ev">${esc(c.owner_username || 'Unassigned')}</td>
        <td>${c.decision ? pill(humanDecision(c.decision), c.decision !== 'PROCEED' ? 'warn' : 'ok', c.decision) : '<span class="muted">No decision yet</span>'}</td>
        <td class="ev">${esc(fmtDate(c.updated_at || c.created_at))}</td>
        <td><a href="#/case/${esc(c.procurement_id)}">Open</a></td></tr>`).join('')
        || '<tr><td colspan="8" class="muted">No requests yet. Create one via “New Request”.</td></tr>';
      wireCopyButtons(document.getElementById('all-rows'));
    };
    draw(false);
    document.getElementById('mine-only2').addEventListener('change', (e) => draw(e.target.checked));
  } catch (e) { app.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
async function viewApprovals() {
  navActive('approvals'); stopPoll(); currentRefresh = null;
  setHead('Approvals', 'Packages awaiting a human decision. You can only decide on requests you do not own, within your limit.', '');
  app.innerHTML = '<p class="muted">Loading approvals…</p>';
  try {
    const inbox = await api('/api/approvals/pending').catch(() => ({ pending: [] }));
    app.innerHTML = `<div class="card"><h2 style="margin-top:0">Approvals (${(inbox.pending || []).length} awaiting)</h2>${inboxHtml(inbox.pending || [])}</div>`;
  } catch (e) { app.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

/* ================= admin ================= */
async function viewAdmin() {
  navActive('admin'); stopPoll(); currentRefresh = null;
  if (!ME?.canAdmin) { app.innerHTML = '<div class="err">Admins only.</div>'; return; }
  setHead('Administration', 'Accounts, roles, limits, and admin audit trail.', '');
  const [users, events] = await Promise.all([api('/api/admin/users'), api('/api/admin/events').catch(() => ({ events: [] }))]);
  app.innerHTML = `<div class="card"><h3 style="margin-top:0">Users</h3><div id="amsg"></div>
  <table><tr><th>Username</th><th>Role</th><th>Approval limit</th><th>Active</th><th></th></tr>
  ${(users.users || []).map((u) => `<tr><td><b>${esc(u.username)}</b></td><td>${esc(u.role)}</td>
    <td>${u.approval_limit == null ? 'unlimited' : fmtINR(Number(u.approval_limit), 'INR')}</td>
    <td>${u.active ? pill('active', 'ok') : pill('deactivated', 'bad')}</td>
    <td class="ev">${u.active ? `<a href="#" data-deact="${esc(u.user_id)}">deactivate</a>` : `<a href="#" data-react="${esc(u.user_id)}">reactivate</a>`}</td></tr>`).join('')}</table>
  <h4>Create account</h4>
  <div class="grid2"><div><label>Username<input id="u-name" maxlength="40" placeholder="firstname.lastname"></label></div>
  <div><label>Role<select id="u-role"><option>requester</option><option>officer</option><option>approver</option><option>auditor</option><option>admin</option></select></label></div></div>
  <div class="grid2"><div><label>Password (min 8 chars)<input id="u-pass" type="password" maxlength="200"></label></div>
  <div><label>Approval limit, INR (approvers; blank = unlimited)<input id="u-limit" type="number" min="0" step="0.01"></label></div></div>
  <button id="u-go">Create account</button></div>
  <div class="card"><h3>Admin audit trail</h3>
  ${(events.events || []).length ? `<ul class="timeline">${events.events.map((e) => `<li><b>${esc(e.action)}</b> — ${esc(e.target_username || '')} <span class="ev">by ${esc(e.actor || '?')} · ${esc(fmtDate(e.created_at))}</span></li>`).join('')}</ul>` : '<p class="muted">No admin actions recorded.</p>'}</div>`;
  document.getElementById('u-go').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api('/api/admin/users', { method: 'POST', body: JSON.stringify({
        username: document.getElementById('u-name').value.trim(),
        password: document.getElementById('u-pass').value,
        role: document.getElementById('u-role').value,
        approval_limit: document.getElementById('u-limit').value || null }) });
      viewAdmin();
    } catch (err) { document.getElementById('amsg').innerHTML = `<div class="err">${esc(err.message)}</div>`; e.target.disabled = false; }
  });
  app.querySelectorAll('[data-deact],[data-react]').forEach((a) => a.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!confirm(`${a.dataset.deact ? 'Deactivate' : 'Reactivate'} this account? Deactivation kills sessions immediately.`)) return;
    try {
      await api('/api/admin/users/' + encodeURIComponent(a.dataset.deact || a.dataset.react), { method: 'PATCH', body: JSON.stringify({ active: !!a.dataset.react }) });
      viewAdmin();
    } catch (err) { document.getElementById('amsg').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
  }));
}
async function ensureAuth() {
  if (ME) return true;
  try {
    const me = await api('/api/me');
    ME = me.user; CSRF = me.csrf; paintUser();
    return true;
  } catch { return false; }
}

/* ================= dashboard ================= */
async function viewDashboard() {
  navActive(''); stopPoll();
  setHead('Dashboard', 'BuyWise — Intelligent Procurement, Evidence-Based Decisions.', '');
  const [dash, prov, inbox] = await Promise.all([
    api('/api/dashboard'), api('/api/providers').catch(() => null), api('/api/approvals/pending').catch(() => ({ pending: [] })),
  ]);
  const t = dash.totals;
  app.innerHTML = `
    <div class="hero"><h2>BuyWise — Intelligent Procurement, Evidence-Based Decisions</h2>
    <p>Multi-agent procurement automation: nine specialized stages turn a purchase request into evidence-backed offers with an explicit human decision at the end. Figures below come from live application data; DEMO interactions and hypothetical responses stay explicitly labeled wherever they appear.</p>
    <p>${ME.canCreate ? '<a class="btn" href="#/new">+ New Procurement</a>' : '<span class="ev" style="color:#c7d2e6">Your role (' + esc(ME.role) + ') cannot create requests.</span>'}
    ${ME.canAdmin ? ' <a class="btn" href="#/admin" style="background:transparent;border:1px solid #fff">Admin</a>' : ''}</p></div>
    <div class="metrics">
      <a class="metric" href="#/requests"><div class="n">${t.cases}</div><div class="l">Total Requests</div></a>
      <a class="metric" href="#/requests"><div class="n">${t.active}</div><div class="l">Active Requests</div></a>
      <a class="metric" href="#/requests"><div class="n">${t.completed}</div><div class="l">Completed (closed + handoff)</div></a>
      <a class="metric" href="#/approvals"><div class="n">${t.awaiting_approval}</div><div class="l">Awaiting My Approval</div></a>
    </div>
    <div class="card"><h3>Approval inbox (${(inbox.pending || []).length} awaiting)</h3>${inboxHtml(inbox.pending || [])}</div>
    <div class="grid2">
      <div class="card"><h3>Provider connectivity &amp; health</h3>${prov ? `
        <table>
        <tr><td>Tavily (web research)</td><td>${prov.tavily.configured ? pill('key configured — not live-tested', 'warn') : pill('not configured', 'warn')}</td></tr>
        <tr><td>SerpAPI (commercial data)</td><td>${prov.serpapi.configured ? pill('key configured — not live-tested', 'warn') : pill('not configured', 'warn')}</td></tr>
        <tr><td>n8n orchestration</td><td>${prov.n8n.reachable ? pill('reachable — tested just now', 'ok') + ` <span class="ev">${prov.n8n.latency_ms} ms</span>` : pill('unreachable', 'bad')}</td></tr>
        <tr><td>Ollama / LLM</td><td>${pill('not required', '')} <span class="ev">deterministic paths run without it</span></td></tr>
        <tr><td>Gmail</td><td>${pill('not connected', 'warn')} <span class="ev">negotiation stays blocked in REAL mode by design</span></td></tr>
        </table>` : '<p class="err">Provider check failed.</p>'}</div>
      <div class="card"><h3>Recent decisions</h3>${decTable(dash.recent_decisions)}</div>
    </div>
    <div class="card"><h3>Recent procurement runs</h3>
    <label class="ev" style="display:block;margin-bottom:6px"><input type="checkbox" id="mine-only" style="width:auto"> My requests only</label>
    <div id="runs-host"></div></div>
    <div class="card"><h3>Recent agent executions</h3>${execTable(dash.recent_executions)}</div>`;
  const paintRuns = (mine) => {
    const rows = mine ? dash.recent_runs.filter((c) => c.owner_username === ME.username) : dash.recent_runs;
    document.getElementById('runs-host').innerHTML = runsTable(rows);
    wireCopyButtons(document.getElementById('runs-host'));
  };
  paintRuns(false);
  document.getElementById('mine-only').addEventListener('change', (e) => paintRuns(e.target.checked));
}
function inboxHtml(rows) {
  if (!rows?.length) return '<p class="muted">Nothing awaiting approval.</p>';
  return `<table><tr><th>Request</th><th>Budget</th><th>Owner</th><th>Your action</th><th></th></tr>${rows.map((r) => {
    const selfOwned = ME && r.owner_user_id === ME.id;
    const tag = !ME.canApprove ? pill('view only', '') : selfOwned ? pill('own request — cannot approve', 'warn') : pill('eligible', 'ok');
    return `<tr><td>${esc(String(r.requirement || '').slice(0, 60))}<div class="ev">${esc(r.mode || 'REAL')} · ${esc(r.decision || 'no decision')}</div></td>
    <td>${r.budget != null ? fmtINR(Number(r.budget), r.currency) : '—'}</td>
    <td class="ev">${esc(r.owner_username || 'unassigned')}</td><td>${tag}</td>
    <td><a href="#/case/${esc(r.procurement_id)}/approval">Open</a></td></tr>`;
  }).join('')}</table>`;
}
function runsTable(rows) {
  if (!rows?.length) return '<p class="muted">No requests yet. Create one via “New Request”.</p>';
  return `<div class="scrollbox"><table><tr><th>Request</th><th>Reference</th><th>Status</th><th>Mode</th><th>Owner</th><th>Decision</th><th>Updated</th><th></th></tr>${rows.map((c) => `<tr>
    <td>${esc(String(c.requirement || '').slice(0, 70))}</td>
    <td>${copyRefHtml(c.procurement_id)}</td>
    <td>${statusPill(c.status)}</td><td>${modePill(c.mode)}</td><td class="ev">${esc(c.owner_username || 'Unassigned')}</td>
    <td>${c.decision ? pill(humanDecision(c.decision), c.decision !== 'PROCEED' ? 'warn' : 'ok', c.decision) : '<span class="muted">No decision yet</span>'}</td>
    <td class="ev">${esc(fmtDate(c.updated_at || c.created_at))}</td>
    <td><a href="#/case/${esc(c.procurement_id)}">Open</a></td></tr>`).join('')}</table></div>`;
}
function decTable(rows) {
  if (!rows?.length) return '<p class="muted">No decisions recorded yet.</p>';
  return `<table><tr><th>Decision</th><th>Case</th><th>When</th></tr>${rows.map((d) => `<tr>
    <td>${pill(d.decision, d.decision !== 'PROCEED' ? 'warn' : 'ok')}</td>
    <td class="mono"><a href="#/case/${esc(d.procurement_id)}">${esc(d.procurement_id).slice(0, 8)}</a></td>
    <td class="ev">${esc(fmtDate(d.created_at))}</td></tr>`).join('')}</table>`;
}
function execTable(rows) {
  if (!rows?.length) return '<p class="muted">No agent executions recorded yet.</p>';
  return `<table><tr><th>Agent</th><th>Status</th><th>Case</th><th>Latency</th><th>Error</th></tr>${rows.map((e) => `<tr>
    <td>${esc(e.agent_name)}</td><td>${stagePill(e.status === 'succeeded' ? 'completed' : e.status === 'failed' ? 'failed' : e.status)}</td>
    <td class="mono"><a href="#/case/${esc(e.procurement_id)}">${esc(String(e.procurement_id)).slice(0, 8)}</a></td>
    <td class="ev">${e.latency_ms != null ? esc(e.latency_ms) + ' ms' : '—'}</td>
    <td class="ev">${esc((e.error_message || '').slice(0, 120))}</td></tr>`).join('')}</table>`;
}

/* ================= new procurement wizard ================= */
function viewNew() {
  navActive('new'); stopPoll();
  setHead('New procurement', 'REAL mode uses live provider data. DEMO mode enables local manual responses and never contacts vendors.', '');
  app.innerHTML = `<div class="card"><h2 style="margin-top:0">New Request</h2><div id="msg"></div>
    <label>Product / category<input id="f-cat" value="business laptops" maxlength="120"></label>
    <label>Detailed requirements<textarea id="f-req" rows="3">5 business laptops for software development, 16GB RAM, 512GB SSD, suitable for professional use</textarea></label>
    <div class="grid2"><div><label>Quantity<input id="f-qty" type="number" min="1" value="5"></label></div>
    <div><label>Total budget<input id="f-budget" type="number" min="1" step="0.01" value="400000"></label></div></div>
    <div class="grid2"><div><label>Currency (ISO 4217)<input id="f-ccy" value="INR" maxlength="3"></label></div>
    <div><label>Preferred delivery timeframe<input id="f-del" maxlength="200" placeholder="e.g. within 3 weeks"></label></div></div>
    <div class="grid2"><div><label>Minimum RAM (GB, optional)<input id="f-ram" type="number" min="1" value="16"></label></div>
    <div><label>Minimum storage (GB, optional)<input id="f-stor" type="number" min="1" value="512"></label></div></div>
    <label>Warranty requirement (optional)<input id="f-war" maxlength="200" placeholder="e.g. minimum 1 year onsite"></label>
    <label>Additional constraints (optional)<textarea id="f-notes" rows="2" maxlength="1000"></textarea></label>
    <label>Procurement mode</label>
    <div><label style="display:inline;font-weight:400;margin-right:16px"><input type="radio" name="f-mode" value="REAL" checked style="width:auto"> REAL — live providers</label>
    <label style="display:inline;font-weight:400"><input type="radio" name="f-mode" value="DEMO" style="width:auto"> DEMO — local manual responses only</label></div>
    <div id="demo-reason-wrap" style="display:none"><label>Reason for DEMO (required)<input id="f-reason" maxlength="300" placeholder="e.g. live demonstration, no vendor contact"></label></div>
    <div id="wmsg"></div>
    <button id="go">Submit procurement</button> <span class="ev">Research takes ~1–3 min via live providers.</span></div>`;
  const modeEls = [...document.querySelectorAll('input[name="f-mode"]')];
  modeEls.forEach((r) => r.addEventListener('change', () => {
    document.getElementById('demo-reason-wrap').style.display =
      document.querySelector('input[name="f-mode"]:checked').value === 'DEMO' ? '' : 'none';
  }));
  document.getElementById('go').addEventListener('click', async (ev) => {
    const btn = ev.target; btn.disabled = true;
    const msg = document.getElementById('wmsg'); msg.innerHTML = '';
    try {
      const requirement = (document.getElementById('f-cat').value.trim() + ' — ' + document.getElementById('f-req').value.trim()).slice(0, 2000);
      const mandatory_specs = {};
      const ram = Number(document.getElementById('f-ram').value);
      const stor = Number(document.getElementById('f-stor').value);
      if (ram > 0) mandatory_specs.ram_gb_min = ram;
      if (stor > 0) mandatory_specs.storage_gb_min = stor;
      const preferred_specs = {};
      const war = document.getElementById('f-war').value.trim();
      const notes = document.getElementById('f-notes').value.trim();
      if (war) preferred_specs.warranty = war;
      if (notes) preferred_specs.notes = notes;
      const mode = document.querySelector('input[name="f-mode"]:checked').value;
      const body = {
        requirement,
        quantity: Number(document.getElementById('f-qty').value) || null,
        budget: Number(document.getElementById('f-budget').value) || null,
        currency: document.getElementById('f-ccy').value.trim().toUpperCase(),
        delivery_requirement: document.getElementById('f-del').value.trim() || null,
        mandatory_specs, preferred_specs, mode,
        ...(mode === 'DEMO' ? { demo_reason: document.getElementById('f-reason').value } : {}),
      };
      const before = Date.now();
      const r = await api('/api/procurements', { method: 'POST', body: JSON.stringify(body) });
      msg.innerHTML = `<div class="okmsg">Request accepted (upstream ${esc(r.upstream_status)}). Looking for the new case…</div>`;
      const found = await pollForCase(requirement, before);
      if (found) {
        try { sessionStorage.setItem('bw-autorun-' + found, '1'); } catch { /* ignore */ }
        msg.innerHTML = `<div class="okmsg">Request accepted. Opening the live pipeline — research runs, then stages complete automatically below.</div>`;
        setTimeout(() => { location.hash = '#/case/' + found; }, 900);
      }
      else msg.innerHTML = `<div class="err">Accepted, but the new case did not appear within 2 minutes. Check n8n → Executions, then open it from the Dashboard.</div>`;
    } catch (e) { msg.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
    btn.disabled = false;
  });
}
async function pollForCase(requirement, sinceMs) {
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const { cases } = await api('/api/cases');
      const hit = cases.find((c) => c.requirement === requirement && new Date(c.created_at).getTime() >= sinceMs - 5000);
      if (hit) return hit.procurement_id;
    } catch { /* keep polling through transient errors */ }
  }
  return null;
}

/* ================= case workspace ================= */
const TABS = [
  ['overview', 'Request'], ['products', 'Product Discovery'],
  ['vendors', 'Vendor Offers'], ['quality', 'Quality & Evidence'], ['comparison', 'Comparison & Scoring'],
  ['decision', 'Decision'], ['negotiation', 'Negotiation Proposal'], ['reevaluation', 'Re-evaluation'],
  ['approval', 'Approval & Handoff'], ['workflow', 'Agent Workflow'], ['trace', 'Agent Trace'], ['audit', 'Audit History'],
];
const TERMINAL = new Set(['closed', 'purchase_handoff']);

async function viewCase(id, tab) {
  navActive('');
  const snap = await api('/api/cases/' + encodeURIComponent(id));
  const stages = await api('/api/cases/' + encodeURIComponent(id) + '/stages').catch(() => null);
  const p = snap.procurement;
  tab = TABS.some(([k]) => k === tab) ? tab : 'overview';
  currentRefresh = () => viewCase(id, tab);
  setHead('Case ' + p.procurement_id.slice(0, 8),
    String(p.requirement || '').slice(0, 120),
    `${statusPill(p.status)} ${modePill(p.mode)}`);
  const tabs = TABS.map(([k, label]) => `<a href="#/case/${esc(p.procurement_id)}/${k}" class="${k === tab ? 'active' : ''}">${label}</a>`).join('');
  const ns0 = nextStepInfo(snap);
  const caseHeader = `<div class="card"><h2 style="margin-top:0">${esc(String(p.requirement || 'Procurement request').slice(0, 120))}</h2>
    <p>${copyRefHtml(p.procurement_id)} ${statusPill(p.status)} ${modePill(p.mode)}</p>
    <p class="small muted">Owner ${esc(snap.owner_username || 'unassigned')}${p.quantity != null ? ` · Quantity ${esc(p.quantity)}` : ''}${p.budget != null ? ` · Budget ${fmtINR(Number(p.budget), p.currency)} total` : ''}</p>
    <p class="small"><b>Next:</b> ${esc(ns0.action)} <span class="ev">(${esc(ns0.owner)})</span></p></div>`;
  app.innerHTML = `${caseHeader}<div class="tabs" role="navigation">${tabs}</div><div id="tabbody"></div><div id="pollnote"></div>`;
  wireCopyButtons(app);
  renderTab(tab, snap, stages);
  stopPoll(); pollCount = 0;
  if (!TERMINAL.has(p.status)) {
    pollTimer = setInterval(async () => {
      if (userTyping() || ++pollCount > 60) {
        if (pollCount > 60) stopPoll();
        else { const n = document.getElementById('pollnote'); if (n && !n.textContent) n.innerHTML = '<p class="ev">Paused auto-refresh while you type — <a href="#" id="rf">refresh now</a>.</p>'; const rf = document.getElementById('rf'); if (rf) rf.onclick = (e) => { e.preventDefault(); viewCase(id, tab); }; }
        return;
      }
      try {
        const s2 = await api('/api/cases/' + encodeURIComponent(id));
        const fp = (x) => [x.procurement.status, x.procurement.mode, (x.products || []).length, (x.offers || []).length, (x.comparisons || []).length, (x.approvals || []).length, (x.negotiations || []).length].join('|');
        if (fp(s2) !== fp(snap)) viewCase(id, tab);
      } catch { /* banner on next manual refresh */ }
    }, 5000);
  }
  const h = location.hash;
  if (!h.includes('/' + tab)) history.replaceState(null, '', '#/case/' + p.procurement_id + '/' + tab);
}
function renderTab(tab, snap, stages) {
  const el = document.getElementById('tabbody');
  const fn = { overview: tabOverview, workflow: tabWorkflow, products: tabProducts, vendors: tabVendors,
    quality: tabQuality, comparison: tabComparison, decision: tabDecision, negotiation: tabNegotiation,
    reevaluation: tabReeval, approval: tabApproval, audit: tabAudit, trace: tabTrace }[tab];
  el.innerHTML = '';
  fn(el, snap, stages);
  wireCopyButtons(el);
  app.querySelector('main, #app')?.focus?.({ preventScroll: true });
}
function plainExplainer() {
  return `<div class="card"><h3>How to read this case</h3>
  <p>BuyWise works through nine stages: research finds <b>real products and merchants</b>, quality review checks the evidence, a <b>deterministic engine</b> (not an AI guess) scores the offers, the Decision Agent recommends, and — only in DEMO or with a real vendor reply — negotiation, re-evaluation and <b>explicit human approval</b> follow. Anything the system could not verify is shown as <b>unavailable</b>, never invented.</p></div>`;
}

/* ---- overview: summary + checklist ---- */
function tabOverview(el, snap, stages) {
  const p = snap.procurement;
  const cl = stages?.checklist;
  const demoClosed = p.status === 'closed' && (p.mode || 'REAL') === 'DEMO';
  const demoBanner = demoClosed
    ? `<div class="notice">DEMO simulation — closed by a simulated approval. <b>Not a real purchase authorization; no order placed.</b> Purchase handoff stays blocked for DEMO cases.</div>` : '';
  el.innerHTML = plainExplainer() + demoBanner + `
  <div class="card"><h3>Request details</h3>
    <p>${esc(p.requirement || '')}</p>
    <p class="small muted">Quantity ${esc(p.quantity ?? '—')} · Budget ${p.budget != null ? fmtINR(Number(p.budget), p.currency) + ' total' : '—'}${p.budget != null && Number(p.quantity) > 0 ? ` · unit budget ${fmtINR(Number(p.budget) / Number(p.quantity), p.currency)}` : ''} · Created ${esc(fmtDate(p.created_at))}</p>
    <p class="small muted">Version ${esc(p.version ?? 1)} · Reference ${copyRefHtml(p.procurement_id)}</p></div>
  <div class="card"><h3>Demonstration checklist (${cl ? cl.completed + '/' + cl.total + ' complete' : 'unavailable'})</h3>
    ${cl ? `<ul class="tight check">${cl.items.map((i) => `<li>${i.done ? '✅' : '⬜'} <b>${esc(i.label)}</b> — <span class="muted">${esc(i.detail)}</span></li>`).join('')}</ul>
    <p class="ev">Milestones derive from persisted records above — never animated or assumed.</p>`
    : '<p class="muted">Checklist unavailable (stages endpoint unreachable).</p>'}</div>`;
}

/* ---- nine-stage workflow diagram ---- */
function tabWorkflow(el, snap, stages) {
  if (!stages?.stages) { el.innerHTML = '<div class="err">Stage data unavailable.</div>'; return; }
  // Plain-language stage states mapped from persisted status + evidence source.
  // Never claims an agent ran: 'evidence' means reconstructed from output rows.
  const friendlyStage = (s) => s.status === 'completed' ? ['Completed', 'ok']
    : s.status === 'running' ? ['Running', 'real']
    : s.status === 'failed' ? ['Needs attention', 'bad']
    : s.status === 'blocked' ? ['Blocked', 'warn']
    : (s.source === 'none' ? ['Not started', ''] : ['Pending', '']);
  const sourceBadge = (s) => s.source === 'execution'
    ? pill('Execution recorded', 'ok', 'an agent execution row exists for this stage')
    : s.source === 'evidence' ? pill('Evidence available', '', 'no execution row; status rebuilt from stored output rows')
    : pill('No evidence yet', '', 'stage has not run and produced no output');
  el.innerHTML = `<div class="card"><h3>Nine functional stages <span class="muted small">— states from persisted executions and evidence (${modePill(stages.mode)})</span></h3>
    <p class="ev">An orchestrator coordinates the stages (tasking, retries, lifecycle); it scores, decides, and approves nothing itself. Scoring is deterministic code and approval is human — neither is an autonomous agent.</p>
    <div class="flow">${stages.stages.map((s, i) => {
      const [label, cls] = friendlyStage(s);
      return `
      <div class="stage ${s.status}">
        <div class="dot">${i + 1}</div>
        <div class="stage-body">
          <h4>${esc(s.name)} ${pill(label, cls, s.status)} ${sourceBadge(s)}</h4>
          <p>${esc(s.responsibility)}</p>
          ${s.summary ? `<p>${esc(s.summary)}</p>` : ''}
          ${s.source === 'evidence' ? '<p class="ev">Evidence-derived reconstruction — no execution row was recorded for this stage; the status above is rebuilt from persisted output rows (history preserved, nothing re-run).</p>' : ''}
          ${s.source === 'none' ? '<p class="ev">Not run yet — no execution record and no output evidence for this stage.</p>' : ''}
          <p class="ev">${s.started_at ? 'started ' + esc(fmtDate(s.started_at)) + ' · ' : ''}${s.completed_at ? 'completed ' + esc(fmtDate(s.completed_at)) + ' · ' : ''}${s.latency_ms != null ? esc(s.latency_ms) + ' ms' : ''}</p>
          ${s.error ? `<p class="err">${esc(s.error)}</p>` : ''}
          ${missingList(s.missing)}
          ${s.evidence_urls?.length ? `<p class="ev">Evidence: ${evLinks(s.evidence_urls)}</p>` : ''}
          <button class="secondary" data-stage="${esc(s.key)}">Execution details</button>
          <div id="det-${esc(s.key)}"></div>
        </div>
      </div>`; }).join('')}</div></div>`;
  el.querySelectorAll('[data-stage]').forEach((b) => b.addEventListener('click', async () => {
    const host = document.getElementById('det-' + b.dataset.stage);
    const execs = (snap.agent_executions || []).filter((e) => stageAgent(b.dataset.stage) === e.agent_name);
    host.innerHTML = execs.length
      ? execs.map((e) => `<div class="card" style="margin:8px 0">${esc(e.agent_name)} — ${stagePill(e.status === 'succeeded' ? 'completed' : e.status)}<div class="ev">trace <span class="mono">${esc(e.trace_id || '')}</span> · started ${esc(fmtDate(e.started_at))} · latency ${esc(e.latency_ms ?? '—')} ms</div>${e.error_message ? `<p class="err">${esc(e.error_message)}</p>` : ''}${rawBlock({ input_hash: e.input_hash, output_hash: e.output_hash }, 'Hashes (inputs/outputs content-addressed)')}</div>`).join('')
      : '<p class="muted">No execution row recorded for this stage — status above comes from output evidence, if any.</p>';
  }));
}
function stageAgent(key) {
  return { product_research: 'product_research', vendor_research: 'vendor_research', review_quality: 'review_quality', comparison: 'comparison', decision: 'decision', negotiation: 'negotiation', reevaluation: 'reevaluation', approval: 'approval' }[key] || null;
}

/* ---- products ---- */
function unverified(v) { return v === 'unavailable' || v == null || v === ''; }
function tabProducts(el, snap) {
  const rows = snap.products || [];
  if (!rows.length) { el.innerHTML = emptyState('Product Discovery', 'No provider search has returned products yet — research may still be running, may have failed, or may have found nothing with enough evidence.', 'Wait for research to finish, then re-run the pipeline from the Request step. Nothing is invented while research runs.'); return; }
  // Collapse repeated ingestion records to distinct products (display only —
  // same conservative identity rule as Comparison; history preserved).
  const groups = new Map();
  for (const p of rows) {
    const key = normProductKey(p.name || p.product_id);
    if (!groups.has(key)) groups.set(key, { key, name: '', members: [] });
    const g = groups.get(key);
    g.members.push(p);
    if (String(p.name || '').length > String(g.name || '').length) g.name = p.name;
  }
  const distinct = [...groups.values()];
  const sources = [...new Set(rows.map((p) => p.source).filter(Boolean))];
  const provNote = sources.length === 1 && sources[0] === 'serpapi_shopping'
    ? `All ${rows.length} records are provider-discovered (SerpAPI Google Shopping) with source links below — no seeded examples, no test fixtures.`
    : `Sources in this case: ${sources.map(esc).join(', ') || 'unrecorded'} — every row keeps its own source link below.`;
  el.innerHTML = `<div class="card"><h3>Product Discovery (${distinct.length} distinct products from ${rows.length} source records)</h3>
  <p class="ev">${provNote} Repeated listings of the same product collapse with a record count; every source record stays expandable. Variants with different names stay separate.</p>
  <div class="toolbar"><input type="search" id="p-q" placeholder="Search products…" aria-label="Search products">
  <select id="p-sort" aria-label="Sort products"><option value="conf">Sort: confidence</option><option value="name">Sort: name</option></select></div>
  <div class="scrollbox"><table><tr><th>Product</th><th>Source</th><th>Specs</th><th>Status</th></tr><tbody id="p-rows"></tbody></table></div>
  <div id="p-pager"></div></div>`;
  const st = { q: '', sort: 'conf', page: 0 };
  const per = 15;
  const confOf = (g) => Math.max(...g.members.map((p) => Number(p.confidence ?? 0)));
  const draw = () => {
    let list = distinct.filter((g) => !st.q || String(g.name || '').toLowerCase().includes(st.q));
    list = [...list].sort((a, b) => st.sort === 'name'
      ? String(a.name || '').localeCompare(String(b.name || ''))
      : (confOf(b) - confOf(a)));
    const pages = Math.max(1, Math.ceil(list.length / per));
    st.page = Math.min(st.page, pages - 1);
    const slice = list.slice(st.page * per, st.page * per + per);
    document.getElementById('p-rows').innerHTML = slice.map((g) => {
      const verified = {};
      for (const p of g.members) for (const [k, v] of Object.entries(p.specifications || {})) {
        if (!unverified(v) && verified[k] === undefined) verified[k] = v;
      }
      const live = g.members.some((p) => p.data_status === 'LIVE');
      const first = g.members[0];
      return `<tr><td><span class="clip" title="${esc(g.name || '')}">${esc(g.name || '')}</span>` +
      (g.members.length > 1 ? `<div class="ev">×${g.members.length} source records</div><details><summary>Source records (expand)</summary><ul class="tight">${g.members.map((p) => `<li><a href="${esc(p.source_url)}" target="_blank" rel="noopener">View source</a> <span class="ev">${esc(p.source || '')} · ${esc(fmtDate(p.retrieved_at))} · ref ${shortRef(p.product_id)}</span></li>`).join('')}</ul></details>`
        : `<div class="ev">ref ${shortRef(first.product_id)}</div>`) + `</td>
      <td><a href="${esc(first.source_url)}" target="_blank" rel="noopener">View source</a> <span class="ev">${esc(first.source || '')}</span><div class="ev">${esc(fmtDate(first.retrieved_at))} · conf ${esc(confOf(g))}</div></td>
      <td class="ev">${Object.keys(verified).length ? esc(Object.entries(verified).map(([k, v]) => `${k}=${v}`).join(', ')) : 'unavailable'}</td>
      <td>${pill(live ? 'source-backed' : (first.data_status || '—'), live ? 'ok' : 'warn')}</td></tr>`;
    }).join('') || '<tr><td colspan="4" class="muted">No matches.</td></tr>';
    document.getElementById('p-pager').innerHTML = pagerHtml(st.page, pages, list.length);
    document.querySelectorAll('#p-pager [data-pg]').forEach((b) => b.addEventListener('click', () => {
      st.page += b.dataset.pg === 'next' ? 1 : -1; draw();
    }));
  };
  document.getElementById('p-q').addEventListener('input', (e) => { st.q = e.target.value.trim().toLowerCase(); st.page = 0; draw(); });
  document.getElementById('p-sort').addEventListener('change', (e) => { st.sort = e.target.value; st.page = 0; draw(); });
  draw();
}

/* ---- vendors & offers ---- */
function tabVendors(el, snap) {
  const offers = snap.offers || [], vendors = snap.vendors || [];
  const uniqMerchants = new Set(vendors.map((v) => String(v.vendor_name || '').toLowerCase())).size;
  if (!offers.length) {
    el.innerHTML = emptyState('Vendor Offers', 'No offers have been gathered yet — a listing only becomes an offer with a real merchant, numeric price, known currency, and source URL.', 'Run the pipeline from the Request step; weak results stay research evidence and are never invented as offers.');
    return;
  }
  // Derived duplicate grouping (display only — source rows preserved): same
  // merchant + price + currency + product collapse; variants never merge.
  const vById = Object.fromEntries(vendors.map((v) => [v.vendor_id, v]));
  const gmap = new Map();
  for (const o of offers) {
    const v = vById[o.vendor_id] || {};
    const merch = String(v.vendor_name || o.vendor_id || '').trim().toLowerCase();
    const price = num(o.net_price);
    const key = [merch, price === null ? 'no-price' : price.toFixed(2), String(o.currency || '').toUpperCase(), String(o.product_id)].join('|');
    const g = gmap.get(key) || { count: 0 };
    g.count += 1; gmap.set(key, g);
  }
  const groupCount = gmap.size;
  el.innerHTML = `<div class="card"><h3>Offers (${offers.length} rows · ${groupCount} merchant × price groups) · ${uniqMerchants} unique merchants</h3>
  <p class="ev">Source-backed means merchant, price, currency and source URL are all real. Repeated merchant/price rows are grouped in counts above — source rows preserved, never deleted. Availability, delivery, warranty and payment terms are <b>unverified</b> unless shown otherwise — never inferred.</p>
  ${evidenceLegendHtml()}
  <div class="toolbar"><input type="search" id="v-q" placeholder="Search merchant or product…" aria-label="Search offers">
  <select id="v-sort" aria-label="Sort offers"><option value="price">Sort: price ↑</option><option value="price-desc">Sort: price ↓</option><option value="merchant">Sort: merchant</option></select></div>
  <div class="scrollbox tall"><table><tr><th>Merchant</th><th>Product</th><th>Price</th><th>Evidence</th><th>Source</th></tr><tbody id="v-rows"></tbody></table></div>
  <div id="v-pager"></div></div>`;
  const st = { q: '', sort: 'price', page: 0 };
  const per = 12;
  const termsMissing = (o) => (o.delivery_days ?? 'unavailable') === 'unavailable' && (o.warranty_months ?? 'unavailable') === 'unavailable' && (o.payment_terms ?? 'unavailable') === 'unavailable';
  const draw = () => {
    let list = offers.filter((o) => {
      if (!st.q) return true;
      const v = vendors.find((x) => x.vendor_id === o.vendor_id);
      const p = (snap.products || []).find((x) => x.product_id === o.product_id);
      return (String(v?.vendor_name || '') + ' ' + String(p?.name || '')).toLowerCase().includes(st.q);
    });
    list = [...list].sort((a, b) => {
      if (st.sort === 'merchant') {
        const va = vendors.find((x) => x.vendor_id === a.vendor_id)?.vendor_name || '';
        const vb = vendors.find((x) => x.vendor_id === b.vendor_id)?.vendor_name || '';
        return String(va).localeCompare(String(vb));
      }
      const pa = num(a.net_price) ?? Infinity;
      const pb = num(b.net_price) ?? Infinity;
      return st.sort === 'price-desc' ? pb - pa : pa - pb;
    });
    const pages = Math.max(1, Math.ceil(list.length / per));
    st.page = Math.min(st.page, pages - 1);
    document.getElementById('v-rows').innerHTML = list.slice(st.page * per, st.page * per + per).map((o) => {
      const v = vendors.find((x) => x.vendor_id === o.vendor_id);
      const p = (snap.products || []).find((x) => x.product_id === o.product_id);
      return `<tr><td><b>${esc(v?.vendor_name || '—')}</b></td>
      <td><span class="clip" title="${esc(p?.name || o.product_id)}">${esc(p?.name || o.product_id)}</span></td>
      <td><b>${num(o.net_price) !== null ? fmtINR(num(o.net_price), o.currency) : ''}</b>${num(o.net_price) === null ? pill('price unavailable', 'warn') : ''}</td>
      <td>${pill(o.data_status === 'LIVE' ? 'source-backed' : (o.data_status || '—'), o.data_status === 'LIVE' ? 'ok' : 'warn')}<div class="ev">${termsMissing(o) ? 'terms unverified' : 'partial terms'}</div></td>
      <td><a href="${esc(o.source_url)}" target="_blank" rel="noopener">View source</a><div class="ev">${esc(fmtDate(o.retrieved_at))}</div></td></tr>`;
    }).join('') || '<tr><td colspan="5" class="muted">No matches.</td></tr>';
    document.getElementById('v-pager').innerHTML = pagerHtml(st.page, pages, list.length);
    document.querySelectorAll('#v-pager [data-pg]').forEach((b) => b.addEventListener('click', () => {
      st.page += b.dataset.pg === 'next' ? 1 : -1; draw();
    }));
  };
  document.getElementById('v-q').addEventListener('input', (e) => { st.q = e.target.value.trim().toLowerCase(); st.page = 0; draw(); });
  document.getElementById('v-sort').addEventListener('change', (e) => { st.sort = e.target.value; st.page = 0; draw(); });
  draw();
}

/* ---- quality & evidence ---- */
function tabQuality(el, snap) {
  const rows = snap.quality_evaluations || [];
  if (!rows.length) { el.innerHTML = '<div class="card"><h3>Quality &amp; evidence</h3><p class="muted">No quality evaluations yet.</p></div>'; return; }
  el.innerHTML = `<div class="card"><h3>Quality &amp; evidence (${rows.length})</h3>
  <p class="ev">Source quality rates the <b>evidence strength</b>, never the product itself. Merchant ratings, product ratings, source quality and vendor reliability are separate concepts.</p>
  <div class="scrollbox"><table><tr><th>Product</th><th>Source quality</th><th>Specs verified</th><th>Rating / reviews</th></tr>${rows.slice(0, 60).map((q) => {
    const p = (snap.products || []).find((x) => x.product_id === q.product_id);
    return `<tr><td>${esc(String(p?.name || q.product_id).slice(0, 70))}</td>
    <td>${pill(q.source_quality || '—', q.source_quality === 'HIGH' ? 'ok' : q.source_quality === 'LOW' ? 'warn' : '')} <span class="ev">${esc(q.source_quality_score ?? '')}</span></td>
    <td class="ev">${esc(q.spec_fields_verified ?? '—')}/${esc(q.spec_fields_total ?? '—')} complete (${esc(q.specification_completeness ?? '')})</td>
    <td>${q.review_rating != null ? esc(q.review_rating) + '/' + esc(q.review_scale ?? 5) + ` <span class="ev">(${esc(q.review_count ?? '?')} reviews)</span>` : pill('no review evidence', 'warn')}</td></tr>`;
  }).join('')}</table></div>${rawBlock(rows.slice(0, 3), 'Sample evaluations (raw JSON)')}</div>`;
}

/* ---- comparison & scoring (backend truth only) ---- */
// Eligibility groups from persisted rows (never recomputed client-side).
// Falls back to unresolved when the case predates eligibility assessment.
function eligibilityHtml(snap) {
  const rows = snap.comparisons || [];
  const elig = snap.eligibility || [];
  if (!rows.length) return '';
  const mand = snap.procurement.mandatory_specs || {};
  const reqCount = Object.keys(mand || {}).length;
  if (!reqCount) return '<p class="ev">No mandatory requirements configured on this request — eligibility is not assessed against requirements, so no candidate is approved or rejected on requirements.</p>';
  if (!elig.length) return '<p class="ev">Eligibility not yet assessed for this case (run the pipeline) — all candidates unresolved.</p>';
  const byProduct = {};
  for (const r of elig) (byProduct[r.product_id] ||= []).push(r);
  const groups = { eligible: [], rejected: [], unresolved: [] };
  for (const c of rows) {
    const rs = (byProduct[c.product_id] || []).filter((r) => r.evidence?.mandatory !== false);
    if (rs.some((r) => r.verdict === 'FAIL')) groups.rejected.push(c.product_id);
    else if (rs.length && rs.every((r) => r.verdict === 'PASS')) groups.eligible.push(c.product_id);
    else groups.unresolved.push(c.product_id);
  }
  const nameOf = (pid) => { const p = (snap.products || []).find((x) => x.product_id === pid); return p ? p.name : pid; };
  const li = (pid) => {
    const rs = byProduct[pid] || [];
    const badges = rs.map((r) => `<span class="pill ${r.verdict === 'PASS' ? 'ok' : r.verdict === 'FAIL' ? 'bad' : ''}" title="${esc(r.verdict)}">${esc(r.requirement)}: ${esc(humanVerdict(r.verdict))}</span>`).join(' ');
    return `<li>${esc(String(nameOf(pid)).slice(0, 80))}<br>${badges || '<span class="ev">not assessed</span>'}</li>`;
  };
  const det = (title, list) => list.length
    ? `<details><summary>${title} (${list.length})</summary><ul class="tight">${list.map(li).join('')}</ul></details>` : '';
  return `<div class="card" style="margin:8px 0"><h4 style="margin-top:0">Eligibility — mandatory requirements</h4>
  <p class="ev">${groups.eligible.length} eligible · ${groups.rejected.length} rejected (mandatory FAIL) · ${groups.unresolved.length} unresolved (UNKNOWN evidence, never assumed).</p>
  ${det('Eligible', groups.eligible)}${det('Rejected — mandatory mismatch', groups.rejected)}${det('Unresolved — missing evidence', groups.unresolved)}</div>`;
}
/* Fixed offer-table columns — the header and every offer row are built from
   this one list in order, so a value can never shift into the wrong column. */
const CMP_COLS = ['Merchant', 'Unit price', 'Est. total', 'Budget', 'Evidence', 'Source'];

// Conservative normalized product identity (display only — history is never
// rewritten). Exact match on lowercased alphanumeric tokens; near-miss
// variants (typos, truncations such as "Height" vs "Hight") deliberately stay
// separate: never merge on similar names alone.
function normProductKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

// Distinct candidate products (display only). Comparison rows sharing one
// normalized identity collapse to ONE card; their offers union underneath it,
// grouped by merchant + unit price + currency. Genuinely different variants,
// merchants, prices, currencies, and source offers never merge. Member record
// ids, discovery positions, and score states stay inspectable.
function distinctProducts(snap) {
  const offers = snap.offers || [], vendors = snap.vendors || [];
  const vById = Object.fromEntries(vendors.map((v) => [v.vendor_id, v]));
  const prodById = Object.fromEntries((snap.products || []).map((p) => [p.product_id, p]));
  const termsNote = (members) => members.every((o) =>
    (o.delivery_days ?? 'unavailable') === 'unavailable' &&
    (o.warranty_months ?? 'unavailable') === 'unavailable' &&
    (o.payment_terms ?? 'unavailable') === 'unavailable') ? 'terms unverified' : 'partial terms';
  const byKey = new Map();
  for (const c of (snap.comparisons || [])) {
    const prod = prodById[c.product_id];
    const key = normProductKey(prod?.name || c.product_id);
    if (!byKey.has(key)) byKey.set(key, { key, name: String(prod?.name || c.product_id), members: [] });
    byKey.get(key).members.push({
      product_id: c.product_id, rank: c.rank ?? 9999,
      score: (typeof c.overall_score === 'number' ? c.overall_score : (num(c.overall_score) ?? null)),
      used: c.criteria_used || [], missing: c.criteria_missing || [],
    });
  }
  const out = [...byKey.values()].map((d) => {
    const memberIds = new Set(d.members.map((m) => m.product_id));
    const union = new Map();
    for (const o of offers) {
      if (!memberIds.has(o.product_id)) continue;
      const price = num(o.net_price);
      const merch = String(vById[o.vendor_id]?.vendor_name || o.vendor_id || 'unknown').trim().toLowerCase();
      const gkey = [merch, price === null ? 'no-price' : price.toFixed(2),
        o.currency ? String(o.currency).toUpperCase() : 'UNKNOWN'].join('|');
      if (!union.has(gkey)) union.set(gkey, { merchant: vById[o.vendor_id]?.vendor_name || o.vendor_id, price, ccy: o.currency || null, members: [] });
      union.get(gkey).members.push(o);
    }
    const offerGroups = [...union.values()].map((g) => ({ ...g, count: g.members.length,
      sources: g.members.map((o) => ({ offer_id: o.offer_id, source_url: o.source_url, data_status: o.data_status, retrieved_at: o.retrieved_at })),
      live: g.members.some((o) => o.data_status === 'LIVE'), terms: termsNote(g.members) }))
      .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity) || String(a.merchant || '').localeCompare(String(b.merchant || '')));
    const scoredMembers = d.members.filter((m) => m.score !== null && m.score !== undefined);
    const usedUnion = [...new Set(d.members.flatMap((m) => m.used || []))];
    return { ...d,
      minRank: Math.min(...d.members.map((m) => m.rank)),
      score: scoredMembers.length ? Math.max(...scoredMembers.map((m) => Number(m.score))) : null,
      scoredCount: scoredMembers.length, used: usedUnion,
      missing: [...new Set(d.members.flatMap((m) => m.missing || []))],
      offerGroups, sourceRows: offerGroups.reduce((n, g) => n + g.count, 0),
      hasOffers: offerGroups.length > 0 };
  });
  // Discovery order (backend fallback) — explicitly not a recommendation rank.
  out.sort((a, b) => a.minRank - b.minRank);
  return out;
}

// Display-only budget verdict (same unit-vs-unit-budget arithmetic as the
// backend; labeled an estimate — never a score, never a recommendation).
function cmpBudgetCell(price, ccy, snap) {
  const p = snap.procurement;
  if (price === null) return '<span class="ev">no verdict — no price</span>';
  const b = num(p.budget);
  if (b === null || !p.currency) return pill('budget unavailable', 'warn');
  if (!ccy || String(ccy).toUpperCase() !== String(p.currency).toUpperCase()) {
    return `${pill('unavailable', 'warn')}<div class="ev">currency mismatch — no conversion</div>`;
  }
  const q = Number.isInteger(p.quantity) && p.quantity > 0 ? p.quantity : null;
  if (q === null) return `${pill('unavailable', 'warn')}<div class="ev">quantity unavailable</div>`;
  const ok = price <= b / q;
  return `${pill(ok ? 'Within budget' : 'Over budget', ok ? 'ok' : 'bad')}<div class="ev">est.: unit vs unit-budget · partial excl. tax/shipping</div>`;
}

function cmpMandatoryCell(pid, snap, mandCount) {
  if (!mandCount) return '<span class="ev">Not configured</span>';
  const er = (snap.eligibility || []).filter((r) => r.product_id === pid && r.evidence?.mandatory !== false);
  if (!er.length) return pill('Not verified', 'warn');
  return er.map((r) => r.verdict === 'PASS' ? `<span class="pill ok">${esc(r.requirement)}: pass</span>`
    : r.verdict === 'FAIL' ? `<span class="pill bad">${esc(r.requirement)}: fail</span>`
    : pill(`${r.requirement}: not verified`, 'warn')).join(' ');
}

function tabComparison(el, snap) {
  const rows = snap.comparisons || [];
  const cfg = Array.isArray(snap.scoring_configs) ? snap.scoring_configs[0] : snap.scoring_configs;
  if (!rows.length) { el.innerHTML = '<div class="card"><h3>Comparison &amp; scoring</h3><p class="muted">Nothing compared yet.</p></div>'; return; }
  const weights = (cfg && cfg.weights) || {};
  const p = snap.procurement;
  const qty = Number.isInteger(p.quantity) && p.quantity > 0 ? p.quantity : null;
  const products = distinctProducts(snap);
  const withOffers = products.filter((d) => d.hasOffers);
  const withoutOffers = products.filter((d) => !d.hasOffers);
  const scored = rows.filter((r) => typeof r.overall_score === 'number' || num(r.overall_score) !== null).length;
  const pricedRows = (snap.offers || []).filter((o) => num(o.net_price) !== null && num(o.net_price) > 0 && o.currency).length;
  const totalGroups = withOffers.reduce((n, d) => n + d.offerGroups.length, 0);
  const dup = products.filter((d) => d.members.length > 1);
  const topDup = [...dup].sort((a, b) => b.members.length - a.members.length)[0] || null;
  const mand = p.mandatory_specs || {};
  const mandCount = Object.keys(mand).length;
  const d = snap.decision;
  const blockers = (d?.blocking_reasons || []).join('; ');
  const headNote = scored === 0
    ? `<div class="notice">No scored recommendations yet — these candidates are <b>not score-ranked</b>. Order below is <b>discovery / evidence-confidence order</b> (backend fallback); position is not a recommendation.</div>`
    : `<div class="notice">${scored}/${rows.length} scored; unscored candidates appear last in <b>discovery / evidence-confidence order</b>, not as zero-scored.</div>`;
  const summary =
    `<ul class="tight">` +
    `<li>Distinct candidate products: <b>${products.length}</b> (from <b>${rows.length}</b> candidate records in store` +
      (dup.length ? ` — ${dup.length} identit${dup.length === 1 ? 'y' : 'ies'} repeat, e.g. "${esc(topDup.name.slice(0, 60))}" × ${topDup.members.length} records; repeats come from duplicated provider listings, history preserved, display collapsed` : '; no duplicate identities') + `)</li>` +
    `<li>Individual source offer records: <b>${pricedRows}</b> with prices in <b>${totalGroups}</b> merchant × price × currency groups across <b>${withOffers.length}</b> distinct products with offers</li>` +
    `<li>Distinct candidates without offers: <b>${withoutOffers.length}</b> — listed separately below, no prices or merchants invented</li>` +
    `<li>Candidates with calculable scores: <b>${scored}</b>` +
      (scored === 0 ? ` — no scoring basis: ${esc(blockers || 'required evidence is missing')} (null means "no basis", never "bad")` : '') + `</li>` +
    `<li>Mandatory requirements: ${mandCount ? `<b>${mandCount}</b> configured — see per-product verdicts (failures are never recommended)` : '<b>none configured</b> — eligibility is not assessed, and no candidate counts as approved on requirements'}</li>` +
    (d ? `<li>Decision so far: <b>${esc(d.decision)}</b> — ${esc(String(d.decision_reason || '').slice(0, 220))}</li>` : '<li>No decision recorded yet.</li>') +
    `<li>Next step: ${mandCount === 0
      ? 'the requester needs to add mandatory specifications to this request, and more verified evidence (prices, specifications, terms) is needed before a meaningful recommendation is possible.'
      : 'more verified evidence (prices, specifications, delivery, warranty, terms) is needed before a meaningful recommendation is possible.'}</li>` +
    `<li>Mode: <b>${esc(p.mode || 'REAL')}</b>${(p.mode || 'REAL') === 'DEMO' ? ' — figures may include hypothetical human-entered demo input, never a verified vendor quotation' : ''}</li>` +
    `</ul>`;
  const scoreBadge = (d2) => {
    const basis = (d2.used || []).length + (d2.missing || []).length;
    const partial = (d2.used || []).length > 0 && (d2.missing || []).length > 0
      ? ` · partial basis (${d2.used.length} of ${basis} criteria — not a complete overall evaluation)` : '';
    return d2.score !== null && d2.score !== undefined
      ? `<b>${Number(d2.score).toFixed(3)}</b><div class="ev">used: ${esc((d2.used || []).join(', ') || 'none')}${esc(partial)}</div>`
      : `<b>Not scored</b><div class="ev">used: ${esc((d2.used || []).join(', ') || 'none — no basis')}</div>`;
  };
  const offerRowHtml = (g) => {
    const cells = [
      `<b>${esc(g.merchant || 'unknown merchant')}</b>${g.count > 1 ? `<div class="ev">×${g.count} source records</div>` : ''}`,
      g.price !== null ? `<b>${fmtINR(g.price, g.ccy)}</b><div class="ev">${esc(g.ccy || '')} unit price (source listing, not a confirmed quotation)</div>` : pill('Price unavailable', 'warn'),
      (g.price !== null && qty !== null) ? `<b>${fmtINR(Math.round(g.price * qty * 100) / 100, g.ccy)}</b><div class="ev">unit × ${qty} · partial excl. tax/shipping/delivery</div>` : '<span class="ev">—</span>',
      cmpBudgetCell(g.price, g.ccy, snap),
      pill(g.live ? 'source-backed' : 'partial evidence', g.live ? 'ok' : 'warn') + `<div class="ev">${esc(g.terms)}</div>`,
      g.sources.length > 1 ? `<details><summary>${g.count} source records (expand)</summary><ul class="tight">${g.sources.map((s) => `<li><a href="${esc(s.source_url)}" target="_blank" rel="noopener">View source</a> <span class="ev">${esc(s.data_status || '')} · ${esc(fmtDate(s.retrieved_at))} · <span class="mono">${esc(s.offer_id)}</span></span></li>`).join('')}</ul></details>`
        : (g.sources.length === 1 ? `<a href="${esc(g.sources[0].source_url)}" target="_blank" rel="noopener">View source</a><div class="ev">${esc(g.sources[0].data_status || '')} · ${esc(fmtDate(g.sources[0].retrieved_at))}</div>` : '<span class="ev">—</span>'),
    ];
    return `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  };
  const cardHtml = (d2, pos, total) => {
    const shortIds = d2.members.map((m) => esc(String(m.product_id).slice(-8))).join(', ');
    return `<div class="card" style="margin:8px 0"><p><b>${esc(d2.name)}</b></p>` +
    `<p>${scoreBadge(d2)} ${cmpMandatoryCell(d2.members[0].product_id, snap, mandCount)}` +
    (d2.members.length > 1 ? ` <span class="pill">×${d2.members.length} candidate records</span>` : '') + `</p>` +
    `<p class="ev">Discovery ${pos} of ${total} — discovery order, not a recommendation.` +
    (d2.members.length > 1 ? ` ${d2.members.length} stored candidate records share this identity (history preserved, shown once): <span class="mono">${shortIds}</span>.` : '') + `</p>` +
    (d2.hasOffers
      ? `<details><summary><b>${d2.offerGroups.length} merchant groups · ${d2.sourceRows} source offer rows</b> (expand)</summary>` +
        `<div class="scrollbox"><table><tr>${CMP_COLS.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>${d2.offerGroups.map(offerRowHtml).join('')}</table></div></details>`
      : `<p>${pill('Price unavailable', 'warn')} <span class="ev">No merchant offers for this candidate — no prices or sellers shown.</span></p>`) +
    `</div>`;
  };
  el.innerHTML = `<div class="card"><h3>Comparison (${products.length} distinct products${scored ? '' : ' — provisional order, no scores'})</h3>
  ${headNote}
  ${summary}
  <p class="ev">Scores below are stored backend results (deterministic engine; missing inputs excluded, never zero). A higher card with thin evidence is still thin evidence — see Decision.</p>
  ${eligibilityHtml(snap)}
  ${Object.keys(weights).length ? `<p><b>Configured weights:</b> <span class="ev">${esc(Object.entries(weights).map(([k, v]) => `${k}=${v}`).join(' · '))}</span></p>
  ${cfg?.notes ? `<p class="ev">${esc(cfg.notes)}</p>` : ''}` : '<p class="ev">No saved weight config; engine defaults applied.</p>'}
  <h4>Candidates with offers (${withOffers.length})</h4>
  ${withOffers.map((d2, i) => cardHtml(d2, i + 1, products.length)).join('') || '<p class="muted">None.</p>'}
  <h4>Candidates without offers (${withoutOffers.length})</h4>
  <p class="ev">Clearly separated: these have no merchant offers, so no prices, sellers, or budget verdicts are shown for them.</p>
  ${withoutOffers.map((d2, i) => cardHtml(d2, withOffers.length + i + 1, products.length)).join('') || '<p class="muted">None.</p>'}
  <p class="ev">Grouping is display-only: identical candidate identities collapse with a record count, and equivalent offers (same merchant, price, currency) collapse with a source-record count; every source row stays expandable above. Variants, sellers, prices, and currencies always stay distinct.</p>
  ${evidenceLegendHtml()}
  ${rawBlock({ weights, distinct_products: products.length, candidate_records: rows.length }, 'Scoring config + counts (raw JSON)')}</div>`;
}

/* ---- decision ---- */
function tabDecision(el, snap) {
  const d = snap.decision;
  if (!d) { el.innerHTML = emptyState('Decision', 'No decision recorded yet — the Decision Agent runs after comparison.', 'Run the pipeline from the Request step, then return here.'); return; }
  const next = nextActionText(d);
  const cls = d.decision === 'PROCEED' ? 'ok' : 'warn';
  el.innerHTML = `<div class="card">${decisionStaleHtml(snap)}
  <div class="hero-outcome">${pill(humanDecision(d.decision), cls, d.decision)}<div><b>${esc(String(d.decision_reason || 'No reason recorded.').slice(0, 220))}</b><div class="ev">${esc(next.split('. ')[0])}.</div></div></div>
  <h4>Permitted next action</h4><p>${esc(next)}</p>
  <details><summary>Why this decision (policy reasons)</summary>
  ${(d.blocking_reasons || []).length ? `<h4>Blockers</h4><ul class="tight">${d.blocking_reasons.map((b) => `<li>${esc(b)}</li>`).join('')}</ul><p class="ev">Resolve the items above (or, where policy allows, record an explicit human approval with written justification) to move forward.</p>` : '<p class="ev">No blockers recorded.</p>'}
  <h4>Criteria</h4><p class="ev">Used: ${esc((d.criteria_used || []).join(', ') || '—')}<br>Missing (excluded, renormalized): ${esc((d.criteria_missing || []).join(', ') || '—')}</p>
  <h4>Evidence</h4><p class="ev">${evLinks(d.evidence_urls) || '—'}</p></details>
  <p class="ev">A decision is a policy recommendation from evidence — it is not an approval and places no order.</p>
  ${rawBlock(d, 'Decision record (raw JSON)')}</div>`;
  const rb = el.querySelector('#stale-rerun');
  if (rb) rb.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api(`/api/cases/${encodeURIComponent(snap.procurement.procurement_id)}/pipeline/run`, { method: 'POST', body: '{}' });
      refreshCaseView(snap.procurement.procurement_id, 'decision');
    } catch (err) { document.getElementById('stale-out').innerHTML = `<div class="err">${esc(err.message)}</div>`; e.target.disabled = false; }
  });
}

/* ---- negotiation simulator ---- */
// Mirrors tools/_lib/lifecycle.js TRANSITIONS for the demo_negotiating entry:
// a new DEMO proposal is legal only from pre-negotiation states (same-state
// re-entry is a harmless no-op server-side). Terminal and post-response states
// must not offer the action — the backend rejects them with 409 by design.
const DEMO_NEGOTIABLE_FROM = ['created', 'partial', 'decided', 'demo_negotiating'];
const TERMINAL_CASE = ['closed', 'purchase_handoff'];
function eligibleOffers(snap) {
  return (snap.offers || []).filter((o) =>
    num(o.net_price) !== null && num(o.net_price) > 0 && o.currency &&
    (snap.vendors || []).some((v) => v.vendor_id === o.vendor_id && v.vendor_name && v.vendor_name !== 'unavailable'));
}
function tabNegotiation(el, snap) {
  const p = snap.procurement;
  const negos = snap.negotiations || [];
  const elig = eligibleOffers(snap);
  el.innerHTML = `<div class="card"><h3>Negotiation simulator</h3>
  <div class="notice">Simulation only: proposals are generated from real offer data and <b>never sent</b> to any vendor. No email, API message, or external communication occurs.</div>
  <div id="nmsg"></div>
  ${negos.length ? `<h4>Existing proposals (${negos.length})</h4>` + negos.map((n) => {
    const o = (snap.offers || []).find((x) => x.offer_id === n.offer_id);
    const v = (snap.vendors || []).find((x) => x.vendor_id === n.vendor_id);
    return `<div class="card" style="margin:8px 0"><p>${pill(humanStatus(n.status), n.status === 'DEMO_RESPONSE_RECEIVED' || n.status === 'READY_FOR_HUMAN_REVIEW' ? 'ok' : '', n.status)} ${pill(n.mode || 'REAL', (n.mode || 'REAL') === 'DEMO' ? 'demo' : 'real')}</p>
    <p class="small">${esc(v?.vendor_name || '')} — ${o && num(o.net_price) !== null ? fmtINR(num(o.net_price), o.currency) : 'price unavailable'} → target ${num(n.target_price) !== null ? fmtINR(num(n.target_price), n.currency) : 'unavailable'}</p>
    <p class="ev">do_not_send: ${esc(n.do_not_send)} · human_confirmation: ${esc(n.human_confirmation)}</p>
    ${rawBlock(n, 'Negotiation record (raw JSON)')}</div>`;
  }).join('') : '<p class="muted">No proposals yet.</p>'}
  ${p.mode === 'DEMO' ? `
  <h4>Generate negotiation proposal</h4>
  ${!DEMO_NEGOTIABLE_FROM.includes(p.status)
    ? (TERMINAL_CASE.includes(p.status)
      ? `<p class="muted">This case is <b>${esc(p.status)}</b> (terminal state) — no new proposals can be created. The proposal(s) above are immutable history.</p>`
      : `<p class="muted">No new proposals can start while the case is <b>${esc(p.status)}</b> — continue from the existing proposal(s) above. History is preserved.</p>`)
    : (elig.length ? `<label>Offer with verified price (real merchant · numeric price · known currency — policy eligibility is decided separately)<select id="n-offer">${groupEligibleOffers(elig, snap).map((g) => offerOption(g.candidate, snap, g)).join('')}</select></label>
  <p class="ev">Distinct candidates by product · merchant · unit price · currency · source status (${groupEligibleOffers(elig, snap).length} distinct from ${elig.length} source rows; repeats grouped, never deleted). <a href="${esc((elig[0] || {}).source_url || '#')}" target="_blank" rel="noopener">Verify first source</a> — full links in Vendors &amp; Offers.</p>
  <label>Target price (optional; else budget-derived)<input id="n-target" type="number" step="0.01"></label>
  <button id="n-go">Generate negotiation proposal</button><div id="n-out"></div>`
  : '<p class="err">No eligible offers: need a real merchant, real numeric price and known currency. Missing data is never filled in.</p>')}`
  : `${ME.canDemo && elig.length && !TERMINAL_CASE.includes(p.status) ? `
  <h4>Generate REAL proposal (unsent internal draft)</h4>
  <p class="ev">Proposal-only: drafted from verified offer facts, never sent. Target defaults to the procurement budget rule; you may set an explicit target instead.</p>
  <label>Offer with verified price<select id="r-offer">${groupEligibleOffers(elig, snap).map((g) => offerOption(g.candidate, snap, g)).join('')}</select></label>
  <label>Target price (optional; must be positive and at most list price)<input id="r-target" type="number" step="0.01"></label>
  <button id="r-go">Generate REAL proposal</button><div id="r-out"></div>`
  : (TERMINAL_CASE.includes(p.status)
    ? `<p class="muted">This case is <b>${esc(p.status)}</b> (terminal state) — no new proposals can be created. Existing records above are immutable history.</p>`
    : `<p class="muted">Switch this case to DEMO mode (Demo controls below) to simulate negotiation. REAL mode stays blocked without a verified contact channel — correctly.</p>`)}`}
  </div>
  <div class="card" id="demo-neg"><h3>Demo controls</h3><div id="demo-neg-body"></div></div>`;
  renderDemoNegotiation(snap, elig);
  const rgo = document.getElementById('r-go');
  if (rgo) rgo.addEventListener('click', async (e) => {
    e.target.disabled = true;
    const out = document.getElementById('r-out');
    try {
      const t = document.getElementById('r-target').value;
      const r = await api(`/api/cases/${encodeURIComponent(p.procurement_id)}/negotiations`, { method: 'POST', body: JSON.stringify({ offer_id: document.getElementById('r-offer').value, ...(t ? { target_price: Number(t) } : {}) }) });
      out.innerHTML = `<div class="okmsg">REAL proposal ${esc(r.status)}${r.existing ? ' (already existed — returned, not duplicated)' : ''}. Target ${esc(r.target_price)} ${esc(r.currency || '')} (basis: ${esc(r.target_basis || 'budget rule')}). Nothing sent.</div>`;
      setTimeout(() => refreshCaseView(p.procurement_id, 'negotiation'), 1200);
    } catch (err) { out.innerHTML = `<div class="err">${esc(err.message)}</div>`; e.target.disabled = false; }
  });
}
async function renderDemoNegotiation(snap, elig) {
  const host = document.getElementById('demo-neg-body');
  const msg = document.getElementById('nmsg');
  const p = snap.procurement;
  if ((p.mode || 'REAL') !== 'DEMO') {
    host.innerHTML = TERMINAL_CASE.includes(p.status)
      ? `<p class="muted">This case is <b>${esc(p.status)}</b> (terminal state) — mode can no longer be switched. History is preserved.</p>`
      : `<p class="small">REAL mode: negotiation stays blocked without a verified contact channel (correct behavior).</p>
    <label>Reason for switching to DEMO (required)<input id="d-reason" maxlength="300" placeholder="e.g. live demonstration, no vendor contact"></label>
    <button id="d-go">Switch this case to DEMO</button>`;
    const dgo = document.getElementById('d-go');
    if (!dgo) return;
    dgo.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const reason = document.getElementById('d-reason').value;
        await api(`/api/cases/${encodeURIComponent(p.procurement_id)}/demo/mode`, { method: 'POST', body: JSON.stringify({ reason }) });
        refreshCaseView(p.procurement_id, 'negotiation');
      } catch (err) { msg.innerHTML = `<div class="err">${esc(err.message)}</div>`; e.target.disabled = false; }
    });
    return;
  }
  host.innerHTML = `<p>${pill('PROCUREMENT MODE: DEMO', 'demo')} ${pill('NO REAL VENDOR CONTACTED', 'demo')}</p>`;
  const go = document.getElementById('n-go');
  if (go) go.addEventListener('click', async (e) => {
    e.target.disabled = true;
    const out = document.getElementById('n-out');
    try {
      const t = document.getElementById('n-target').value;
      const r = await api(`/api/cases/${encodeURIComponent(p.procurement_id)}/demo/negotiations`, { method: 'POST', body: JSON.stringify({ offer_id: document.getElementById('n-offer').value, ...(t ? { target_price: Number(t) } : {}) }) });
      out.innerHTML = `<div class="okmsg">Proposal generated — status ${esc(r.status)}. Nothing was sent (sent: false, vendors_contacted: 0).</div>
        <h4>Proposal text (unsent draft)</h4><p><b>${esc(r.message.subject)}</b></p><p style="white-space:pre-wrap">${esc(r.message.body)}</p>
        <p class="small">Facts used:</p><ul class="tight">${r.message.facts_used.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        <p class="small">Requested changes:</p><ul class="tight">${r.message.requested_changes.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`;
      setTimeout(() => refreshCaseView(p.procurement_id, 'negotiation'), 1200);
    } catch (err) { out.innerHTML = `<div class="err">${esc(err.message)}</div>`; e.target.disabled = false; }
  });
}

/* ---- re-evaluation ---- */
function tabReeval(el, snap) {
  const p = snap.procurement;
  const re = snap.reevaluations || [];
  const nego = (snap.negotiations || []).find((n) => n.mode === 'DEMO') || (snap.negotiations || [])[0] || null;
  const demo = (snap.demo_responses || []).filter((r) => !nego || r.negotiation_id === nego.negotiation_id).at(-1) || null;
  el.innerHTML = `<div class="card"><h3>Re-evaluation</h3><div id="rmsg"></div>
  ${!re.length ? '<p class="muted">No re-evaluation yet. It requires a real vendor response, or a manually entered demo response in DEMO mode.</p>' : ''}
  ${re.map((r) => `<div class="card" style="margin:8px 0">
    <p>${pill('REEVALUATED', 'ok')} ${pill(r.mode || 'REAL', (r.mode || 'REAL') === 'DEMO' ? 'demo' : 'real')}</p>
    <table><tr><th></th><th>Original</th><th>Revised</th></tr>
    <tr><td>Price</td><td>${r.original_price ?? 'unavailable'} ${esc(r.currency || '')}</td><td>${r.revised_price ?? 'unavailable'} ${esc(r.currency || '')}</td></tr>
    <tr><td>Score</td><td>${r.original_score ?? 'unavailable'}</td><td>${r.revised_score ?? 'unavailable'}</td></tr>
    <tr><td>Savings (unit)</td><td colspan="2">${r.absolute_savings ?? 'unavailable'}${r.percentage_savings != null ? ` (${r.percentage_savings}%)` : ''}</td></tr>
    ${(() => { const q = Number(snap.procurement.quantity) > 0 ? Number(snap.procurement.quantity) : null;
      const s = (r.absolute_savings != null && !isNaN(Number(r.absolute_savings))) ? Number(r.absolute_savings) : null;
      if (q === null || s === null) return '<tr><td>Est. total savings</td><td colspan="2"><span class="ev">unavailable (needs quantity + unit savings)</span></td></tr>';
      return `<tr><td>Est. total savings</td><td colspan="2">≈ ${fmtINR(Math.round(s * q * 100) / 100, r.currency)} <span class="ev">(unit ${fmtINR(s, r.currency)} × ${q}; partial: excl. tax/shipping/delivery)</span></td></tr>`; })()}</table>
    <p class="ev">Score delta ${esc(r.score_delta ?? '—')} · criteria changed: ${esc((r.criteria_changed || []).join(', ') || 'none')} · A lower price does not automatically raise the score — only re-scored criteria move it.</p>
    ${(r.criteria_used || []).length <= 1 && r.revised_score != null ? `<p class="notice">Partial score: revised ${esc(r.revised_score)} reflects only ${(r.criteria_used || []).join(', ') || 'one criterion'} — not a complete overall score. Original had no scoring basis (null, never zero-filled).</p>` : ''}
    ${r.mode === 'DEMO' ? '<p class="notice">Hypothetical DEMO price — explicitly not a verified vendor quotation; never a REAL price.</p>' : ''}
    ${(r.criteria_used || []).length ? `<p class="ev">Provenance: ${(r.criteria_used || []).map((k) => `${esc(k)} via ${esc(r.score_provenance?.criteria?.[k]?.method || r.score_provenance?.[k]?.method || (k === 'budget_compliance' ? 'boolean_in_budget (revised_price_vs_budget)' : 'engine carryover'))}`).join(' · ')}</p>` : ''}
    ${rawBlock(r, 'Re-evaluation record (raw JSON)')}</div>`).join('')}
  ${p.mode === 'DEMO' && nego && demo && !re.some((r) => r.negotiation_id === nego.negotiation_id)
    ? (p.status === 'demo_response_received' ? `
    <h4>Demo vendor response (manually entered — read it before scoring)</h4>
    <p class="notice">Simulation only: this response was entered locally for demonstration. It is not a real vendor quotation and has not been verified with the merchant.</p>
    <table><tr><td>Revised price</td><td><b>${fmtINR(Number(demo.revised_price), demo.currency)}</b></td></tr>
    <tr><td>Delivery</td><td>${esc(demo.delivery_days ?? 'unavailable')}</td></tr>
    <tr><td>Warranty</td><td>${esc(demo.warranty ?? 'unavailable')}</td></tr>
    <tr><td>Payment</td><td>${esc(demo.payment_terms ?? 'unavailable')}</td></tr>
    <tr><td>Notes</td><td>${esc(demo.notes ?? '')}</td></tr>
    <tr><td>Provenance</td><td>${pill(demo.response_mode || '', 'demo')} · ${pill(demo.source || '', 'demo')} · verified: ${esc(demo.vendor_response_verified)} · by ${esc(demo.entered_by || '')}</td></tr></table>
    <button id="r-go">Run re-evaluation (existing deterministic engine)</button><div id="r-out"></div>`
    : `<p class="muted">Re-evaluation can run only while the case is <b>demo_response_received</b> — it is now <b>${esc(p.status)}</b>, so no action is offered. History is preserved.</p>`) : ''}
  ${p.mode === 'DEMO' && nego && !demo
    ? (p.status === 'demo_negotiating' ? `
    <h4>Enter the hypothetical vendor response</h4>
    <p class="notice">Simulation only: this response was entered locally for demonstration. It is not a real vendor quotation and has not been verified with the merchant.</p>
    <div class="grid2"><div><label>Revised price (required)<input id="d-price" type="number" step="0.01"></label></div>
    <div><label>Currency (must match offer)<input id="d-ccy" maxlength="3"></label></div></div>
    <div class="grid2"><div><label>Delivery time in days<input id="d-del"></label></div>
    <div><label>Warranty terms<input id="d-war"></label></div></div>
    <label>Payment terms<input id="d-pay"></label>
    <label>Notes or conditions<textarea id="d-notes" rows="2"></textarea></label>
    <button id="d-resp">Submit demo response (nothing is sent)</button><div id="d-out"></div>`
    : `<p class="muted">A demo response can be entered only while the case is <b>demo_negotiating</b> — it is now <b>${esc(p.status)}</b>, so no action is offered. History is preserved.</p>`) : ''}</div>`;
  const wire = (id, fn) => { const b = document.getElementById(id); if (b) b.addEventListener('click', async (e) => { e.target.disabled = true; try { await fn(); refreshCaseView(p.procurement_id, 'reevaluation'); } catch (err) { document.getElementById('rmsg').innerHTML = `<div class="err">${esc(err.message)}</div>`; e.target.disabled = false; } }); };
  wire('d-resp', async () => {
    await api(`/api/cases/${encodeURIComponent(p.procurement_id)}/demo/responses`, { method: 'POST', body: JSON.stringify({
      negotiation_id: nego?.negotiation_id, revised_price: Number(document.getElementById('d-price').value),
      currency: document.getElementById('d-ccy').value.trim().toUpperCase(),
      delivery_days: document.getElementById('d-del').value || 'unavailable',
      warranty: document.getElementById('d-war').value || 'unavailable',
      payment_terms: document.getElementById('d-pay').value || 'unavailable',
      notes: document.getElementById('d-notes').value || '' }) });
  });
  wire('r-go', async () => {
    await api(`/api/cases/${encodeURIComponent(p.procurement_id)}/demo/reevaluate`, { method: 'POST', body: JSON.stringify({ negotiation_id: nego?.negotiation_id }) });
  });
}

/* ---- approval ---- */
function tabApproval(el, snap) {
  const p = snap.procurement;
  const appr = (snap.approvals || [])[0] || null;
  el.innerHTML = `<div class="card"><h3>Human approval ${appr ? pill(humanApproval(appr.status), appr.status === 'APPROVED' ? 'ok' : appr.status === 'PENDING_APPROVAL' ? 'warn' : 'bad', appr.status) + ' ' + pill(appr.mode || 'REAL', (appr.mode || 'REAL') === 'DEMO' ? 'demo' : 'real') : ''}</h3><div id="amsg"></div>
  ${appr ? `<p class="ev">Refers to: offer <span class="mono">${shortRef(appr.selected_offer_id) || '—'}</span> · request v${esc(appr.request_version ?? '—')} · scoring ${esc(appr.scoring_version || 'unrecorded (legacy package)')}.</p>` : ''}
  ${appr && appr.mode === 'DEMO' ? '<div class="notice">DEMO — NOT VERIFIED: figures below may include a manually entered hypothetical response, not a real vendor quotation.</div>' : ''}
  ${p.status === 'closed' && appr?.status === 'APPROVED' && (appr.mode || 'REAL') === 'DEMO' ? '<div class="notice">DEMO simulation — closed by a simulated approval. <b>Not a real purchase authorization; no order placed.</b> Purchase handoff stays blocked for DEMO cases.</div>' : ''}
  ${p.status === 'closed' && (p.mode || 'REAL') === 'DEMO' ? '<p class="ev">Simulated terminal state — distinct from real procurement completion (purchase_handoff).</p>' : ''}
  ${!appr ? `<p class="muted">No approval package yet.</p>
    <p class="small">An approval package is created once there is something real to approve (an offer, optionally with a re-evaluation). Nothing is ever auto-approved.</p>
    <button id="a-create">Create approval package</button><div id="a-out"></div>`
  : `<h4>Package contents</h4>${approvalPackageHtml(appr.approval_package || {})}
    ${appr.status === 'PENDING_APPROVAL' ? (ME.canApprove ? `
    <h4>Record explicit human decision</h4>
    <p>Acting as <b>${esc(ME.username)}</b> (${esc(ME.role)}). Separation of duties, authorization limits, and version freshness are enforced server-side — ineligible decisions are rejected, not hidden.</p>
    <label>Reason ${snap.decision && snap.decision.decision !== 'PROCEED' ? '<b>(required — approving past a ' + esc(snap.decision.decision) + ' decision needs written justification)</b>' : '(optional)'}<input id="a-reason" maxlength="500"></label>
    <div><button data-dec="APPROVED">APPROVE</button>
    <button data-dec="REJECTED" class="danger">REJECT</button>
    <button data-dec="CHANGES_REQUESTED" class="secondary">REQUEST CHANGES</button></div>
    <div id="a-dec-out"></div>
    <p class="ev">Approval requires an explicit action above. Absence, timeouts, page views and drafts are never treated as approval. ${appr.mode === 'DEMO' ? 'This approval is labeled DEMO.' : ''}</p>`
    : '<p class="muted">Your role cannot record approval decisions. Switch to an approver account.</p>')
    : `<p>Decided by <b>${esc(appr.approved_by || '—')}</b> at ${esc(fmtDate(appr.approved_at))}${appr.decision_reason ? ' — ' + esc(appr.decision_reason) : ''}${!appr.decided_by_user_id ? ' <span class="ev">(historical record — actor unattributed, predates authenticated approvals)</span>' : ''}</p>
      ${p.status === 'purchase_handoff' && snap.decision && snap.decision.decision !== 'PROCEED' ? `<div class="notice">Purchase handoff is recorded, but the current decision is <b>${esc(snap.decision.decision)}</b> — current policy forbids new handoffs without PROCEED. Preserved as history; not evidence of an external purchase order.</div>` : ''}`}
  ${p.status === 'closed' && appr?.status === 'APPROVED' && (appr.mode || 'REAL') === 'REAL' ? `
    <h4>Purchase handoff</h4><p class="ev">The approval is recorded. Hand off the approved offer to purchasing as a separate, verified step — approval alone places no order, and a handoff record alone is not proof that a purchase occurred.</p>
    <label>Handoff note (optional)<input id="h-note" maxlength="500" placeholder="e.g. PO-2026-1042 raised by purchasing"></label>
    <div><button id="h-go" class="secondary">Record purchase handoff</button></div><div id="h-out"></div>` : ''}
  ${(snap.approvals || []).length > 1 ? `<details><summary>All approval packages (${(snap.approvals || []).length}) — history is kept</summary><ul class="tight">${(snap.approvals || []).slice(1).map((a) => `<li>${esc(humanApproval(a.status))} · ${esc(a.mode || 'REAL')}${a.approved_by ? ' by ' + esc(a.approved_by) : ''} · <span class="ev">${esc(fmtDate(a.created_at))}</span></li>`).join('')}</ul></details>` : ''}`}</div>
  <div class="card"><h3>Approval history</h3>${approvalEventsHtml(snap)}</div>`;
  const wireHandoff = document.getElementById('h-go');
  if (wireHandoff) wireHandoff.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await api(`/api/cases/${encodeURIComponent(p.procurement_id)}/handoff`, { method: 'POST', body: JSON.stringify({ note: document.getElementById('h-note').value || null }) });
      document.getElementById('h-out').innerHTML = `<div class="okmsg">Purchase handoff recorded — case ${esc(r.status)}.</div>`;
      setTimeout(() => refreshCaseView(p.procurement_id, 'approval'), 900);
    } catch (err) { document.getElementById('h-out').innerHTML = `<div class="err">${esc(err.message)}</div>`; e.target.disabled = false; }
  });
  const wire = (id, fn) => { const b = document.getElementById(id); if (b) b.addEventListener('click', async (e) => { e.target.disabled = true; try { await fn(); refreshCaseView(p.procurement_id, 'approval'); } catch (err) { document.getElementById('amsg').innerHTML = `<div class="err">${esc(err.message)}</div>`; e.target.disabled = false; } }); };
  wire('a-create', async () => {
    const r = await api(`/api/cases/${encodeURIComponent(p.procurement_id)}/approvals`, { method: 'POST', body: '{}' });
    document.getElementById('a-out').innerHTML = `<div class="okmsg">Package ${esc(r.status)} (id ${esc(r.approval_id).slice(0, 8)}).</div>`;
  });
  el.querySelectorAll('[data-dec]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Record ${b.dataset.dec} as ${ME.username}? This is final for this package state.`)) return;
    try {
      const r = await api(`/api/approvals/${encodeURIComponent(appr.approval_id)}/decision`, { method: 'POST', body: JSON.stringify({ decision: b.dataset.dec, reason: document.getElementById('a-reason').value || null }) });
      document.getElementById('a-dec-out').innerHTML = `<div class="okmsg">Recorded ${esc(r.status)} — case ${esc(r.case_status)}.</div>`;
      setTimeout(() => refreshCaseView(p.procurement_id, 'approval'), 900);
    } catch (e) { document.getElementById('a-dec-out').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }));
}
function approvalPackageHtml(pkg) {
  if (!pkg || typeof pkg !== 'object') return '<p class="muted">No package.</p>';
  const row = (k, v) => `<tr><td style="width:220px"><b>${esc(HUMAN_PKG_SECTION[k] || k)}</b> <span class="ev mono" title="internal section name">${esc(k)}</span></td><td>${typeof v === 'object' ? `<pre class="mono" style="white-space:pre-wrap;margin:0">${esc(JSON.stringify(v, null, 1)).slice(0, 1200)}</pre>` : esc(v)}</td></tr>`;
  const order = ['procurement_request', 'selected_product', 'selected_vendor', 'original_offer', 'revised_offer', 'original_score', 'revised_score', 'savings', 'quality_evidence', 'review_evidence', 'delivery_information', 'warranty_information', 'payment_terms', 'criteria_used', 'criteria_missing', 'limitations', 'evidence_urls', 'negotiation_history', 'status'];
  return `<table>${order.filter((k) => pkg[k] !== undefined).map((k) => row(k, pkg[k])).join('')}</table>${rawBlock(pkg, 'Full package (raw JSON)')}`;
}
function approvalEventsHtml(snap) {
  const evs = snap.approval_events || [];
  if (!evs.length) return '<p class="muted">No approval events yet.</p>';
  return `<ul class="timeline">${evs.map((e) => `<li><b>${esc(humanEvent(e.event_type))}</b> — ${esc(e.actor || '')} <span class="ev">${esc(fmtDate(e.created_at || e.timestamp))} · ref <span class="mono">${esc((e.trace_id || '').slice(0, 8))}</span> · <span class="mono" title="internal event code">${esc(e.event_type)}</span></span></li>`).join('')}</ul>`;
}

/* ---- inter-agent trace (coordination evidence) ---- */
async function tabTrace(el, snap) {
  const p = snap.procurement;
  el.innerHTML = '<p class="muted">Loading trace…</p>';
  try {
    const t = await api('/api/cases/' + encodeURIComponent(p.procurement_id) + '/trace');
    const msgs = t.messages || [];
    if (t.pending) {
      el.innerHTML = '<p class="muted">No agent activity yet — the trace appears here automatically as agents start working. Research takes ~1 min; leave this page open.</p>';
      return;
    }
    el.innerHTML = `<p class="ev">Every handoff below is a persisted row in <span class="mono">agent_messages</span> — who asked whom, why, and what changed. Reasons are recorded by the sending agent at execution time. Follow-up loops stay grouped under their parent request, in original order.</p>
    ${msgs.length ? `
    <div class="toolbar"><select id="t-agent" aria-label="Filter by agent"><option value="">All agents</option>${[...new Set(msgs.flatMap((m) => [m.sender_agent, m.recipient_agent]))].sort().map((a) => `<option>${esc(a)}</option>`).join('')}</select>
    <select id="t-type" aria-label="Filter by message type"><option value="">All types</option>${[...new Set(msgs.map((m) => m.message_type))].sort().map((a) => `<option>${esc(a)}</option>`).join('')}</select>
    <select id="t-status" aria-label="Filter by status"><option value="">Any status</option>${[...new Set(msgs.map((m) => m.status))].sort().map((a) => `<option>${esc(a)}</option>`).join('')}</select>
    <select id="t-mode" aria-label="Filter by reasoning mode"><option value="">Any reasoning</option><option>LLM_REASONING</option><option>DETERMINISTIC_FALLBACK</option></select></div>
    <div id="t-list"></div>`
    : '<p class="muted">No coordination messages yet — run the pipeline.</p>'}
    <h4>Agent executions</h4>${execTable((t.executions || []).map((e) => ({ ...e, procurement_id: p.procurement_id })))}`;
    if (!msgs.length) return;
    const byId = Object.fromEntries(msgs.map((m) => [m.message_id, m]));
    const kids = {};
    msgs.forEach((m) => { if (m.parent_message_id && byId[m.parent_message_id]) (kids[m.parent_message_id] ||= []).push(m); });
    const tops = msgs.filter((m) => !(m.parent_message_id && byId[m.parent_message_id]));
    const item = (m, child) => `<li${child ? ' class="thread-child"' : ''}><b>${esc(m.sender_agent)} → ${esc(m.recipient_agent)}</b> ${pill(m.message_type, m.message_type === 'revision_request' ? 'demo' : m.message_type === 'escalation' ? 'warn' : '')} ${pill(m.status)} ${m.reasoning_mode ? pill(m.reasoning_mode, m.reasoning_mode === 'LLM_REASONING' ? 'real' : '') : ''}${m.llm_model ? ` <span class="ev">${esc(m.llm_model)}</span>` : ''}${!child && (kids[m.message_id] || []).length ? ` <span class="loop-tag">follow-up loop (${kids[m.message_id].length})</span>` : ''}
      <div>${esc(m.objective)}</div>
      ${m.requested_action ? `<div class="small">Requested: ${esc(m.requested_action)}</div>` : ''}
      ${m.reason ? `<div class="small">Why: ${esc(m.reason)}</div>` : ''}
      ${(m.tool_calls || []).length ? `<div class="ev">Tools: ${esc(m.tool_calls.map((x) => x.tool + ' ×' + (x.calls ?? 1) + (x.failures ? ' (' + x.failures + ' failed)' : '')).join(', '))}</div>` : ''}
      ${(m.evidence_refs || []).length ? `<div class="ev">Evidence: ${evLinks(m.evidence_refs)}</div>` : ''}
      <div class="ev">${esc(fmtDate(m.created_at))}${m.latency_ms != null ? ' · ' + esc(m.latency_ms) + ' ms' : ''} · trace <span class="mono">${esc((m.trace_id || '').slice(0, 8))}</span></div>
      ${rawBlockIf({ payload: (m.payload && Object.keys(m.payload).length ? m.payload : undefined) }, 'Technical details (raw JSON)')}</li>`;
    const drawList = () => {
      const fa = document.getElementById('t-agent').value, ft = document.getElementById('t-type').value;
      const fs = document.getElementById('t-status').value, fm = document.getElementById('t-mode').value;
      const keep = (m) => (!fa || m.sender_agent === fa || m.recipient_agent === fa) && (!ft || m.message_type === ft) && (!fs || m.status === fs) && (!fm || m.reasoning_mode === fm);
      const rows = [];
      for (const m of tops) {
        const kc = (kids[m.message_id] || []).filter(keep);
        if (keep(m) || kc.length) {
          if (keep(m)) rows.push(item(m, false));
          for (const c of kc) rows.push(item(c, true));
        }
      }
      document.getElementById('t-list').innerHTML = rows.length
        ? `<div class="scrollbox tall"><ul class="timeline">${rows.join('')}</ul></div>`
        : '<p class="muted">No messages match these filters.</p>';
    };
    ['t-agent', 't-type', 't-status', 't-mode'].forEach((id) => document.getElementById(id).addEventListener('change', drawList));
    drawList();
  } catch (e) { el.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

/* ---- audit trail ---- */
function tabAudit(el, snap) {
  const rows = snap.audit || [];
  const neg = snap.negotiation_events || [];
  if (!rows.length && !neg.length) { el.innerHTML = '<div class="card"><h3>Audit trail</h3><p class="muted">No events recorded yet.</p></div>'; return; }
  el.innerHTML = `<div class="card"><h3>Audit trail (${rows.length + neg.length} events)</h3>
  <p class="ev">Every entry below is a persisted record — who or what acted, when, and with what outcome. Nothing here is edited or removed for display.</p>
  <ul class="timeline">${rows.slice(0, 100).map((a) => `<li><b>${esc(humanEvent(a.event))}</b> <span class="ev">by ${esc(a.agent_name || '')} · ${esc(fmtDate(a.created_at))}${a.trace_id ? ' · ref <span class="mono">' + esc(String(a.trace_id).slice(0, 8)) + '</span>' : ''} · <span class="mono" title="internal event code">${esc(a.event || '')}</span></span></li>`).join('')}
  ${neg.map((e) => `<li><b>negotiation</b> — ${esc(humanEvent(e.event_type))} <span class="ev">${esc(fmtDate(e.created_at))} · <span class="mono" title="internal event code">${esc(e.event_type)}</span></span></li>`).join('')}</ul>
  ${rawBlock({ audit: rows.slice(0, 10), negotiation_events: neg.slice(0, 10) }, 'Sample raw events (no secrets are ever logged)')}</div>`;
}

/* ---- scoring engine summary (deterministic component, not an agent) ---- */
function tabScoring(el, snap) {
  const rows = snap.comparisons || [];
  const cfg = Array.isArray(snap.scoring_configs) ? snap.scoring_configs[0] : snap.scoring_configs;
  const weights = (cfg && cfg.weights) || {};
  if (!rows.length) { el.innerHTML = '<p class="muted">No scores computed yet — run the pipeline.</p>'; return; }
  const scored = rows.filter((r) => typeof r.overall_score === 'number');
  const top = [...rows].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)).slice(0, 3);
  el.innerHTML = `<p class="ev">Deterministic engine (code, not an LLM, not an agent): weighted sum over <b>available</b> criteria only; missing criteria are excluded from numerator and denominator (renormalized), never zero-filled. Agents read these scores; nothing rewrites them.</p>
  ${Object.keys(weights).length ? `<p><b>Weights:</b> <span class="ev">${esc(Object.entries(weights).map(([k, v]) => `${k}=${v}`).join(' · '))}</span></p>` : '<p class="ev">Engine defaults (no saved config).</p>'}
  <p>Scored ${scored.length}/${rows.length} (null = no basis, never "bad"). Top: ${top.map((r) => `#${r.rank} ${r.overall_score == null ? '—' : Number(r.overall_score).toFixed(3)}`).join(' · ')}</p>
  <p class="ev">Used: ${esc([...new Set(rows.flatMap((r) => r.criteria_used || []))].join(', ') || '—')}<br>Missing (excluded): ${esc([...new Set(rows.flatMap((r) => r.criteria_missing || []))].join(', ') || '—')}</p>`;
}

/* ================= guided pipeline (default case view) ================= */
const expandedStages = new Set();
const STAGE_RENDER = { product_research: tabProducts, vendor_research: tabVendors, review_quality: tabQuality,
  comparison: tabComparison, scoring: tabScoring, decision: tabDecision,
  negotiation: tabNegotiation, reevaluation: tabReeval, approval: tabApproval };

// one-line result + reason per stage, from persisted backend data only
function stageSummary(key, snap) {
  const P = snap.products || [], O = snap.offers || [], V = snap.vendors || [], Q = snap.quality_evaluations || [];
  switch (key) {
    case 'product_research':
      if (!P.length) return { text: 'No products yet — research runs automatically.', why: '' };
      return { text: `${P.length} relevant products from live providers (${P.filter((p) => p.data_status === 'LIVE').length} fully live).`,
        why: 'Titles link to their real sources; unverified specs stay unavailable.' };
    case 'vendor_research': {
      if (!O.length) return { text: `${V.length} merchant record(s), no verified offers yet.`,
        why: 'A listing becomes an offer only with merchant + price + currency + source URL.' };
      const uniq = new Set(V.map((v) => String(v.vendor_name || '').toLowerCase())).size;
      const prices = O.filter((o) => num(o.net_price) !== null).map((o) => ({ p: num(o.net_price), c: String(o.currency || snap.procurement.currency || '') }));
      const byCcy = new Map();
      for (const { p, c } of prices) {
        if (!byCcy.has(c)) byCcy.set(c, []);
        byCcy.get(c).push(p);
      }
      const range = byCcy.size ? ' ' + [...byCcy.entries()].map(([c, ps]) => `(${fmtINR(Math.min(...ps), c)} – ${fmtINR(Math.max(...ps), c)})`).join(' ') : '';
      const st = enrichmentStats(snap);
      return { text: `${uniq} unique merchants · ${O.length} source offer record(s)${range}.`,
        why: st ? `Strict rule accepted ${st.offers}, rejected ${st.skipped ?? 0} without inventing data. Delivery, warranty and payment terms are mostly unverified.` : 'Delivery, warranty and payment terms are mostly unverified — shown as such, never inferred.' };
    }
    case 'review_quality': {
      if (!Q.length) return { text: 'No quality evaluations yet.', why: '' };
      const h = Q.filter((q) => q.source_quality === 'HIGH').length, l = Q.filter((q) => q.source_quality === 'LOW').length;
      return { text: `${Q.length} evaluated · ${h} strong, ${Q.length - h - l} partial, ${l} weak · ${Q.filter((q) => q.review_rating == null).length} without ratings.`,
        why: 'Grades rate evidence strength, not the product. Ratings attach only on strict evidence patterns.' };
    }
    case 'comparison': {
      const rows = snap.comparisons || [];
      if (!rows.length) return { text: 'Nothing compared yet.', why: '' };
      const scoredN = rows.filter((r) => typeof r.overall_score === 'number' && isFinite(r.overall_score)).length;
      const top = [...rows].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))[0];
      const off = O.find((o) => o.product_id === top.product_id);
      const v = V.find((x) => x.vendor_id === off?.vendor_id);
      const ccy = {};
      for (const o of O) (ccy[o.product_id] ||= new Set()).add(String(o.currency));
      const conflicts = Object.values(ccy).filter((s) => s.size > 1).length;
      return { text: `${rows.length} compared · ${scoredN} scored · first in discovery order: ${v?.vendor_name || 'no merchant'}${off && num(off.net_price) !== null ? ' ' + fmtINR(num(off.net_price), off.currency) : ' (no offer)'}${conflicts ? ` · ${conflicts} currency conflict(s) flagged` : ''}.`,
        why: 'Order reflects evidence quality and available criteria — not a purchase recommendation.' };
    }
    case 'scoring': {
      const rows = snap.comparisons || [];
      if (!rows.length) return { text: 'No scores computed yet.', why: '' };
      const top = [...rows].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))[0];
      const used = [...new Set(rows.flatMap((r) => r.criteria_used || []))];
      const miss = [...new Set(rows.flatMap((r) => r.criteria_missing || []))];
      return { text: `Top score ${top.overall_score == null ? '—' : Number(top.overall_score).toFixed(3)} · ` +
        ((!used.length && !miss.length) ? 'no criterion metadata recorded on these rows' : `${used.length} criteria used, ${miss.length} excluded`) + '.',
        why: 'Deterministic code, not an LLM agent: missing inputs are excluded and renormalized, never zero-filled.' };
    }
    case 'decision': {
      const d = snap.decision;
      if (!d) return { text: 'No decision yet — runs after comparison.', why: '' };
      return { text: `${d.decision} — ${String(d.decision_reason || '').slice(0, 160)}`,
        why: `Next: ${nextActionText(d)}` };
    }
    case 'negotiation': {
      const n = snap.negotiations || [];
      if (!n.length) return { text: snap.decision ? 'No proposal yet.' : 'Waiting for a decision first.',
        why: (snap.procurement.mode || 'REAL') === 'REAL' ? 'REAL mode stays blocked without a verified contact channel — correctly.' : 'DEMO mode enables local simulation.' };
      const last = n[n.length - 1];
      return { text: `${n.length} proposal(s) · latest ${last.status} (${last.mode}).`,
        why: 'Proposal only — nothing was sent to any vendor.' };
    }
    case 'reevaluation': {
      const r = snap.reevaluations || [];
      if (!r.length) return { text: 'No re-evaluation yet.', why: 'Needs a real vendor response or a manually entered DEMO response.' };
      const last = r[r.length - 1];
      return { text: `Re-scored · savings ${last.absolute_savings ?? 'unavailable'} ${last.currency || ''} (${last.percentage_savings ?? '—'}%) · score ${last.original_score} → ${last.revised_score}.`,
        why: 'A lower price does not automatically raise the score — only re-scored criteria move it.' };
    }
    case 'approval': {
      const a = (snap.approvals || [])[0];
      if (!a) return { text: 'No approval package yet.', why: 'Nothing is ever auto-approved.' };
      return { text: `${a.status}${a.approved_by ? ` by ${a.approved_by}` : ''} (${a.mode || 'REAL'}).`,
        why: a.status === 'PENDING_APPROVAL' ? 'Waiting for an explicit human decision.' : 'Recorded with actor identity.' };
    }
    default: return { text: '', why: '' };
  }
}
async function viewPipeline(id) {
  navActive(''); stopPoll();
  currentRefresh = () => viewPipeline(id);
  const snap = await api('/api/cases/' + encodeURIComponent(id));
  const stages = await api('/api/cases/' + encodeURIComponent(id) + '/stages').catch(() => null);
  const p = snap.procurement;
  setHead('Pipeline ' + p.procurement_id.slice(0, 8),
    String(p.requirement || '').slice(0, 120),
    `${statusPill(p.status)} ${modePill(p.mode)}`);
  const done = (stages?.stages || []).filter((s) => s.status === 'completed').length;
  const elig = eligibleOffers(snap);
  const canDemo = (p.mode || 'REAL') === 'REAL' && !TERMINAL_CASE.includes(p.status) && snap.decision && elig.length > 0 && !(snap.negotiations || []).some((n) => n.mode === 'DEMO');
  const appr = (snap.approvals || [])[0] || null;
  const inc = incompleteCount(snap);
  const dec = snap.decision;
  const ns = nextStepInfo(snap);
  let ownerName = null;
  try {
    const cl = await api('/api/cases');
    ownerName = (cl.cases || []).find((c) => c.procurement_id === id)?.owner_username || null;
  } catch { /* owner stays unresolved */ }
  let primary = '';
  if (!(snap.products || []).length && !dec) primary = '<span class="ev">Waiting for research — stages start automatically.</span> <button id="rp-go" class="secondary">Check now</button>';
  else if (!dec) primary = ME.canRunPipeline ? '<button id="rp-go">Run pipeline</button>' : '<span class="ev">Waiting for a procurement officer to run the pipeline.</span><button id="rp-go" class="secondary" style="display:none">Run</button>';
  else if (canDemo) primary = ME.canDemo
    ? `<input id="rp-reason" maxlength="300" placeholder="Reason for DEMO (required)" style="max-width:280px;display:inline-block"> <button id="rp-demo" class="secondary">Continue in DEMO</button> <button id="rp-go" class="secondary">Re-run pipeline</button>`
    : '<span class="ev">A procurement officer can continue this case in DEMO mode.</span><button id="rp-go" class="secondary" style="display:none">Run</button>';
  else if (appr?.status === 'PENDING_APPROVAL') primary = '<button class="secondary" data-go="stage-approval">Review approval</button> <button id="rp-go" class="secondary">Re-run pipeline</button>';
  else if (p.status === 'closed') primary = '<span class="ev">Completed — see the audit trail below.</span><button id="rp-go" class="secondary" style="display:none">Run</button>';
  else primary = ME.canRunPipeline ? '<button id="rp-go">Resume pipeline</button>' : '<span class="ev">Waiting for a procurement officer.</span><button id="rp-go" class="secondary" style="display:none">Run</button>';
  app.innerHTML = `
  <div class="card"><p class="ov-req"><b>Requirement:</b> ${esc(p.requirement || '')}</p>
    <div class="ov-grid">
      <div><div class="muted small">Quantity / Budget</div><div><b>${esc(p.quantity ?? '—')} · ${p.budget != null ? fmtINR(Number(p.budget), p.currency) : '—'}</b></div></div>
      <div><div class="muted small">Products found</div><div><b>${(snap.products || []).length}</b></div></div>
      <div><div class="muted small">Source offer records</div><div><b>${(snap.offers || []).length}</b></div></div>
      <div><div class="muted small">Items needing evidence</div><div><b>${inc.total}</b> <span class="ev">(${inc.noSpecs} specs · ${inc.noRating} ratings · ${inc.noTerms} terms)</span></div></div>
      <div><div class="muted small">Decision</div><div>${dec ? `${pill(humanDecision(dec.decision), dec.decision !== 'PROCEED' ? 'warn' : 'ok', dec.decision)}` : '<span class="muted">Pending</span>'}</div>${dec ? `<div class="ev">${esc(String(dec.decision_reason || '').slice(0, 140))}</div>` : ''}</div>
      <div><div class="muted small">Reasoning</div><div><span id="rmode" class="ev">checking…</span></div></div>
      <div><div class="muted small">Owner</div><div><b>${esc(ownerName || 'unassigned')}</b> <span class="ev">· v${esc(p.version ?? 1)}</span></div></div>
      <div><div class="muted small">Next action (${esc(ns.owner)})</div><div>${esc(ns.action)}</div></div>
    </div>
    <div class="ov-actions">${primary}</div>
    <div id="pmsg"></div><div id="rp-out"></div>
    <details><summary class="ev">Case details</summary><p class="ev">Status ${esc(p.status)} · Mode ${esc(p.mode || 'REAL')} · Created ${esc(fmtDate(p.created_at))}</p>
    ${p.status === 'purchase_handoff' && dec && dec.decision !== 'PROCEED'
      ? `<div class="notice">A purchase handoff is recorded on this case while its current decision is <b>${esc(dec.decision)}</b>. Current policy forbids new handoffs without a PROCEED decision; this record is preserved as history and is not evidence of an external purchase order.</div>` : ''}
    <p class="caseid">${copyRefHtml(p.procurement_id)}</p></details></div>
  <div id="steps"></div>
  <div class="card"><h3>Detailed inspection</h3><p class="small">${TABS.map(([k, label]) => `<a href="#/case/${esc(p.procurement_id)}/${k}">${label}</a>`).join(' · ')}</p></div>
  <div id="pollnote"></div>`;
  wireCopyButtons(app);
  const copyBtn = document.getElementById('copy-id');
  if (copyBtn) copyBtn.addEventListener('click', (e) => copyId(e.target, p.procurement_id));
  const byKey = Object.fromEntries((stages?.stages || []).map((s) => [s.key, s]));
  const order = [['product_research', tabProducts], ['vendor_research', tabVendors], ['review_quality', tabQuality],
    ['comparison', tabComparison], ['scoring', null], ['decision', tabDecision],
    ['negotiation', tabNegotiation], ['reevaluation', tabReeval], ['approval', tabApproval]];
  document.getElementById('steps').innerHTML = `<div class="pipenav"><span class="t">Stages (${done}/9):</span>${order.map(([k], i) => {
    const s = byKey[k] || {};
    const short = ['Products', 'Vendors', 'Quality', 'Compare', 'Scoring', 'Decision', 'Negotiate', 'Re-eval', 'Approve'][i];
    return `<a data-go="stage-${k}" class="${s.status === 'completed' ? 'done' : ''}">${i + 1} ${short}</a>`;
  }).join('')}<a data-go="stage-trace">Trace</a></div>` + order.map(([k], i) => {
    const s = byKey[k] || { name: k, status: 'pending', summary: '', missing: [], source: 'none', responsibility: '' };
    const sum = stageSummary(k, snap);
    const open = expandedStages.has(k);
    return `<div class="card step ${s.status}" id="stage-${k}">
      <div class="step-head"><span class="step-num">${i + 1}</span><h3>${esc(s.name)}</h3>${stagePill(s.status)}${s.latency_ms != null ? `<span class="ev">${esc(s.latency_ms)} ms</span>` : ''}</div>
      ${s.responsibility ? `<p class="small muted">${esc(s.responsibility)}</p>` : ''}
      <p class="step-sum">${esc(sum.text)}</p>
      ${sum.why ? `<p class="step-why">${esc(sum.why)}</p>` : ''}
      ${s.error ? `<p class="err">${esc(s.error)}</p>` : ''}
      <button class="secondary" data-toggle="${k}" aria-expanded="${open}">View details</button>
      <div class="step-body" id="step-${k}"${open ? '' : ' hidden'}></div></div>`;
  }).join('') + `<div class="card" id="stage-trace"><h3>Inter-agent trace &amp; audit</h3><div id="step-trace"></div><div id="step-audit"></div></div>`;
  const renderedSteps = new Set();
  const openStep = (k) => {
    const body = document.getElementById('step-' + k);
    if (!body || renderedSteps.has(k)) return;
    STAGE_RENDER[k](body, snap, stages);
    renderedSteps.add(k);
  };
  for (const k of expandedStages) {
    const body = document.getElementById('step-' + k);
    const btn = document.querySelector(`[data-toggle="${k}"]`);
    if (body && btn) { openStep(k); body.hidden = false; btn.textContent = 'Hide details'; btn.setAttribute('aria-expanded', 'true'); }
  }
  document.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.toggle;
    const body = document.getElementById('step-' + k);
    if (!body) return;
    const willOpen = body.hidden;
    if (willOpen) openStep(k);
    body.hidden = !willOpen;
    b.textContent = willOpen ? 'Hide details' : 'View details';
    b.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) expandedStages.add(k); else expandedStages.delete(k);
  }));
  document.querySelectorAll('[data-go]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const t = document.getElementById(a.dataset.go);
    if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  api('/api/reasoning-mode').then((rm) => {
    const r = document.getElementById('rmode');
    if (r) r.innerHTML = rm.mode === 'LLM_REASONING'
      ? `<b>LLM-assisted</b> (${esc(rm.model || rm.provider)}) — advisories validated; gates and scores stay deterministic`
      : '<b>Deterministic fallback</b> — no LLM credentials configured; rule-based reasoning with recorded reasons';
  }).catch(() => {});
  tabTrace(document.getElementById('step-trace'), snap);
  tabAudit(document.getElementById('step-audit'), snap);
  const go = document.getElementById('rp-go');
  go.addEventListener('click', async (e) => {
    e.target.disabled = true;
    const out = document.getElementById('rp-out');
    out.innerHTML = '<p class="ev">Running: vendor enrichment → quality → comparison → decision (progressive; steps below refresh as rows land)…</p>';
    try {
      const r = await api('/api/cases/' + encodeURIComponent(id) + '/pipeline/run', { method: 'POST', body: '{}', signal: AbortSignal.timeout(180000) });
      const rep = Object.entries(r.stages || {}).map(([k, v]) => `${k}: ${v.status}`).join(' · ');
      out.innerHTML = `<div class="okmsg">Pipeline done — case ${esc(r.case_status)}. ${esc(rep)}</div>`;
    } catch (err) { out.innerHTML = `<div class="err">${esc(err.message)}</div>`; }
    e.target.disabled = false;
    currentRefresh();
  });
  const gd = document.getElementById('rp-demo');
  if (gd) gd.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api('/api/cases/' + encodeURIComponent(id) + '/demo/mode', { method: 'POST', body: JSON.stringify({ reason: document.getElementById('rp-reason').value }) });
      currentRefresh();
    } catch (err) { document.getElementById('pmsg').innerHTML = `<div class="err">${esc(err.message)}</div>`; e.target.disabled = false; }
  });
  stopPoll(); pollCount = 0;
  if (!TERMINAL.has(p.status)) {
    pollTimer = setInterval(async () => {
      if (userTyping() || ++pollCount > 72) {
        if (pollCount > 72) stopPoll();
        else { const n = document.getElementById('pollnote'); if (n && !n.textContent) n.innerHTML = '<p class="ev">Paused auto-refresh while you type — <a href="#" id="rf">refresh now</a>.</p>'; const rf = document.getElementById('rf'); if (rf) rf.onclick = (e) => { e.preventDefault(); currentRefresh(); }; }
        return;
      }
      try {
        const s2 = await api('/api/cases/' + encodeURIComponent(id));
        const fp = (x) => [x.procurement.status, x.procurement.mode, (x.products || []).length, (x.offers || []).length, (x.quality_evaluations || []).length, (x.comparisons || []).length, !!x.decision, (x.negotiations || []).length, (x.demo_responses || []).length, (x.reevaluations || []).length, (x.approvals || []).length, (x.agent_messages || []).length].join('|');
        if (fp(s2) !== fp(snap)) viewPipeline(id);
      } catch { /* banner on next manual refresh */ }
    }, 4000);
  }
  try {
    if (sessionStorage.getItem('bw-autorun-' + id)) {
      sessionStorage.removeItem('bw-autorun-' + id);
      if (ME.canRunPipeline && (snap.products || []).length > 0 && !(snap.quality_evaluations || []).length && !snap.decision) {
        setTimeout(() => { const b = document.getElementById('rp-go'); if (b && b.offsetParent !== null) b.click(); }, 800);
      }
    }
    // Auto-claim ownership for unowned cases (first viewer with a claiming role).
    if (!snap.procurement.owner_user_id && ['admin', 'requester', 'officer'].includes(ME.role) && !sessionStorage.getItem('bw-claimed-' + id)) {
      api('/api/cases/' + encodeURIComponent(id) + '/claim', { method: 'POST', body: '{}' })
        .then(() => { try { sessionStorage.setItem('bw-claimed-' + id, '1'); } catch { /* ignore */ } currentRefresh(); })
        .catch(() => { /* already owned or forbidden — column stays as-is */ });
    }
  } catch { /* storage unavailable: manual run */ }
}

/* ================= boot / router ================= */
function route() {
  stopPoll();
  try {
  const h = location.hash || '#/';
  if (h === '#/login') return viewLogin().catch((e) => fail(e));
  if (h === '#/logout') return viewLogout().catch((e) => fail(e));
  return ensureAuth().then((ok) => {
    if (!ok) { location.hash = '#/login'; return null; }
    if (h === '#/admin') return viewAdmin().catch((e) => fail(e));
    if (h === '#/requests') return viewRequests().catch((e) => fail(e));
    if (h === '#/approvals') return viewApprovals().catch((e) => fail(e));
    const m = h.match(/^#\/case\/([0-9a-f-]{36})(?:\/([a-z_]+))?$/i);
    if (h === '#/new') {
      if (!ME.canCreate) { app.innerHTML = '<div class="err">Your role cannot create procurement requests.</div>'; return null; }
      return Promise.resolve().then(viewNew).catch((e) => fail(e));
    }
    if (m) return (m[2] ? viewCase(m[1], m[2]) : viewPipeline(m[1])).catch((e) => fail(e, m[1]));
    return viewDashboard().catch((e) => fail(e));
  }).catch((e) => fail(e));
  } catch (e) { fail(e); }
  function fail(e) { app.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', route);
refreshHealth().finally(route);
