// BuyWise Web — local frontend server over REAL Postgres + n8n. No mocks.
// Secrets stay server-side: only PG connection + webhook URL are configured;
// provider API keys are never read and never sent to the browser.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import express from 'express';
import pg from 'pg';
import { validateIntake, isUuid } from './lib/validate.js';
import { deriveStages, deriveChecklist } from './lib/stages.js';
import { selectMode, validateDemoResponse, realModeBlockers } from '../tools/_lib/demo.js';
import { reevaluate, mayReevaluate } from '../tools/_lib/reevaluation.js';
import { validatePackage, validateDecisionInput, closureTransition } from '../tools/_lib/approval.js';
import { draftMessage, computeTarget } from '../tools/_lib/negotiation.js';import { DEFAULT_WEIGHTS, score, rankRows, SCORING_RULES_VERSION } from '../tools/_lib/scoring.js';
import { decide } from '../tools/_lib/decision.js';
import { classifySource } from '../tools/_lib/source_quality.js';
import { specCompleteness } from '../tools/_lib/evidence.js';
import { validateOfferEvidence, validateVendorEvidence, evidenceConfidence, groupOffers } from '../tools/_lib/commercial.js';
import { budgetVerdict, unitBudget, totalFor } from '../tools/_lib/budget.js';
import { serpapiShoppingSearch } from '../tools/product-search/serpapi-shopping.js';
import { AGENTS, MAX_REPLANS_PER_CASE, validateMessage } from '../tools/_lib/coordination.js';
import { getLLMConfig, chatJSON, validateAdvisory, buildDecisionPrompt, buildComparisonPrompt, LLM_TIMEOUT_MS } from '../tools/_lib/llm.js';
import { hashPassword, verifyPassword, validateUsername, validatePassword, validateRole } from '../tools/_lib/passwords.mjs';
import { TRANSITIONS, TERMINAL, canTransition, canClose, canHandoff, isApprovalStale } from '../tools/_lib/lifecycle.js';
import { normalizeMandatory, assessEligibility, groupCandidates } from '../tools/_lib/eligibility.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_ENV = path.join(__dirname, '..', '.env');
const PORT = Number(process.env.PORT || 8080);
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'http://localhost:5678/webhook/procurement-request';

function loadEnvFile() {
  const cfg = {};
  try {
    for (const line of fs.readFileSync(ROOT_ENV, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && m[2]) cfg[m[1]] = m[2];
    }
  } catch { /* .env optional when env vars are set directly */ }
  return cfg;
}
const fileEnv = loadEnvFile();
const PG = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.POSTGRES_PORT || fileEnv.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB || fileEnv.POSTGRES_DB || 'buywise',
  user: process.env.POSTGRES_USER || fileEnv.POSTGRES_USER || 'buywise',
  password: process.env.POSTGRES_PASSWORD || fileEnv.POSTGRES_PASSWORD || '',
};
const pool = new pg.Pool({ ...PG, max: 5 });
pool.on('error', (e) => console.error('pg pool error:', e.message));

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Never leak secrets: strip any accidental secret-shaped values from JSON output.
function safeJson(res, obj, status = 200) {
  const s = JSON.stringify(obj);
  if (/(tvly-[A-Za-z0-9_-]{8,}|re_[A-Za-z0-9]{16,}|sk-(live|ant)-[A-Za-z0-9]+|Bearer [A-Za-z0-9._~-]{8,}|Basic [A-Za-z0-9+/=]{12,}|POSTGRES_PASSWORD|N8N_ENCRYPTION_KEY)/.test(s)) {
    return res.status(500).json({ error: 'refusing to emit secret-shaped value' });
  }
  res.status(status).type('application/json').send(s);
}
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

// ---- authentication & authorization (server-enforced RBAC) ----
const SESSION_TTL_MS = 12 * 3600 * 1000;
const LOGIN_WINDOW_MS = Number(process.env.LOGIN_RATE_WINDOW_MS || 5 * 60 * 1000);
const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_RATE_MAX || 5);
const loginAttempts = new Map(); // ip+username -> {count, resetAt}; local rate limiter

function getClientIp(req) { return String(req.ip || req.socket?.remoteAddress || 'unknown'); }
function attemptKey(ip, username) { return ip + '|' + String(username || '').toLowerCase(); }
function checkRateLimit(ip, username) {
  const key = attemptKey(ip, username);
  const rec = loginAttempts.get(key);
  if (rec && rec.resetAt < Date.now()) loginAttempts.delete(key);
  const cur = loginAttempts.get(key);
  return !(cur && cur.count >= LOGIN_MAX_ATTEMPTS);
}
function recordFailedLogin(ip, username) {
  const key = attemptKey(ip, username);
  const rec = loginAttempts.get(key) || { count: 0, resetAt: Date.now() + LOGIN_WINDOW_MS };
  rec.count += 1;
  loginAttempts.set(key, rec);
}
function parseCookies(req) {
  const out = {};
  const h = req.headers?.cookie;
  if (!h) return out;
  for (const part of String(h).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sha256hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

async function getSession(req) {
  try {
    const token = parseCookies(req).buywise_sid;
    if (!token) return null;
    const { rows } = await pool.query(
      `SELECT s.session_id, s.csrf_token, s.expires_at, u.user_id, u.username, u.role, u.approval_limit, u.active
       FROM sessions s JOIN users u ON u.user_id = s.user_id
       WHERE s.token_hash = $1`, [sha256hex(token)]);
    const sess = rows[0];
    if (!sess || !sess.active) return null;
    if (new Date(sess.expires_at).getTime() <= Date.now()) {
      await pool.query('DELETE FROM sessions WHERE session_id=$1', [sess.session_id]);
      return null;
    }
    return sess;
  } catch { return null; }
}
function publicUser(u) {
  if (!u) return null;
  return { id: u.user_id, username: u.username, role: u.role,
    approval_limit: u.approval_limit == null ? null : Number(u.approval_limit),
    canCreate: ['admin', 'requester', 'officer'].includes(u.role),
    canRunPipeline: ['admin', 'officer'].includes(u.role),
    canDemo: ['admin', 'officer'].includes(u.role),
    canApprove: ['admin', 'approver'].includes(u.role),
    canAdmin: u.role === 'admin', readOnly: u.role === 'auditor' };
}
const requireAuth = (fn) => asyncRoute(async (req, res) => {
  const sess = await getSession(req);
  if (!sess) return safeJson(res, { error: 'authentication required' }, 401);
  req.session = sess;
  req.user = publicUser(sess);
  return fn(req, res);
});
const requireRole = (...roles) => (fn) => requireAuth(async (req, res) => {
  if (!roles.includes(req.user.role)) return safeJson(res, { error: 'forbidden for role ' + req.user.role }, 403);
  return fn(req, res);
});
const requireCsrf = (fn) => async (req, res) => {
  const sess = req.session;
  const got = req.headers['x-csrf-token'];
  if (!sess || !got || got !== sess.csrf_token) return safeJson(res, { error: 'invalid CSRF token' }, 403);
  return fn(req, res);
};

// ---- auth endpoints (login is the only state-changing public route) ----
app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const ip = getClientIp(req);
  const { username, password } = req.body || {};
  if (!checkRateLimit(ip, username)) return safeJson(res, { error: 'too many attempts; try again later' }, 429);
  const { rows } = await pool.query('SELECT user_id, username, password_hash, role, approval_limit, active FROM users WHERE username=$1', [String(username || '')]);
  const u = rows[0];
  const okPass = u ? await verifyPassword(String(password || ''), u.password_hash) : false;
  if (!u || !u.active || !okPass) { recordFailedLogin(ip, username); return safeJson(res, { error: 'invalid credentials' }, 401); }
  loginAttempts.delete(attemptKey(ip, username));
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(16).toString('hex');
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query('INSERT INTO sessions (user_id, token_hash, csrf_token, expires_at) VALUES ($1,$2,$3,$4)',
    [u.user_id, sha256hex(token), csrf, expires.toISOString()]);
  res.setHeader('Set-Cookie', `buywise_sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  safeJson(res, { user: publicUser(u), csrf });
}));

app.post('/api/auth/logout', asyncRoute(async (req, res) => {
  const sess = await getSession(req);
  if (sess) await pool.query('DELETE FROM sessions WHERE session_id=$1', [sess.session_id]);
  res.setHeader('Set-Cookie', 'buywise_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  safeJson(res, { ok: true });
}));

app.get('/api/me', requireAuth(async (req, res) => {
  safeJson(res, { user: req.user, csrf: req.session.csrf_token });
}));

app.get('/api/admin/users', requireRole('admin')(async (req, res) => {
  const { rows } = await pool.query('SELECT user_id, username, role, approval_limit, active, created_at FROM users ORDER BY created_at');
  safeJson(res, { users: rows.map((u) => ({ ...u, approval_limit: u.approval_limit == null ? null : Number(u.approval_limit) })) });
}));

app.post('/api/admin/users', requireRole('admin')(requireCsrf(async (req, res) => {
  const { username, password, role, approval_limit } = req.body || {};
  const vu = validateUsername(username); if (!vu.ok) return safeJson(res, { error: vu.reason }, 400);
  const vp = validatePassword(password); if (!vp.ok) return safeJson(res, { error: vp.reason }, 400);
  const vr = validateRole(role); if (!vr.ok) return safeJson(res, { error: vr.reason }, 400);
  let limit = null;
  if (approval_limit !== undefined && approval_limit !== null && approval_limit !== '') {
    limit = Number(approval_limit);
    if (!isFinite(limit) || limit < 0) return safeJson(res, { error: 'approval_limit must be a non-negative number' }, 400);
  }
  try {
    const hash = await hashPassword(password);
    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash, role, approval_limit) VALUES ($1,$2,$3,$4) RETURNING user_id, username, role, approval_limit, active, created_at',
      [username, hash, role, limit]);
    await pool.query('INSERT INTO admin_events (actor_user_id, action, target_username, detail) VALUES ($1,$2,$3,$4)',
      [req.session.user_id, 'user_created', username, JSON.stringify({ role })]);
    safeJson(res, { user: rows[0] }, 201);
  } catch (e) {
    if (e.code === '23505') return safeJson(res, { error: 'username taken' }, 409);
    throw e;
  }
})));

app.patch('/api/admin/users/:id', requireRole('admin')(requireCsrf(async (req, res) => {
  if (!isUuid(req.params.id)) return safeJson(res, { error: 'invalid user id' }, 400);
  const { active, role, approval_limit } = req.body || {};
  const sets = [], vals = [];
  if (active !== undefined) {
    if (typeof active !== 'boolean') return safeJson(res, { error: 'active must be boolean' }, 400);
    sets.push(`active=$${sets.length + 1}`); vals.push(active);
  }
  if (role !== undefined) {
    const vr = validateRole(role); if (!vr.ok) return safeJson(res, { error: vr.reason }, 400);
    sets.push(`role=$${sets.length + 1}`); vals.push(role);
  }
  if (approval_limit !== undefined) {
    if (approval_limit === null || approval_limit === '') { sets.push(`approval_limit=$${sets.length + 1}`); vals.push(null); }
    else {
      const limit = Number(approval_limit);
      if (!isFinite(limit) || limit < 0) return safeJson(res, { error: 'approval_limit must be a non-negative number' }, 400);
      sets.push(`approval_limit=$${sets.length + 1}`); vals.push(limit);
    }
  }
  if (!sets.length) return safeJson(res, { error: 'nothing to update' }, 400);
  vals.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(', ')} WHERE user_id=$${vals.length} RETURNING user_id, username, role, approval_limit, active`, vals);
  if (!rows.length) return safeJson(res, { error: 'user not found' }, 404);
  if (active === false) await pool.query('DELETE FROM sessions WHERE user_id=$1', [req.params.id]);
  await pool.query('INSERT INTO admin_events (actor_user_id, action, target_username, detail) VALUES ($1,$2,$3,$4)',
    [req.session.user_id, 'user_updated', rows[0].username, JSON.stringify({ active, role })]);
  safeJson(res, { user: rows[0] });
})));

app.get('/api/admin/events', requireRole('admin')(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT e.event_id, e.action, e.target_username, e.detail, e.created_at, u.username AS actor
     FROM admin_events e LEFT JOIN users u ON u.user_id = e.actor_user_id ORDER BY e.created_at DESC LIMIT 100`);
  safeJson(res, { events: rows });
}));

// Central guard: every /api route below this line requires a session;
// mutations additionally require the session CSRF token; role rules are
// enforced here (server-side — frontend hiding is not authorization).
// req.path is relative to the /api mount (no /api prefix below).
const ROLE_RULES = [
  ['GET', '/admin/', ['admin']],
  ['POST', '/admin/', ['admin']],
  ['PATCH', '/admin/', ['admin']],
  ['POST', '/cases/:id/pipeline/run', ['admin', 'officer']],
  ['POST', '/procurements', ['admin', 'requester', 'officer']],
  ['PATCH', '/cases/:id', ['admin', 'requester', 'officer']],
  ['POST', '/cases/:id/claim', ['admin', 'requester', 'officer']],
  ['POST', '/cases/:id/demo/mode', ['admin', 'officer']],
  ['POST', '/cases/:id/demo/negotiations', ['admin', 'officer']],
  ['POST', '/cases/:id/demo/responses', ['admin', 'officer']],
  ['POST', '/cases/:id/demo/reevaluate', ['admin', 'officer']],
  ['POST', '/cases/:id/negotiations', ['admin', 'officer']],
  ['POST', '/cases/:id/handoff', ['admin', 'officer']],
  ['POST', '/cases/:id/approvals', ['admin', 'officer']],
  ['POST', '/approvals/:id/decision', ['admin', 'approver']],
];
function matchRoles(method, path) {
  for (const [m, pattern, roles] of ROLE_RULES) {
    if (m !== method) continue;
    const pp = pattern.split('/'), ap = path.split('/');
    if (pp.length !== ap.length) continue;
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) continue;
      if (pp[i] !== ap[i]) { ok = false; break; }
    }
    if (ok) return roles;
  }
  return null;
}
app.use('/api', (req, res, next) => {
  Promise.resolve(guardApi(req, res, next)).catch(next);
});
async function guardApi(req, res, next) {  const isPublic = (req.method === 'POST' && req.path === '/auth/login')
    || (req.method === 'GET' && (req.path === '/health' || req.path === '/reasoning-mode'));
  if (isPublic) return next();
  const sess = await getSession(req);
  if (!sess) return safeJson(res, { error: 'authentication required' }, 401);
  req.session = sess;
  req.user = publicUser(sess);
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
    const got = req.headers['x-csrf-token'];
    if (!got || got !== sess.csrf_token) return safeJson(res, { error: 'invalid CSRF token' }, 403);
  }
  const roles = matchRoles(req.method, req.path);
  if (roles && !roles.includes(req.user.role)) return safeJson(res, { error: 'forbidden for role ' + req.user.role }, 403);
  next();
}

app.get('/api/health', asyncRoute(async (req, res) => {
  await pool.query('SELECT 1');
  safeJson(res, { ok: true, db: true, n8n_webhook: N8N_WEBHOOK_URL });
}));

// ---- cases ----
app.get('/api/cases', asyncRoute(async (req, res) => {
  const scope = visibleScope(req.user);
  const ownerFilter = scope.all ? '' : 'WHERE c.owner_user_id = $1';
  const params = scope.all ? [] : [req.session.user_id];
  const { rows } = await pool.query(
    `SELECT c.procurement_id, c.status, c.mode, c.requirement, c.quantity, c.budget, c.currency,
            c.created_at, c.updated_at, c.version, c.owner_user_id, u.username AS owner_username,
            d.decision, a.status AS approval_status,
            (SELECT count(*)::int FROM products p WHERE p.procurement_id = c.procurement_id) AS products,
            (SELECT count(*)::int FROM offers o WHERE o.procurement_id = c.procurement_id) AS offers,
            (SELECT count(*)::int FROM vendors v WHERE v.procurement_id = c.procurement_id) AS vendors
     FROM procurement_cases c
     LEFT JOIN users u ON u.user_id = c.owner_user_id
     LEFT JOIN decisions d ON d.procurement_id = c.procurement_id
     LEFT JOIN LATERAL (SELECT status FROM approvals WHERE procurement_id = c.procurement_id ORDER BY created_at DESC LIMIT 1) a ON true
     ${ownerFilter}
     ORDER BY c.created_at DESC LIMIT 100`, params);
  safeJson(res, { cases: rows });
}));

const SNAPSHOT_SQL = `SELECT json_build_object(
  'procurement', (SELECT row_to_json(c) FROM procurement_cases c WHERE c.procurement_id=$1),
  'owner_username', (SELECT u.username FROM procurement_cases c LEFT JOIN users u ON u.user_id = c.owner_user_id WHERE c.procurement_id=$1),
  'products', (SELECT coalesce(json_agg(p ORDER BY p.name),'[]') FROM products p WHERE p.procurement_id=$1),
  'vendors', (SELECT coalesce(json_agg(v),'[]') FROM vendors v WHERE v.procurement_id=$1),
  'offers', (SELECT coalesce(json_agg(o),'[]') FROM offers o WHERE o.procurement_id=$1),
  'comparisons', (SELECT coalesce(json_agg(m ORDER BY m.rank),'[]') FROM comparisons m WHERE m.procurement_id=$1),
  'decision', (SELECT row_to_json(d) FROM decisions d WHERE d.procurement_id=$1),
  'negotiations', (SELECT coalesce(json_agg(n),'[]') FROM negotiations n WHERE n.procurement_id=$1),
  'demo_responses', (SELECT coalesce(json_agg(r),'[]') FROM demo_responses r WHERE r.procurement_id=$1),
  'reevaluations', (SELECT coalesce(json_agg(r),'[]') FROM reevaluations r WHERE r.procurement_id=$1),
  'approvals', (SELECT coalesce(json_agg(a ORDER BY a.created_at DESC),'[]') FROM approvals a WHERE a.procurement_id=$1),
  'approval_events', (SELECT coalesce(json_agg(e ORDER BY e.created_at),'[]') FROM approval_events e WHERE e.procurement_id=$1),
  'negotiation_events', (SELECT coalesce(json_agg(e ORDER BY e.created_at),'[]') FROM negotiation_events e WHERE e.procurement_id=$1),
  'agent_messages', (SELECT coalesce(json_agg(m ORDER BY m.created_at),'[]') FROM agent_messages m WHERE m.procurement_id=$1),
  'audit', (SELECT coalesce(json_agg(a ORDER BY a.created_at DESC),'[]') FROM (SELECT * FROM audit_log WHERE procurement_id=$1 ORDER BY created_at DESC LIMIT 100) a),
  'quality_evaluations', (SELECT coalesce(json_agg(q),'[]') FROM quality_evaluations q WHERE q.procurement_id=$1),
  'eligibility', (SELECT coalesce(json_agg(g ORDER BY g.product_id, g.requirement),'[]') FROM eligibility g WHERE g.procurement_id=$1),
  'scoring_configs', (SELECT coalesce(json_agg(s),'[]') FROM scoring_configs s WHERE s.procurement_id=$1),
  'agent_executions', (SELECT coalesce(json_agg(e ORDER BY e.started_at),'[]') FROM agent_executions e WHERE e.procurement_id=$1)
) AS snapshot`;

// Object-level read isolation: admins/officers/approvers/auditors see all
// cases (approvers need the inbox; auditors need history); requesters see
// only cases they own. Unowned legacy rows are officer/admin/auditor/approver
// visible only — requesters must claim (or be assigned) first. Unknown IDs and
// invisible cases both answer 404 so IDs can't be probed.
function visibleScope(user) {
  if (!user) return { all: false };
  if (['admin', 'officer', 'approver', 'auditor'].includes(user.role)) return { all: true };
  return { all: false, ownerId: user.id };
}
async function assertCaseVisible(req, procurementId) {
  const scope = visibleScope(req.user);
  if (scope.all) return true;
  if (!scope.ownerId) return false;
  const { rows } = await pool.query('SELECT owner_user_id FROM procurement_cases WHERE procurement_id=$1', [procurementId]);
  if (!rows.length) return 'missing';
  return rows[0].owner_user_id === req.session.user_id;
}

app.get('/api/cases/:id', asyncRoute(async (req, res) => {
  if (!isUuid(req.params.id)) return safeJson(res, { error: 'invalid procurement id' }, 400);
  const vis = await assertCaseVisible(req, req.params.id);
  if (vis !== true) return safeJson(res, { error: 'not found' }, 404);
  const { rows } = await pool.query(SNAPSHOT_SQL, [req.params.id]);
  if (!rows[0]?.snapshot?.procurement) return safeJson(res, { error: 'not found' }, 404);
  safeJson(res, rows[0].snapshot);
}));

// ---- dashboard: every metric computed from live tables ----
app.get('/api/dashboard', asyncRoute(async (req, res) => {
  const scope = visibleScope(req.user);
  const own = scope.all ? '' : 'WHERE c.owner_user_id = $1';
  const ownParams = scope.all ? [] : [req.session.user_id];
  const [tot, act, closed, awaiting, recent, execs, decisions] = await Promise.all([
    pool.query(`SELECT count(*)::int AS n FROM procurement_cases c ${own}`, ownParams),
    pool.query(`SELECT count(*)::int AS n FROM procurement_cases c WHERE status NOT IN ('closed','purchase_handoff')${scope.all ? '' : ' AND c.owner_user_id = $1'}`, ownParams),
    pool.query(`SELECT count(*)::int AS n FROM procurement_cases c WHERE status IN ('closed','purchase_handoff')${scope.all ? '' : ' AND c.owner_user_id = $1'}`, ownParams),
    pool.query(`SELECT count(DISTINCT a.procurement_id)::int AS n FROM approvals a WHERE a.status = 'PENDING_APPROVAL'${scope.all ? '' : ' AND a.procurement_id IN (SELECT procurement_id FROM procurement_cases WHERE owner_user_id = $1)'}`,
      scope.all ? [] : [req.session.user_id]),
    pool.query(`SELECT c.procurement_id, c.status, c.mode, c.requirement, c.budget, c.currency, c.created_at, d.decision
                FROM procurement_cases c LEFT JOIN decisions d ON d.procurement_id = c.procurement_id
                ${own} ORDER BY c.created_at DESC LIMIT 8`, ownParams),
    pool.query(`SELECT procurement_id, agent_name, status, started_at, completed_at, latency_ms, error_message
                FROM agent_executions ${scope.all ? '' : 'WHERE procurement_id IN (SELECT procurement_id FROM procurement_cases WHERE owner_user_id = $1)'} ORDER BY started_at DESC NULLS LAST LIMIT 10`, ownParams),
    pool.query(`SELECT d.procurement_id, d.decision, d.decision_reason, d.created_at
                FROM decisions d ${scope.all ? '' : 'JOIN procurement_cases c ON c.procurement_id = d.procurement_id WHERE c.owner_user_id = $1'} ORDER BY d.created_at DESC LIMIT 5`, ownParams),
  ]);
  safeJson(res, {
    totals: { cases: tot.rows[0].n, active: act.rows[0].n, completed: closed.rows[0].n, awaiting_approval: awaiting.rows[0].n },
    recent_runs: recent.rows, recent_executions: execs.rows, recent_decisions: decisions.rows,
  });
}));

// ---- approval inbox (team queue; caller filters SoD-eligible rows client-side) ----
app.get('/api/approvals/pending', asyncRoute(async (req, res) => {
  const scope = visibleScope(req.user);
  const { rows } = await pool.query(
    `SELECT a.approval_id, a.procurement_id, a.mode, a.created_at, a.request_version,
            c.requirement, c.budget, c.currency, c.status AS case_status, c.owner_user_id,
            u.username AS owner_username, d.decision
     FROM approvals a JOIN procurement_cases c ON c.procurement_id = a.procurement_id
     LEFT JOIN users u ON u.user_id = c.owner_user_id
     LEFT JOIN decisions d ON d.procurement_id = c.procurement_id
     WHERE a.status = 'PENDING_APPROVAL'${scope.all ? '' : ' AND c.owner_user_id = $1'} ORDER BY a.created_at DESC LIMIT 50`,
    scope.all ? [] : [req.session.user_id]);
  safeJson(res, { pending: rows });
}));

// ---- providers: presence-only flags (never values) + live checks ----
function envHas(name) {
  if (process.env[name]) return true;
  try {
    for (const line of fs.readFileSync(ROOT_ENV, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && m[1] === name && m[2]) return true;
    }
  } catch { /* ignore */ }
  return false;
}

app.get('/api/providers', asyncRoute(async (req, res) => {
  const t0 = Date.now();
  let n8n = { reachable: false, latency_ms: null };
  try {
    const base = N8N_WEBHOOK_URL.replace(/\/webhook\/.*$/, '');
    const r = await fetch(base + '/healthz', { signal: AbortSignal.timeout(8000) });
    n8n = { reachable: r.ok, latency_ms: Date.now() - t0 };
  } catch { /* unreachable */ }
  safeJson(res, {
    tavily: { configured: envHas('TAVILY_API_KEY'), role: 'web research and evidence' },
    serpapi: { configured: envHas('SERPAPI_API_KEY'), role: 'structured commercial data' },
    n8n: { ...n8n, role: 'agent orchestration' },
    ollama: { required: false, note: 'not required; deterministic paths run without an LLM' },
    gmail: { connected: false, note: 'not connected; negotiation stays blocked in REAL mode by design' },
  });
}));

// ---- reasoning mode (LLM configured vs deterministic fallback) ----
app.get('/api/reasoning-mode', asyncRoute(async (req, res) => {
  const cfg = getLLMConfig(serverLLMEnv());
  safeJson(res, {
    mode: cfg.configured ? 'LLM_REASONING' : 'LLM_UNAVAILABLE',
    provider: cfg.provider, model: cfg.model || null, configured: cfg.configured,
    note: cfg.configured
      ? 'Agents may attach validated advisories; gates, scores, and policy stay deterministic.'
      : 'No LLM credentials configured; agents run the explicit deterministic fallback.',
  });
}));

// ---- nine-stage workflow state for a case (derived, never invented) ----
app.get('/api/cases/:id/stages', asyncRoute(async (req, res) => {
  if (!isUuid(req.params.id)) return safeJson(res, { error: 'invalid procurement id' }, 400);
  const vis = await assertCaseVisible(req, req.params.id);
  if (vis !== true) return safeJson(res, { error: 'not found' }, 404);
  const { rows } = await pool.query(SNAPSHOT_SQL, [req.params.id]);
  const snap = rows[0]?.snapshot;
  if (!snap?.procurement) return safeJson(res, { error: 'not found' }, 404);
  const stages = deriveStages(snap);
  safeJson(res, { procurement_id: req.params.id, mode: snap.procurement.mode || 'REAL', stages, checklist: deriveChecklist(snap, stages) });
}));

// ---- guided pipeline runner: vendor enrichment + deterministic stages ----
const PIPELINE_SPEC_FIELDS = ['processor', 'ram', 'storage', 'operating_system', 'display', 'battery', 'graphics'];
function serverProviderEnv() {
  const pick = (k) => process.env[k] || fileEnv[k] || '';
  return {
    SERPAPI_API_KEY: pick('SERPAPI_API_KEY'),
    SERPAPI_GL: pick('SERPAPI_GL') || 'in', SERPAPI_HL: pick('SERPAPI_HL') || 'en',
    SERPAPI_LOCATION: pick('SERPAPI_LOCATION'),
  };
}
const STATUS_ORDER = ['created', 'product_done', 'vendor_done', 'quality_done', 'compared', 'decided'];
// Central lifecycle enforcement: every website status write goes through
// transitionStatus/advanceIfLegal below. (The old silent no-op updater was
// removed so no second, unenforced write path exists.)
async function transitionStatus(id, to, { actor = 'system', reason = '' } = {}) {
  const cur = await pool.query('SELECT status FROM procurement_cases WHERE procurement_id=$1', [id]);
  if (!cur.rows.length) {
    const e = new Error('case not found'); e.status = 404; throw e;
  }
  const from = cur.rows[0].status;
  const chk = canTransition(from, to);
  const trace = crypto.randomUUID();
  if (!chk.ok) {
    await pool.query('INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES ($1,$2,$3,$4,$5)',
      [id, trace, 'orchestrator', 'transition_rejected', JSON.stringify({ actor, from, to, reason: chk.reason })]);
    const e = new Error(`illegal transition '${from}' -> '${to}': ${chk.reason}`); e.status = 409; throw e;
  }
  if (chk.noop) return { from, to, noop: true };
  await pool.query('UPDATE procurement_cases SET status=$2, updated_at=now() WHERE procurement_id=$1', [id, to]);
  await pool.query('INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES ($1,$2,$3,$4,$5)',
    [id, trace, 'orchestrator', 'status_transition', JSON.stringify({ actor, from, to, reason })]);
  return { from, to, noop: false };
}
// Read-only legality probe: call BEFORE any side effects so a rejected
// transition never leaves half-written rows behind.
async function checkTransition(id, to) {
  const cur = await pool.query('SELECT status FROM procurement_cases WHERE procurement_id=$1', [id]);
  if (!cur.rows.length) {
    const e = new Error('case not found'); e.status = 404; throw e;
  }
  const chk = canTransition(cur.rows[0].status, to);
  if (!chk.ok && !chk.noop) {
    const trace = crypto.randomUUID();
    await pool.query('INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES ($1,$2,$3,$4,$5)',
      [id, trace, 'orchestrator', 'transition_rejected', JSON.stringify({ actor: 'gate', from: cur.rows[0].status, to, reason: chk.reason })]);
    const e = new Error(`illegal transition '${cur.rows[0].status}' -> '${to}': ${chk.reason}`); e.status = 409; throw e;
  }
  return chk;
}
// Pipeline-internal variant: stages that find their rows already present (or a
// case already past the target state, e.g. force re-enrichment on a decided
// case) record an audit note and continue instead of aborting the whole run.
// User-facing endpoints always use strict transitionStatus above.
async function advanceIfLegal(id, to, { actor = 'system:pipeline', reason = '' } = {}) {
  const cur = await pool.query('SELECT status FROM procurement_cases WHERE procurement_id=$1', [id]);
  if (!cur.rows.length) {
    const e = new Error('case not found'); e.status = 404; throw e;
  }
  const chk = canTransition(cur.rows[0].status, to);
  if (!chk.ok && !chk.noop) {
    const trace = crypto.randomUUID();
    await pool.query('INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES ($1,$2,$3,$4,$5)',
      [id, trace, 'orchestrator', 'status_transition_skipped', JSON.stringify({ actor, from: cur.rows[0].status, to, reason: chk.reason })]);
    return { from: cur.rows[0].status, to, skipped: true };
  }
  return transitionStatus(id, to, { actor, reason });
}

function serverLLMEnv() {
  const pick = (k) => process.env[k] || fileEnv[k] || '';
  return { LLM_PROVIDER: pick('LLM_PROVIDER'), LLM_API_URL: pick('LLM_API_URL'), LLM_API_KEY: pick('LLM_API_KEY'), LLM_MODEL: pick('LLM_MODEL') };
}

// Validated inter-agent message writer (coordination trace). Throws on invalid.
async function sendMessage({ id, trace, parent = null, sender, recipient, type, objective, payload = {}, evidence_refs = [], requested_action = null, reason = '', tool_calls = [], status = 'sent', latency_ms = null, reasoning_mode = 'DETERMINISTIC_FALLBACK', llm_model = null }) {
  if (reasoning_mode !== 'LLM_REASONING' && reasoning_mode !== 'DETERMINISTIC_FALLBACK') {
    throw new Error('invalid reasoning_mode (must be LLM_REASONING or DETERMINISTIC_FALLBACK)');
  }
  if (reasoning_mode === 'DETERMINISTIC_FALLBACK' && llm_model) throw new Error('fallback messages must not name a model');
  const m = { sender_agent: sender, recipient_agent: recipient, message_type: type, objective, payload, evidence_refs, requested_action, reason, tool_calls, status };
  const v = validateMessage(m);
  if (!v.valid) throw new Error('invalid agent message: ' + v.reasons.join('; '));
  const { rows } = await pool.query(
    `INSERT INTO agent_messages (procurement_id,parent_message_id,trace_id,sender_agent,recipient_agent,message_type,objective,payload,evidence_refs,requested_action,reason,tool_calls,status,completed_at,latency_ms,reasoning_mode,llm_model)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,CASE WHEN $13 IN ('completed','rejected') THEN now() ELSE NULL END,$14,$15,$16)
     RETURNING message_id, created_at`,
    [id, parent, trace, sender, recipient, type, objective, JSON.stringify(payload), JSON.stringify(evidence_refs),
     requested_action, reason, JSON.stringify(tool_calls), status, latency_ms, reasoning_mode, llm_model]);
  return rows[0];
}

// Optional LLM advisory (bounded: 1 retry on transport failure only, 20 s cap).
// Advisory only — gates, scores, and policy stay deterministic. Never throws:
// failures resolve to an explicit DETERMINISTIC_FALLBACK record.
async function llmAdvisory(kind, prompt, llmEnv, llmConfig) {
  if (!llmConfig.configured) return { mode: 'DETERMINISTIC_FALLBACK', fallback_reason: 'LLM credentials not configured' };
  let lastErr = 'LLM call failed';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await chatJSON({ system: prompt.system, user: prompt.user, config: llmConfig, env: llmEnv, timeoutMs: LLM_TIMEOUT_MS });
      const v = validateAdvisory(raw, kind);
      if (!v.valid) return { mode: 'DETERMINISTIC_FALLBACK', fallback_reason: 'LLM advisory failed validation: ' + v.reasons.join('; ') };
      return { mode: 'LLM_REASONING', model: llmConfig.model, advisory: raw };
    } catch (e) {
      lastErr = String(e.message || e).slice(0, 160);
      const retryable = /timeout|http \d+|failed/i.test(lastErr) && !/malformed|empty|unavailable/i.test(lastErr);
      if (!retryable || attempt === 2) break;
    }
  }
  return { mode: 'DETERMINISTIC_FALLBACK', fallback_reason: lastErr };
}
async function completeMessage(message_id, status = 'completed', latency_ms = null) {
  await pool.query(`UPDATE agent_messages SET status=$2,completed_at=now(),latency_ms=$3 WHERE message_id=$1`,
    [message_id, status, latency_ms]);
}

// Relevance guard: a listing counts for the queried product only if its title
// shares significant tokens with the product name (legit variants share brand +
// line tokens; unrelated items do not). Rejected listings stay out, counted.
const REL_STOP = new Set(['with', 'from', 'that', 'this', 'your', 'plus', 'pack']);
function nameTokens(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !REL_STOP.has(t));
}

// Per-product SerpAPI enrichment worker pool (SerpAPI only, no Tavily).
// Attribution by construction; strict commercial rule gates every row.
async function enrichProducts({ id, short, queue, env }) {
  let nOffers = 0, nVendors = 0, nSkipped = 0, nCalls = 0, nFailures = 0, nIrrelevant = 0;
  const seen = new Set();
  const sampleUrls = [];
  let idx = 0;
  async function worker() {
    while (idx < queue.length) {
      const p = queue[idx++];
      let items = [];
      nCalls++;
      try {
        items = await serpapiShoppingSearch({ query: String(p.name).slice(0, 120), limit: 6, env });
      } catch { nFailures++; nSkipped++; continue; }
      for (const e of items) {
        try {
          if (!e || e.data_status === 'UNAVAILABLE' || e.source !== 'serpapi_shopping') { nSkipped++; continue; }
          const d = e.data || {};
          const pTokens = nameTokens(p.name);
          const lTokens = new Set(nameTokens(d.product_name));
          const common = pTokens.filter((t) => lTokens.has(t)).length;
          if (common < Math.min(2, Math.max(1, pTokens.length >= 2 ? 2 : 1))) { nSkipped++; nIrrelevant++; continue; }
          const price = typeof d.price === 'number' ? d.price
            : (typeof d.price === 'string' ? Number(String(d.price).replace(/[^0-9.]/g, '')) : NaN);
          const currency = (typeof d.currency === 'string' && /^[A-Z]{3}$/.test(d.currency)) ? d.currency : null;
          const merchant = (typeof d.merchant_name === 'string' && d.merchant_name !== 'unavailable') ? d.merchant_name : 'unavailable';
          const productUrl = (typeof d.product_url === 'string' && d.product_url !== 'unavailable') ? d.product_url : e.source_url;
          const check = validateOfferEvidence({
            product_name: (typeof d.product_name === 'string' && d.product_name !== 'unavailable') ? d.product_name : p.name,
            product_url: productUrl, merchant_name: merchant, merchant_url: null,
            price: (typeof price === 'number' && isFinite(price)) ? price : null,
            currency, source_url: e.source_url,
          });
          const vv = validateVendorEvidence({ vendor_name: merchant, source_url: e.source_url, merchant_url: null, provider: 'serpapi_shopping' });
          if (!check.accepted || !vv.accepted) { nSkipped++; continue; }
          const slug = merchant.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'vendor';
          const vendor_id = `v-${slug}-${short}`;
          const key = `${p.product_id}|${vendor_id}|${e.source_url}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const offer_id = `o-${short}-${slug}-${seen.size}`;
          const retrieved = e.retrieved_at || new Date().toISOString();
          const conf = evidenceConfidence({ price, currency, merchant, url: e.source_url });
          await pool.query(
            `INSERT INTO vendors (vendor_id,procurement_id,vendor_name,vendor_url,source,source_url,retrieved_at,data_status,confidence,raw_response)
             VALUES ($1,$2,$3,$4,'serpapi_shopping',$5,$6,$7,$8,$9) ON CONFLICT (vendor_id) DO NOTHING`,
            [vendor_id, id, merchant, e.source_url, e.source_url, retrieved, e.data_status === 'LIVE' ? 'LIVE' : 'PARTIAL', conf,
             JSON.stringify({ via: 'pipeline_enrichment', serpapi_product_id: d.serpapi_product_id ?? e._serpapi?.product_id ?? null })]);
          nVendors++;
          const r = await pool.query(
            `INSERT INTO offers (offer_id,procurement_id,product_id,vendor_id,unit_price,currency,discount_pct,net_price,delivery_days,warranty_months,payment_terms,availability,source,source_url,retrieved_at,data_status,confidence,raw_response)
             VALUES ($1,$2,$3,$4,$5,$6,NULL,$5,'unavailable','unavailable','unavailable','unavailable','serpapi_shopping',$7,$8,$9,$10,$11)
             ON CONFLICT (procurement_id,product_id,vendor_id,source_url) DO NOTHING`,
            [offer_id, id, p.product_id, vendor_id, price, currency, e.source_url, retrieved,
             e.data_status === 'LIVE' ? 'LIVE' : 'PARTIAL', conf,
             JSON.stringify({ via: 'pipeline_enrichment', serpapi_product_id: d.serpapi_product_id ?? e._serpapi?.product_id ?? null })]);
          nOffers += r.rowCount;
          if (sampleUrls.length < 5 && r.rowCount > 0) sampleUrls.push(e.source_url);
        } catch { nSkipped++; }
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  return { nOffers, nVendors, nSkipped, nCalls, nFailures, nIrrelevant, sampleUrls };
}

// Decision run with coordination messages (task in, decision + escalation out).
// Uses the deterministic gates; agents interpret results but cannot override
// mandatory constraints or fabricate scores.
async function runDecision(id, trace, snapFresh, recomputeNote = null) {
  const t0 = Date.now();
  await pool.query(
    `INSERT INTO agent_executions (procurement_id,trace_id,agent_name,status,input_hash) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (trace_id,agent_name) DO UPDATE SET status='started',input_hash=EXCLUDED.input_hash,started_at=now(),completed_at=NULL,output_hash=NULL,error_message=NULL`,
    [id, trace, 'decision', 'started', crypto.createHash('sha256').update(JSON.stringify({ ranked: (snapFresh.comparisons || []).length, recompute: !!recomputeNote })).digest('hex')]);
  const taskMsg = await sendMessage({ id, trace, sender: 'orchestrator', recipient: 'decision', type: 'task_assignment',
    objective: recomputeNote
      ? `Re-apply decision gates with newly arrived offer evidence (${recomputeNote}).`
      : `Apply mandatory/budget/contact gates to the ranking and choose PROCEED, NEGOTIATE, or INSUFFICIENT_DATA with the next action.`,
    payload: { ranked: (snapFresh.comparisons || []).length }, reason: '' });
  const P = snapFresh.procurement;
  const mandatory = normalizeMandatory(P.mandatory_specs);
  const prodRows = snapFresh.products || [];
  const offerRows = (snapFresh.offers || []).map((o) => ({ ...o, net_price: o.net_price === null ? null : Number(o.net_price) }));
  const vendorRows = snapFresh.vendors || [];
  const d = decide({
    procurement: { procurement_id: id, budget: P.budget != null ? Number(P.budget) : null, currency: P.currency, quantity: P.quantity },
    ranked: (snapFresh.comparisons || []).map((r) => ({ ...r, overall_score: r.overall_score === null ? null : Number(r.overall_score) })),
    offersByProduct: Object.fromEntries(prodRows.map((p) => [p.product_id, offerRows.filter((o) => o.product_id === p.product_id)])),
    vendorsById: Object.fromEntries(vendorRows.map((v) => [v.vendor_id, { ...v, contact_channel: null }])),
    productsById: Object.fromEntries(prodRows.map((p) => [p.product_id, { ...p, specifications: typeof p.specifications === 'string' ? JSON.parse(p.specifications) : p.specifications }])),
    mandatory,
  });
  const nextAction = d.decision === 'PROCEED' ? 'present package for explicit human approval'
    : d.decision === 'NEGOTIATE' ? 'draft negotiation proposal from the verified offer (never send)'
    : 'escalate gaps to human; follow-up research only where bounded and targeted';
  await pool.query(
    `INSERT INTO decisions (procurement_id,product_id,comparison_id,decision,decision_reason,blocking_reasons,criteria_used,criteria_missing,evidence_urls)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (procurement_id) DO UPDATE SET product_id=EXCLUDED.product_id,comparison_id=EXCLUDED.comparison_id,decision=EXCLUDED.decision,decision_reason=EXCLUDED.decision_reason,blocking_reasons=EXCLUDED.blocking_reasons,criteria_used=EXCLUDED.criteria_used,criteria_missing=EXCLUDED.criteria_missing,evidence_urls=EXCLUDED.evidence_urls`,
    [id, d.product_id ?? null, d.comparison_id ?? null, d.decision, d.decision_reason,
     JSON.stringify(d.blocking_reasons), JSON.stringify(d.criteria_used), JSON.stringify(d.criteria_missing), JSON.stringify(d.evidence_urls)]);
  await pool.query(
    `UPDATE agent_executions SET status='succeeded',output_hash=$3,completed_at=now(),latency_ms=$4
     WHERE procurement_id=$1 AND trace_id=$2 AND agent_name='decision'`,
    [id, trace, crypto.createHash('sha256').update(JSON.stringify({ decision: d.decision })).digest('hex'), Date.now() - t0]);
  await advanceIfLegal(id, 'decided', { reason: 'decision persisted' });
  await pool.query(
    'INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES ($1,$2,$3,$4,$5)',
    [id, trace, 'decision', 'decision_persisted', JSON.stringify({ decision: d.decision, blocking: d.blocking_reasons, recompute: !!recomputeNote })]);
  if (d.decision !== 'NEGOTIATE') {
    await pool.query(
      'INSERT INTO negotiation_events (negotiation_id,procurement_id,event_type,trace_id,metadata) VALUES (NULL,$1,$2,$3,$4)',
      [id, 'evaluated_not_ready', trace, JSON.stringify({ decision: d.decision, reasons: d.blocking_reasons })]);
  }
  await completeMessage(taskMsg.message_id, 'completed', Date.now() - t0);
  const llmEnv = serverLLMEnv();
  const llmConfig = getLLMConfig(llmEnv);
  const llmRes = await llmAdvisory('decision', buildDecisionPrompt({
    requirement: snapFresh.procurement.requirement,
    rankedTop: (snapFresh.comparisons || []).slice(0, 3).map((r) => ({ rank: r.rank, overall_score: r.overall_score })),
    blocking: d.blocking_reasons, offersCount: offerRows.length, mode: snapFresh.procurement.mode || 'REAL',
  }), llmEnv, llmConfig);
  const llmNote = llmRes.mode === 'LLM_REASONING'
    ? ` LLM advisory (${llmRes.model}) proposes ${llmRes.advisory.proposed_action}: ${String(llmRes.advisory.reasoning_summary).slice(0, 300)} Deterministic gates unchanged.`
    : ` Deterministic fallback (${llmRes.fallback_reason}).`;
  await sendMessage({ id, trace, parent: taskMsg.message_id, sender: 'decision', recipient: 'orchestrator', type: 'decision',
    objective: 'Report the gated outcome and the chosen next action.',
    payload: { decision: d.decision, blocking_reasons: d.blocking_reasons, next_action: nextAction,
      llm: llmRes.mode === 'LLM_REASONING' ? { model: llmRes.model, advisory: llmRes.advisory } : { fallback_reason: llmRes.fallback_reason } },
    evidence_refs: d.evidence_urls || [],
    reason: `${d.decision_reason} Next action: ${nextAction}.${llmNote}`,
    status: 'completed', latency_ms: Date.now() - t0,
    reasoning_mode: llmRes.mode, llm_model: llmRes.model || null });
  await sendMessage({ id, trace, sender: 'decision', recipient: 'human', type: 'escalation',
    objective: 'A human must review the evidence and record an explicit approval decision.',
    payload: { decision: d.decision, mode: snapFresh.procurement.mode || 'REAL' },
    requested_action: 'record APPROVED / REJECTED / CHANGES_REQUESTED with actor identity in the Approval step',
    reason: `Outstanding risks: ${(d.blocking_reasons || []).join('; ') || 'none recorded'}. Missing evidence: ${(d.criteria_missing || []).join(', ') || 'none'}. Absence or timeout is never approval.`,
    status: 'sent' });
  return d;
}

app.post('/api/cases/:id/pipeline/run', asyncRoute(async (req, res) => {
  if (!isUuid(req.params.id)) return safeJson(res, { error: 'invalid procurement id' }, 400);
  const maxProducts = Math.min(Math.max(Number(req.body?.max_products ?? 100) || 100, 1), 100);
  const onlyIds = Array.isArray(req.body?.product_ids) ? req.body.product_ids.filter((x) => typeof x === 'string').slice(0, 20) : null;
  const trace = crypto.randomUUID();
  const id = req.params.id;
  const fresh = async () => (await pool.query(SNAPSHOT_SQL, [id])).rows[0]?.snapshot;
  let snap = await fresh();
  if (!snap?.procurement) return safeJson(res, { error: 'not found' }, 404);
  // Terminal cases are immutable history: re-running research/scoring/decision
  // here would overwrite persisted rows (decisions upsert). Fail closed.
  if (['closed', 'purchase_handoff'].includes(snap.procurement.status)) {
    return safeJson(res, { error: `case is ${snap.procurement.status} (terminal state); pipeline cannot re-run on immutable history` }, 409);
  }
  const products = snap.products || [];
  if (!products.length) return safeJson(res, { error: 'research still running (no products yet); retry shortly' }, 409);
  const short = id.replace(/-/g, '').slice(0, 8);
  const out = {};

  // Stage 2b: per-product SerpAPI enrichment (SerpAPI only, no Tavily).
  // Attribution by construction (this search was FOR this product); the strict
  // commercial rule still gates every row — nothing invented.
  if ((snap.offers || []).length > 0 && !req.body?.force_enrich) {
    out.vendor_enrichment = { status: 'skipped', reason: 'offers already exist' };
  } else {
    const t0 = Date.now();
    try {
      const env = serverProviderEnv();
      if (!env.SERPAPI_API_KEY) throw new Error('SerpAPI not configured; enrichment unavailable');
      await pool.query(
        'INSERT INTO agent_executions (procurement_id,trace_id,agent_name,status,input_hash) VALUES ($1,$2,$3,$4,$5)',
        [id, trace, 'vendor_research', 'started', crypto.createHash('sha256').update(JSON.stringify({ products: products.length })).digest('hex')]);
      const queue = (onlyIds ? products.filter((p) => onlyIds.includes(p.product_id)) : products).slice(0, maxProducts);
      const taskMsg = await sendMessage({ id, trace, sender: 'orchestrator', recipient: 'vendor_research', type: 'task_assignment',
        objective: `Attach verified merchants and commercial offers to ${queue.length} known product(s). Only rows with real merchant + numeric price + known currency + source URL may become offers.`,
        payload: { products: queue.length, max_iterations: AGENTS.vendor_research.maxIterations },
        reason: '' });
      const enr = await enrichProducts({ id, short, queue, env });
      const { nOffers, nVendors, nSkipped, nCalls, nFailures, nIrrelevant, sampleUrls } = enr;
      await completeMessage(taskMsg.message_id, 'completed', Date.now() - t0);
      await sendMessage({ id, trace, parent: taskMsg.message_id, sender: 'vendor_research', recipient: 'orchestrator', type: 'evidence_report',
        objective: 'Report verified commercial evidence found for the assigned products.',
        payload: { offers: nOffers, vendors: nVendors, skipped: nSkipped, irrelevant_rejected: nIrrelevant, searches: nCalls, search_failures: nFailures },
        evidence_refs: sampleUrls,
        tool_calls: [{ tool: 'serpapiShoppingSearch', calls: nCalls, failures: nFailures, timeout_ms: 15000, retries_per_call: 0 }],
        reason: nOffers > 0
          ? `Per-product SerpAPI searches attributed by construction; strict commercial rule accepted ${nOffers} offer(s), rejected ${nSkipped} envelope(s) without inventing data.`
          : `No envelope passed the strict commercial rule on this pass (${nSkipped} rejected); missing offers stay missing, never fabricated.`,
        status: 'completed', latency_ms: Date.now() - t0 });
      await advanceIfLegal(id, 'vendor_done', { reason: 'offers enriched' });
      await pool.query(
        `UPDATE agent_executions SET status='succeeded',output_hash=$3,completed_at=now(),latency_ms=$4
         WHERE procurement_id=$1 AND trace_id=$2 AND agent_name='vendor_research'`,
        [id, trace, crypto.createHash('sha256').update(JSON.stringify({ offers: nOffers })).digest('hex'), Date.now() - t0]);
      await pool.query(
        'INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES ($1,$2,$3,$4,$5)',
        [id, trace, 'vendor_research', 'offers_enriched', JSON.stringify({ offers: nOffers, vendors: nVendors, skipped: nSkipped })]);
      out.vendor_enrichment = { status: 'completed', offers: nOffers, vendors: nVendors, skipped: nSkipped, latency_ms: Date.now() - t0 };
      snap = await fresh();
    } catch (e) {
      out.vendor_enrichment = { status: 'failed', error: String(e.message || e).slice(0, 200) };
    }
  }

  // Stage 3: deterministic Review & Quality (no provider calls; reviews unavailable)
  if ((snap.quality_evaluations || []).length > 0) {
    out.quality = { status: 'skipped', reason: 'evaluations already exist' };
  } else {
    const t0 = Date.now();
    await pool.query(
      'INSERT INTO agent_executions (procurement_id,trace_id,agent_name,status,input_hash) VALUES ($1,$2,$3,$4,$5)',
      [id, trace, 'review_quality', 'started', crypto.createHash('sha256').update(JSON.stringify({ products: products.length })).digest('hex')]);
    const qTask = await sendMessage({ id, trace, sender: 'orchestrator', recipient: 'review_quality', type: 'task_assignment',
      objective: `Grade evidence strength for ${products.length} product(s); attribute ratings only on strict explicit patterns; flag missing data.`,
      payload: { products: products.length }, reason: '' });
    const evals = products.map((p) => {
      const sq = classifySource(p.source_url);
      const sc = specCompleteness(p.specifications || {}, PIPELINE_SPEC_FIELDS);
      return [p.product_id, sq.tier, sq.score, sc.completeness, sc.total, sc.verified,
        'not assessed — no verified review data; left unavailable',
        JSON.stringify([{ kind: 'source_classification', tier: sq.tier, label: sq.label }, { kind: 'spec_completeness', verified: sc.verified, total: sc.total }]),
        sq.score >= 0.8 ? 0.8 : sq.score, JSON.stringify([p.source_url]), new Date().toISOString()];
    });
    for (const e of evals) {
      await pool.query(
        `INSERT INTO quality_evaluations (procurement_id,product_id,source_quality,source_quality_score,specification_completeness,spec_fields_total,spec_fields_verified,review_rating,review_scale,review_count,review_evidence,quality_evidence,quality_confidence,source_urls,retrieved_at,data_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,NULL,NULL,$8,$9,$10,$11,$12,'PARTIAL')
         ON CONFLICT (procurement_id,product_id) DO NOTHING`, [id, ...e]);
    }
    await pool.query(
      `UPDATE agent_executions SET status='succeeded',output_hash=$3,completed_at=now(),latency_ms=$4
       WHERE procurement_id=$1 AND trace_id=$2 AND agent_name='review_quality'`,
      [id, trace, crypto.createHash('sha256').update(JSON.stringify({ evaluated: evals.length })).digest('hex'), Date.now() - t0]);
    await advanceIfLegal(id, 'quality_done', { reason: 'quality evaluations persisted' });
    await pool.query('INSERT INTO scoring_configs (procurement_id,weights,spec_fields,notes,rules_version) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (procurement_id) DO UPDATE SET rules_version=EXCLUDED.rules_version',
      [id, JSON.stringify(DEFAULT_WEIGHTS), JSON.stringify(PIPELINE_SPEC_FIELDS), 'Pipeline defaults; deterministic only, reviews unavailable', SCORING_RULES_VERSION]);
    await pool.query(
      'INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES ($1,$2,$3,$4,$5)',
      [id, trace, 'review_quality', 'quality_evaluations_persisted', JSON.stringify({ evaluated: evals.length, with_rating: 0 })]);
    await completeMessage(qTask.message_id, 'completed', Date.now() - t0);
    await sendMessage({ id, trace, parent: qTask.message_id, sender: 'review_quality', recipient: 'orchestrator', type: 'evidence_report',
      objective: 'Report per-product evidence grades and gaps.',
      payload: { evaluated: evals.length, without_ratings: evals.length },
      reason: 'Deterministic tiers + spec completeness only; no review searches on this pass, so review fields stay unavailable rather than guessed.',
      status: 'completed', latency_ms: Date.now() - t0 });
    out.quality = { status: 'completed', evaluated: evals.length, latency_ms: Date.now() - t0 };
    snap = await fresh();
  }

  // Stages 4+5: Comparison + deterministic Scoring Engine
  if ((snap.comparisons || []).length > 0) {
    out.comparison = { status: 'skipped', reason: 'comparisons already exist' };
  } else {
    const t0 = Date.now();
    await pool.query(
      'INSERT INTO agent_executions (procurement_id,trace_id,agent_name,status,input_hash) VALUES ($1,$2,$3,$4,$5)',
      [id, trace, 'comparison', 'started', crypto.createHash('sha256').update(JSON.stringify({ products: products.length })).digest('hex')]);
    const cTask = await sendMessage({ id, trace, sender: 'orchestrator', recipient: 'comparison', type: 'task_assignment',
      objective: 'Normalize candidates, rank via the deterministic scoring engine (read-only), and surface conflicts and gaps.',
      payload: { products: products.length }, reason: '' });
    const qById = Object.fromEntries((snap.quality_evaluations || []).map((q) => [q.product_id, q]));
    const rows = products.map((p) => {
      const ev = qById[p.product_id] || { source_quality: 'LOW', source_quality_score: 0.3, specification_completeness: 0, spec_fields_verified: 0, spec_fields_total: PIPELINE_SPEC_FIELDS.length };
      const components = {
        price: null, quality: null, reviews: null, delivery: null, warranty: null,
        vendor_reliability: null, payment_terms: null, budget_compliance: null,
        source_quality: ev.source_quality_score, specification_completeness: ev.specification_completeness,
      };
      const s = score(components, DEFAULT_WEIGHTS);
      const strengths = [], limitations = [];
      if (ev.source_quality === 'HIGH') strengths.push('High-quality evidence source');
      else limitations.push(`Source quality is ${ev.source_quality} — candidate, not a verified product`);
      if (ev.spec_fields_verified > 0) strengths.push(`${ev.spec_fields_verified}/${ev.spec_fields_total} defined specifications verified`);
      else limitations.push('No defined specifications verifiable from source');
      limitations.push('Review data unavailable');
      limitations.push('Price comparison unavailable');
      return { product_id: p.product_id, overall_score: s.overall_score, criteria_scores: s.breakdown, criteria_used: s.criteria_used, criteria_missing: s.criteria_missing, effective_weight_total: s.effective_weight_total, strengths, limitations, evidence_urls: [p.source_url] };
    });
    // attach verified-offer price evidence where a same-product offer exists
    const offersByProduct = {};
    for (const o of (snap.offers || [])) (offersByProduct[o.product_id] ||= []).push(o);
    const ranked = rankRows(rows);
    for (const r of ranked) {
      const offs = offersByProduct[r.product_id] || [];
      const best = offs.filter((o) => typeof o.net_price === 'number').sort((a, b) => a.net_price - b.net_price)[0] || null;
      await pool.query(
        `INSERT INTO comparisons (procurement_id,product_id,rank,overall_score,criteria_scores,criteria_used,criteria_missing,effective_weight_total,budget_compliance,source_quality,specification_completeness,strengths,limitations,evidence_urls,rules_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'unavailable',$9,$10,$11,$12,$13,$14)
         ON CONFLICT (procurement_id,product_id) DO NOTHING`,
        [id, r.product_id, r.rank, typeof r.overall_score === 'number' ? r.overall_score : null,
         JSON.stringify(r.criteria_scores), JSON.stringify(r.criteria_used), JSON.stringify(r.criteria_missing), r.effective_weight_total,
         0, 0, JSON.stringify(r.strengths), JSON.stringify(r.limitations),
         JSON.stringify(best ? [best.source_url, ...(r.evidence_urls || [])].slice(0, 4) : (r.evidence_urls || [])), SCORING_RULES_VERSION]);
    }
    await pool.query(
      `UPDATE agent_executions SET status='succeeded',output_hash=$3,completed_at=now(),latency_ms=$4
       WHERE procurement_id=$1 AND trace_id=$2 AND agent_name='comparison'`,
      [id, trace, crypto.createHash('sha256').update(JSON.stringify(ranked.map((r) => [r.product_id, r.rank]))).digest('hex'), Date.now() - t0]);
    await advanceIfLegal(id, 'compared', { reason: 'comparisons persisted' });
    await pool.query(
      'INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES ($1,$2,$3,$4,$5)',
      [id, trace, 'comparison', 'comparisons_persisted', JSON.stringify({ ranked: ranked.length })]);
    const ccySets = {};
    for (const o of (snap.offers || [])) (ccySets[o.product_id] ||= new Set()).add(String(o.currency));
    const conflicts = Object.entries(ccySets).filter(([, s]) => s.size > 1).map(([pid]) => pid);
    const unofferedTop = ranked.slice(0, 5).map((r) => r.product_id).filter((pid) => !(offersByProduct[pid] || []).length);
    // Persisted eligibility: same normalized rules the Decision Agent uses.
    {
      const emand = normalizeMandatory(snap.procurement.mandatory_specs);
      const eprods = Object.fromEntries((snap.products || []).map((p) => [p.product_id, {
        ...p,
        specifications: typeof p.specifications === 'string' ? JSON.parse(p.specifications || '{}') : (p.specifications || {}),
      }]));
      const eprefs = typeof snap.procurement.preferred_specs === 'string'
        ? JSON.parse(snap.procurement.preferred_specs || '{}') : (snap.procurement.preferred_specs || {});
      const erows = assessEligibility({ productsById: eprods, mandatory: emand, preferences: eprefs });
      for (const er of erows) {
        await pool.query(
          `INSERT INTO eligibility (procurement_id,product_id,requirement,verdict,evidence)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (procurement_id,product_id,requirement)
           DO UPDATE SET verdict=EXCLUDED.verdict, evidence=EXCLUDED.evidence`,
          [id, er.product_id, er.requirement, er.verdict, JSON.stringify(er.evidence)]);
      }
      await pool.query('INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES ($1,$2,$3,$4,$5)',
        [id, trace, 'comparison', 'eligibility_persisted',
         JSON.stringify(groupCandidates({ productIds: ranked.map((r) => r.product_id), eligibility: erows, mandatory: emand }))]);
    }
    await completeMessage(cTask.message_id, 'completed', Date.now() - t0);
    const cLlmEnv = serverLLMEnv();
    const cLlmConfig = getLLMConfig(cLlmEnv);
    const cLlmRes = await llmAdvisory('comparison', buildComparisonPrompt({
      rankedCount: ranked.length, conflicts, unofferedTop,
      criteriaUsed: ranked[0]?.criteria_used || [],
    }), cLlmEnv, cLlmConfig);
    const cLlmNote = cLlmRes.mode === 'LLM_REASONING'
      ? ` LLM advisory (${cLlmRes.model}) proposes ${cLlmRes.advisory.proposed_action}: ${String(cLlmRes.advisory.reasoning_summary).slice(0, 300)} Ranking unchanged.`
      : ` Deterministic fallback (${cLlmRes.fallback_reason}).`;
    await sendMessage({ id, trace, parent: cTask.message_id, sender: 'comparison', recipient: 'orchestrator', type: 'evidence_report',
      objective: 'Report the ranking plus conflicts and gaps for downstream gating.',
      payload: { ranked: ranked.length, currency_conflicts: conflicts, unoffered_top: unofferedTop,
        llm: cLlmRes.mode === 'LLM_REASONING' ? { model: cLlmRes.model, advisory: cLlmRes.advisory } : { fallback_reason: cLlmRes.fallback_reason } },
      reason: (conflicts.length
        ? `Ranking done, but ${conflicts.length} product(s) carry multi-currency offers (no FX source) — flagged as conflict, never converted.`
        : (unofferedTop.length
          ? `Ranking done; top products lacking offers: ${unofferedTop.length} — decision may request targeted follow-up.`
          : 'Ranking done; top products carry verified offers.')) + cLlmNote,
      status: 'completed', latency_ms: Date.now() - t0,
      reasoning_mode: cLlmRes.mode, llm_model: cLlmRes.model || null });
    out.comparison = { status: 'completed', ranked: ranked.length, latency_ms: Date.now() - t0 };
    snap = await fresh();
  }

  // Eligibility assessment: runs whenever quality evidence exists but no
  // eligibility rows do (including backfill for older compared cases).
  // Idempotent upsert; never deletes.
  if ((snap.quality_evaluations || []).length > 0 && (snap.eligibility || []).length === 0) {
    const emand = normalizeMandatory(snap.procurement.mandatory_specs);
    const eprods = Object.fromEntries((snap.products || []).map((p) => [p.product_id, {
      ...p,
      specifications: typeof p.specifications === 'string' ? JSON.parse(p.specifications || '{}') : (p.specifications || {}),
    }]));
    const eprefs = typeof snap.procurement.preferred_specs === 'string'
      ? JSON.parse(snap.procurement.preferred_specs || '{}') : (snap.procurement.preferred_specs || {});
    const erows = assessEligibility({ productsById: eprods, mandatory: emand, preferences: eprefs });
    for (const er of erows) {
      await pool.query(
        `INSERT INTO eligibility (procurement_id,product_id,requirement,verdict,evidence)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (procurement_id,product_id,requirement)
         DO UPDATE SET verdict=EXCLUDED.verdict, evidence=EXCLUDED.evidence`,
        [id, er.product_id, er.requirement, er.verdict, JSON.stringify(er.evidence)]);
    }
    await pool.query('INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES ($1,$2,$3,$4,$5)',
      [id, trace, 'comparison', 'eligibility_persisted',
       JSON.stringify(groupCandidates({ productIds: (snap.products || []).map((p) => p.product_id), eligibility: erows, mandatory: emand }))]);
    out.eligibility = { status: 'completed', assessed: erows.length };
    snap = await fresh();
  } else {
    out.eligibility = { status: 'skipped', reason: (snap.eligibility || []).length ? 'eligibility already assessed' : 'no quality evidence yet' };
  }

  // Stage 6: Decision Agent (deterministic gates). Re-runs automatically when new
  // evidence arrives after a decision (e.g. offers enriched later) — replanning,
  // never rewriting history (audit keeps every run).
  const priorBlocking = snap.decision?.blocking_reasons || [];
  const offersArrived = (snap.offers || []).length > 0 && priorBlocking.includes('no verified offers');
  let lastDecision = snap.decision || null;
  if (snap.decision && !offersArrived && !req.body?.force_decision) {
    out.decision = { status: 'skipped', reason: 'decision already exists' };
  } else {
    const t0 = Date.now();
    lastDecision = await runDecision(id, trace, snap, offersArrived ? 'offers arrived after prior decision' : (req.body?.force_decision ? 'explicit operator request' : null));
    out.decision = { status: 'completed', decision: lastDecision.decision, recomputed: !!(offersArrived || req.body?.force_decision), latency_ms: Date.now() - t0 };
  }

  // Bounded adaptive replan (max 1 revision cycle per case): a decision blocked
  // on missing offers while enrichable products remain triggers targeted
  // follow-up research, then a decision recompute — replanning, not a fixed chain.
  out.replan = { status: 'skipped', reason: 'no replan needed' };
  if (out.decision?.status === 'completed' && (lastDecision?.blocking_reasons || []).includes('no verified offers')) {
    const { rows: revCount } = await pool.query(
      `SELECT count(*)::int AS n FROM agent_messages WHERE procurement_id=$1 AND message_type='revision_request'`, [id]);
    snap = await fresh();
    const withOffers = new Set((snap.offers || []).map((o) => o.product_id));
    const targets = (snap.comparisons || []).filter((c) => !withOffers.has(c.product_id))
      .sort((a, b) => a.rank - b.rank).slice(0, 5).map((c) => c.product_id);
    if (revCount[0].n < MAX_REPLANS_PER_CASE && targets.length > 0) {
      const tR = Date.now();
      const rev = await sendMessage({ id, trace, sender: 'decision', recipient: 'vendor_research', type: 'revision_request',
        objective: 'Fetch verified offers for the top-ranked products that still lack any offer.',
        payload: { product_ids: targets, replan: revCount[0].n + 1, of_max: MAX_REPLANS_PER_CASE },
        requested_action: `targeted enrichment of ${targets.length} product(s), then decision recompute`,
        reason: `Rank-1 evidence cites 'no verified offers' but ${targets.length} ranked product(s) were never searched; requesting bounded follow-up instead of accepting the gap.` });
      const queue2 = (snap.products || []).filter((p) => targets.includes(p.product_id));
      const enr2 = await enrichProducts({ id, short, queue: queue2, env: serverProviderEnv() });
      await completeMessage(rev.message_id, 'completed', Date.now() - tR);
      await sendMessage({ id, trace, parent: rev.message_id, sender: 'vendor_research', recipient: 'decision', type: 'evidence_report',
        objective: 'Deliver follow-up commercial evidence for the requested products.',
        payload: { offers: enr2.nOffers, skipped: enr2.nSkipped, irrelevant_rejected: enr2.nIrrelevant }, evidence_refs: enr2.sampleUrls,
        tool_calls: [{ tool: 'serpapiShoppingSearch', calls: enr2.nCalls, failures: enr2.nFailures, timeout_ms: 15000 }],
        reason: `Targeted follow-up added ${enr2.nOffers} verified offer(s) across ${targets.length} product(s); decision recompute follows.`,
        status: 'completed', latency_ms: Date.now() - tR });
      snap = await fresh();
      lastDecision = await runDecision(id, trace, snap, `${enr2.nOffers} follow-up offer(s) added`);
      out.replan = { status: 'completed', offers_added: enr2.nOffers, decision: lastDecision.decision, latency_ms: Date.now() - tR };
    } else {
      out.replan = { status: 'skipped', reason: revCount[0].n >= MAX_REPLANS_PER_CASE ? 'replan cap reached; escalated to human instead' : 'no enrichable targets' };
    }
  }
  // A persisted decision means the case is decided, even if n8n left it partial.
  // Only fire when the current status is pre-decision (preserves rerun safety).
  snap = await fresh();
  if (snap.decision && ['created', 'partial', 'product_done', 'vendor_done', 'quality_done', 'compared'].includes(snap.procurement.status)) {
    await transitionStatus(id, 'decided', { actor: 'system:pipeline', reason: 'decision present' });
  }
  const done = await fresh();
  safeJson(res, { procurement_id: id, mode: done.procurement.mode, case_status: done.procurement.status, stages: out });
}));

// ---- inter-agent execution trace (coordination evidence for evaluators) ----
app.get('/api/cases/:id/trace', asyncRoute(async (req, res) => {
  if (!isUuid(req.params.id)) return safeJson(res, { error: 'invalid procurement id' }, 400);
  const vis = await assertCaseVisible(req, req.params.id);
  if (vis !== true) return safeJson(res, { error: 'not found' }, 404);
  const [msgs, execs, exists] = await Promise.all([
    pool.query(`SELECT message_id,parent_message_id,trace_id,sender_agent,recipient_agent,message_type,objective,payload,evidence_refs,requested_action,reason,tool_calls,status,reasoning_mode,llm_model,created_at,completed_at,latency_ms FROM agent_messages WHERE procurement_id=$1 ORDER BY created_at`, [req.params.id]),
    pool.query(`SELECT agent_name,status,input_hash,output_hash,started_at,completed_at,latency_ms,error_message,trace_id FROM agent_executions WHERE procurement_id=$1 ORDER BY started_at NULLS LAST`, [req.params.id]),
    pool.query(`SELECT 1 FROM procurement_cases WHERE procurement_id=$1`, [req.params.id]),
  ]);
  if (!exists.rows.length) return safeJson(res, { error: 'case not found' }, 404);
  safeJson(res, { procurement_id: req.params.id, messages: msgs.rows, executions: execs.rows,
    pending: msgs.rows.length === 0 && execs.rows.length === 0 });
}));

// ---- deduplicated offer groups (derived view; rows preserved, never merged) ----
app.get('/api/cases/:id/offers/grouped', asyncRoute(async (req, res) => {
  if (!isUuid(req.params.id)) return safeJson(res, { error: 'invalid procurement id' }, 400);
  const vis = await assertCaseVisible(req, req.params.id);
  if (vis !== true) return safeJson(res, { error: 'not found' }, 404);
  const { rows } = await pool.query(SNAPSHOT_SQL, [req.params.id]);
  const snap = rows[0]?.snapshot;
  if (!snap?.procurement) return safeJson(res, { error: 'not found' }, 404);
  const vendorsById = Object.fromEntries((snap.vendors || []).map((v) => [v.vendor_id, v]));
  const productsById = Object.fromEntries((snap.products || []).map((p) => [p.product_id, p]));
  const groups = groupOffers({ offers: snap.offers || [], vendorsById, productsById });
  safeJson(res, { procurement_id: req.params.id, total_offers: (snap.offers || []).length, groups,
    policy: 'grouped by merchant + unit price + currency + product; distinct variants, sellers, prices and source offers never merge; source rows preserved' });
}));

// ---- new procurement (proxies to live n8n intake; same validation) ----
app.post('/api/procurements', asyncRoute(async (req, res) => {
  const b = req.body || {};
  const v = validateIntake(b);
  if (!v.valid) return safeJson(res, { error: v.errors.join('; ') }, 400);
  if (b.mode !== undefined && b.mode !== 'REAL' && b.mode !== 'DEMO') {
    return safeJson(res, { error: 'mode must be REAL or DEMO' }, 400);
  }
  if (b.mode === 'DEMO' && !(b.demo_reason && String(b.demo_reason).trim())) {
    return safeJson(res, { error: 'DEMO mode requires an explicit reason' }, 400);
  }
  const idemKey = typeof req.headers['idempotency-key'] === 'string' && req.headers['idempotency-key'].trim()
    ? req.headers['idempotency-key'].trim().slice(0, 64)
    : crypto.randomUUID();
  if (req.headers['idempotency-key']) {
    const prior = await pool.query('SELECT procurement_id, status FROM procurement_cases WHERE client_request_id=$1', [idemKey]);
    if (prior.rows.length) {
      return safeJson(res, { upstream_status: 200, result: null, deduped: true, procurement_id: prior.rows[0].procurement_id, status: prior.rows[0].status }, 200);
    }
  }
  const upstream = await fetch(N8N_WEBHOOK_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requirement: b.requirement, quantity: b.quantity ?? null, budget: b.budget ?? null,
      currency: b.currency, mandatory_specs: b.mandatory_specs ?? {}, preferred_specs: b.preferred_specs ?? {},
      auto_close_on_proceed: false,
      mode: b.mode === 'DEMO' ? 'DEMO' : 'REAL',
      demo_reason: b.mode === 'DEMO' ? String(b.demo_reason).trim() : undefined,
      requested_by: req.user.username,
      client_request_id: idemKey,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await upstream.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* webhook may answer empty on early exits */ }
  if (upstream.ok) {
    // Best-effort immediate attribution (usually too early: n8n creates the
    // row asynchronously after responding — the claim endpoint below is the
    // reliable path and the UI calls it automatically). Prefer the exact
    // idempotency key; fall back to the legacy requirement+time heuristic.
    try {
      const hit = await pool.query(
        `UPDATE procurement_cases SET owner_user_id=$1, created_by=$2
         WHERE procurement_id = (SELECT procurement_id FROM procurement_cases
           WHERE owner_user_id IS NULL AND client_request_id=$3 LIMIT 1)
         RETURNING procurement_id`, [req.session.user_id, req.user.username, idemKey]);
      if (!hit.rows.length) {
        const before = new Date(Date.now() - 15000).toISOString();
        await pool.query(
          `UPDATE procurement_cases SET owner_user_id=$1, created_by=$2
           WHERE procurement_id = (SELECT procurement_id FROM procurement_cases
             WHERE owner_user_id IS NULL AND requirement=$3 AND created_at >= $4
             ORDER BY created_at DESC LIMIT 1)`,
          [req.session.user_id, req.user.username, b.requirement, before]);
      }
    } catch { /* ownership stays unset; case itself is unaffected */ }
  }
  safeJson(res, { upstream_status: upstream.status, result: data, warnings: v.warnings ?? [], idempotency_key: idemKey }, upstream.ok ? 202 : 502);
}));

// Claim ownership of an unowned case (first-come; sets owner to the caller).
// Lets requesters own what they submitted and officers adopt legacy rows.
app.post('/api/cases/:id/claim', asyncRoute(async (req, res) => {
  if (!isUuid(req.params.id)) return safeJson(res, { error: 'invalid procurement id' }, 400);
  if (!['admin', 'requester', 'officer'].includes(req.user.role)) {
    return safeJson(res, { error: 'forbidden for role ' + req.user.role }, 403);
  }
  const trace = crypto.randomUUID();
  const { rows } = await pool.query(
    `UPDATE procurement_cases SET owner_user_id=$1, created_by=COALESCE(created_by, $2)
     WHERE procurement_id=$3 AND owner_user_id IS NULL RETURNING owner_user_id`,
    [req.session.user_id, req.user.username, req.params.id]);
  if (!rows.length) {
    const cur = await pool.query(
      `SELECT u.username AS owner FROM procurement_cases c LEFT JOIN users u ON u.user_id = c.owner_user_id WHERE c.procurement_id=$1`,
      [req.params.id]);
    if (!cur.rows.length) return safeJson(res, { error: 'not found' }, 404);
    return safeJson(res, { error: 'already owned by ' + (cur.rows[0].owner || 'someone else'), owner: cur.rows[0].owner }, 409);
  }
  await pool.query('INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES ($1,$2,$3,$4,$5)',
    [req.params.id, trace, 'requester', 'ownership_claimed', JSON.stringify({ actor: req.user.username })]);
  safeJson(res, { owner: req.user.username });
}));

// Request editing by the owner (requester), procurement officers, or admins.
// Closed cases are immutable; a pending approval must resolve first (otherwise
// the decision would go stale). Every edit bumps version and audit-logs a diff.
app.patch('/api/cases/:id', asyncRoute(async (req, res) => {
  if (!isUuid(req.params.id)) return safeJson(res, { error: 'invalid procurement id' }, 400);
  const { rows } = await pool.query('SELECT * FROM procurement_cases WHERE procurement_id=$1', [req.params.id]);
  const c = rows[0];
  if (!c) return safeJson(res, { error: 'not found' }, 404);
  if (c.status === 'closed') return safeJson(res, { error: 'closed cases are immutable' }, 409);
  if (req.user.role === 'requester' && c.owner_user_id !== req.session.user_id) {
    return safeJson(res, { error: 'requesters may only edit their own requests' }, 403);
  }
  // Edits are allowed while an approval is pending, but they bump the version
  // and therefore invalidate the pending package (decision goes stale with a
  // clear message) — history is preserved, never silently approved.
  const b = req.body || {};
  const sets = [], vals = [], diff = {};
  const put = (col, val) => { sets.push(`${col}=$${sets.length + 1}`); vals.push(val); };
  if (b.requirement !== undefined) {
    if (typeof b.requirement !== 'string' || b.requirement.trim().length < 5) return safeJson(res, { error: 'requirement min 5 chars' }, 400);
    put('requirement', b.requirement.trim().slice(0, 2000)); diff.requirement = true;
  }
  if (b.quantity !== undefined) {
    if (!Number.isInteger(b.quantity) || b.quantity <= 0) return safeJson(res, { error: 'quantity must be a positive integer' }, 400);
    put('quantity', b.quantity); diff.quantity = true;
  }
  if (b.budget !== undefined) {
    if (b.budget !== null && !(typeof b.budget === 'number' && b.budget > 0)) return safeJson(res, { error: 'budget must be a positive number' }, 400);
    put('budget', b.budget); diff.budget = true;
  }
  if (b.currency !== undefined) {
    if (!/^[A-Z]{3}$/.test(String(b.currency))) return safeJson(res, { error: 'currency must be ISO 4217' }, 400);
    put('currency', String(b.currency)); diff.currency = true;
  }
  if (b.delivery_requirement !== undefined) { put('delivery_requirement', b.delivery_requirement ? String(b.delivery_requirement).slice(0, 500) : null); diff.delivery_requirement = true; }
  if (b.mandatory_specs !== undefined) {
    if (typeof b.mandatory_specs !== 'object' || Array.isArray(b.mandatory_specs)) return safeJson(res, { error: 'mandatory_specs must be an object' }, 400);
    put('mandatory_specs', JSON.stringify(b.mandatory_specs)); diff.mandatory_specs = true;
  }
  if (!sets.length) return safeJson(res, { error: 'nothing to update' }, 400);
  vals.push(req.params.id);
  const upd = await pool.query(
    `UPDATE procurement_cases SET ${sets.join(', ')}, version=version+1, updated_at=now() WHERE procurement_id=$${vals.length} RETURNING version`, vals);
  const trace = crypto.randomUUID();
  await pool.query('INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES ($1,$2,$3,$4,$5)',
    [req.params.id, trace, 'requester', 'request_edited', JSON.stringify({ actor: req.user.username, changed: Object.keys(diff), version: upd.rows[0].version })]);
  safeJson(res, { procurement_id: req.params.id, version: upd.rows[0].version, changed: Object.keys(diff) });
}));

// ---- demo mode (explicit, labeled, never sends anything) ----
app.post('/api/cases/:id/demo/mode', asyncRoute(async (req, res) => {
  if (!isUuid(req.params.id)) return safeJson(res, { error: 'invalid procurement id' }, 400);
  let sel;
  try { sel = selectMode({ requested: 'DEMO', reason: req.body?.reason }); }
  catch (e) { return safeJson(res, { error: e.message }, 400); }
  const trace = crypto.randomUUID();
  await pool.query('UPDATE procurement_cases SET mode=$2 WHERE procurement_id=$1', [req.params.id, 'DEMO']);
  await pool.query(`INSERT INTO negotiation_events (negotiation_id,procurement_id,event_type,trace_id,metadata)
                    VALUES (NULL,$1,'demo_mode_selected',$2,$3)`,
    [req.params.id, trace, JSON.stringify({ mode: 'DEMO', reason: sel.reason, actor: req.user.username })]);
  safeJson(res, { mode: 'DEMO', trace_id: trace, message: 'NO MESSAGE SENT TO VENDOR' });
}));

app.post('/api/cases/:id/demo/negotiations', asyncRoute(async (req, res) => {
  if (!isUuid(req.params.id)) return safeJson(res, { error: 'invalid procurement id' }, 400);
  const { offer_id, target_price = null } = req.body || {};
  const trace = crypto.randomUUID();
  const snap = (await pool.query(SNAPSHOT_SQL, [req.params.id])).rows[0]?.snapshot;
  if (!snap?.procurement) return safeJson(res, { error: 'not found' }, 404);
  if (snap.procurement.mode !== 'DEMO') return safeJson(res, { error: 'case is not in DEMO mode (select DEMO first)' }, 409);
  await checkTransition(req.params.id, 'demo_negotiating');
  const offer = (snap.offers || []).find((o) => o.offer_id === offer_id);
  if (!offer || !(Number(offer.net_price) > 0) || !offer.currency) {
    return safeJson(res, { error: 'demo requires a real verified offer (price+currency)' }, 422);
  }
  const vendor = (snap.vendors || []).find((v) => v.vendor_id === offer.vendor_id);
  if (!vendor || !vendor.vendor_name || vendor.vendor_name === 'unavailable') {
    return safeJson(res, { error: 'demo requires a real vendor' }, 422);
  }
  const product = (snap.products || []).find((p) => p.product_id === offer.product_id) || null;
  const unitBudget = snap.procurement.budget && snap.procurement.quantity
    ? Number(snap.procurement.budget) / Number(snap.procurement.quantity) : null;
  const target = (typeof target_price === 'number' && target_price > 0) ? target_price
    : (unitBudget !== null && unitBudget < Number(offer.net_price) ? unitBudget : Number(offer.net_price));
  const discount = Math.round((1 - target / Number(offer.net_price)) * 10000) / 100;
  const negotiation_id = crypto.randomUUID();
  await pool.query(`INSERT INTO negotiations (negotiation_id,procurement_id,product_id,vendor_id,offer_id,mode,status,
                    current_price,currency,target_price,requested_discount_percent,requested_terms,contact_channel,human_confirmation,do_not_send)
                    VALUES ($1,$2,$3,$4,$5,'DEMO','DEMO_READY_FOR_RESPONSE',$6,$7,$8,$9,'[]','{"type":"other","address":"LOCAL_DEMO_ONLY"}',false,true)
                    ON CONFLICT (procurement_id,offer_id) DO NOTHING`,
    [negotiation_id, req.params.id, offer.product_id, offer.vendor_id, offer.offer_id,
     offer.net_price, offer.currency, target, discount]);
  await pool.query(`INSERT INTO negotiation_events (negotiation_id,procurement_id,event_type,trace_id,metadata)
                    VALUES ($1,$2,'demo_negotiation_created',$3,$4)`,
    [negotiation_id, req.params.id, trace, JSON.stringify({ mode: 'DEMO', no_message_sent: true, actor: req.user.username })]);
  await transitionStatus(req.params.id, 'demo_negotiating', { actor: req.user.username, reason: 'demo proposal created' });
  const message = draftMessage({
    negotiation: { product_id: offer.product_id, current_price: Number(offer.net_price), currency: offer.currency, target_price: target, requested_terms: [], contact_channel: { address: 'LOCAL_DEMO_ONLY' } },
    procurement: { quantity: snap.procurement.quantity },
    product: { name: product?.name ?? offer.product_id, evidence_urls: [] },
  });
  const nTask = await sendMessage({ id: req.params.id, trace, sender: 'orchestrator', recipient: 'negotiation', type: 'task_assignment',
    objective: `Draft a local-only negotiation proposal from verified offer ${offer.offer_id}; never contact any vendor.`,
    payload: { offer_id: offer.offer_id, mode: 'DEMO' }, reason: '' });
  await completeMessage(nTask.message_id, 'completed', 0);
  await sendMessage({ id: req.params.id, trace, parent: nTask.message_id, sender: 'negotiation', recipient: 'orchestrator', type: 'evidence_report',
    objective: 'Deliver the unsent proposal draft.',
    payload: { negotiation_id, target_price: target },
    reason: 'Proposal drafted from verified offer facts only; do_not_send=true — nothing left the laptop.',
    status: 'completed', latency_ms: 0 });
  const qty = Number(snap.procurement.quantity) > 0 ? Number(snap.procurement.quantity) : null;
  const round2 = (n) => Math.round(Number(n) * 100) / 100;
  safeJson(res, { negotiation_id, status: 'DEMO_READY_FOR_RESPONSE', target_price: target, message, sent: false, vendors_contacted: 0,
    original_unit_price: Number(offer.net_price), currency: offer.currency,
    original_total: qty ? round2(Number(offer.net_price) * qty) : null,
    target_total: qty ? round2(target * qty) : null,
    potential_savings: qty ? round2((Number(offer.net_price) - target) * qty) : null,
    quantity: qty }, 201);
}));

// REAL proposal (unsent internal draft, never sent — no contact tool exists).
// Officer/admin only. Duplicate submissions return the existing proposal.
app.post('/api/cases/:id/negotiations', asyncRoute(async (req, res) => {
  if (!isUuid(req.params.id)) return safeJson(res, { error: 'invalid procurement id' }, 400);
  const { offer_id, target_price = null } = req.body || {};
  const trace = crypto.randomUUID();
  const snap = (await pool.query(SNAPSHOT_SQL, [req.params.id])).rows[0]?.snapshot;
  if (!snap?.procurement) return safeJson(res, { error: 'not found' }, 404);
  if ((snap.procurement.mode || 'REAL') !== 'REAL') return safeJson(res, { error: 'REAL proposals need a REAL case (use DEMO simulation otherwise)' }, 409);
  const vis = await assertCaseVisible(req, req.params.id);
  if (vis !== true) return safeJson(res, { error: 'not found' }, 404);
  const offer = (snap.offers || []).find((o) => o.offer_id === offer_id);
  if (!offer || !(Number(offer.net_price) > 0) || !offer.currency) {
    return safeJson(res, { error: 'NOT_READY: needs a real verified offer (price+currency)' }, 422);
  }
  const vendor = (snap.vendors || []).find((v) => v.vendor_id === offer.vendor_id);
  if (!vendor || !vendor.vendor_name || vendor.vendor_name === 'unavailable') {
    return safeJson(res, { error: 'NOT_READY: needs a real vendor' }, 422);
  }
  const existing = (snap.negotiations || []).find((n) => n.offer_id === offer_id && n.mode === 'REAL');
  if (existing) {
    return safeJson(res, { negotiation_id: existing.negotiation_id, status: existing.status, existing: true, sent: false, vendors_contacted: 0 });
  }
  const qty = Number(snap.procurement.quantity) > 0 ? Number(snap.procurement.quantity) : null;
  const unitBudget = snap.procurement.budget && qty ? Number(snap.procurement.budget) / qty : null;
  let target = null, basis = null;
  if (typeof target_price === 'number' && target_price > 0 && target_price <= Number(offer.net_price)) {
    target = target_price; basis = 'explicit_requested_target';
  } else {
    const computed = computeTarget({ current_price: Number(offer.net_price), currency: offer.currency, budget: unitBudget, budgetCurrency: snap.procurement.currency });
    target = computed.target_price; basis = computed.basis;
  }
  if (!(target > 0)) {
    await pool.query(`INSERT INTO negotiation_events (negotiation_id,procurement_id,event_type,trace_id,metadata)
                      VALUES (NULL,$1,'negotiation_failed',$2,$3)`,
      [req.params.id, trace, JSON.stringify({ mode: 'REAL', reason: 'no defensible target (no budget basis, no explicit target)', actor: req.user.username })]);
    return safeJson(res, { error: 'NOT_READY: no defensible target — provide target_price or a same-currency budget below list price' }, 422);
  }
  const product = (snap.products || []).find((p) => p.product_id === offer.product_id) || null;
  const negotiation_id = crypto.randomUUID();
  const discount = Math.round((1 - target / Number(offer.net_price)) * 10000) / 100;
  await pool.query(`INSERT INTO negotiations (negotiation_id,procurement_id,product_id,vendor_id,offer_id,mode,status,
                    current_price,currency,target_price,requested_discount_percent,requested_terms,contact_channel,human_confirmation,do_not_send)
                    VALUES ($1,$2,$3,$4,$5,'REAL','READY_FOR_HUMAN_REVIEW',$6,$7,$8,$9,'[]','{}',false,true)
                    ON CONFLICT (procurement_id,offer_id) DO NOTHING`,
    [negotiation_id, req.params.id, offer.product_id, offer.vendor_id, offer.offer_id,
     offer.net_price, offer.currency, target, discount]);
  await pool.query(`INSERT INTO negotiation_events (negotiation_id,procurement_id,event_type,trace_id,metadata)
                    VALUES ($1,$2,'negotiation_created',$3,$4)`,
    [negotiation_id, req.params.id, trace, JSON.stringify({ mode: 'REAL', do_not_send: true, target_basis: basis, actor: req.user.username })]);
  const message = draftMessage({
    negotiation: { product_id: offer.product_id, current_price: Number(offer.net_price), currency: offer.currency, target_price: target, requested_terms: [], contact_channel: {} },
    procurement: { quantity: snap.procurement.quantity },
    product: { name: product?.name ?? offer.product_id, evidence_urls: [] },
  });
  const round2 = (n) => Math.round(Number(n) * 100) / 100;
  await sendMessage({ id: req.params.id, trace, sender: 'negotiation', recipient: 'orchestrator', type: 'evidence_report',
    objective: 'Deliver the unsent REAL proposal draft with its evidence basis.',
    payload: { negotiation_id, offer_id: offer.offer_id, target_price: target, target_basis: basis },
    reason: `Proposal drafted from verified offer facts only (basis: ${basis}); do_not_send=true — nothing left the laptop. Unknowns: stock, delivery, warranty, payment terms.`,
    status: 'completed', latency_ms: 0 });
  safeJson(res, { negotiation_id, status: 'READY_FOR_HUMAN_REVIEW', target_price: target, target_basis: basis, message,
    sent: false, vendors_contacted: 0,
    original_unit_price: Number(offer.net_price), currency: offer.currency,
    original_total: qty ? round2(Number(offer.net_price) * qty) : null,
    target_total: qty ? round2(target * qty) : null,
    potential_savings: qty ? round2((Number(offer.net_price) - target) * qty) : null,
    quantity: qty,
    assumptions: ['stock/availability unknown', 'delivery unknown', 'warranty unknown', 'payment terms unknown', 'target acceptance unknown'] }, 201);
}));

app.post('/api/cases/:id/demo/responses', asyncRoute(async (req, res) => {
  if (!isUuid(req.params.id)) return safeJson(res, { error: 'invalid procurement id' }, 400);
  const b = req.body || {};
  const trace = crypto.randomUUID();
  const snap = (await pool.query(SNAPSHOT_SQL, [req.params.id])).rows[0]?.snapshot;
  if (!snap?.procurement) return safeJson(res, { error: 'not found' }, 404);
  if (snap.procurement.mode !== 'DEMO') return safeJson(res, { error: 'case is not in DEMO mode' }, 409);
  await checkTransition(req.params.id, 'demo_response_received');
  const nego = (snap.negotiations || []).find((n) => n.negotiation_id === (b.negotiation_id || null) && n.mode === 'DEMO')
    || (snap.negotiations || []).find((n) => n.mode === 'DEMO');
  if (!nego) return safeJson(res, { error: 'no DEMO negotiation exists for this case' }, 409);
  const offer = (snap.offers || []).find((o) => o.offer_id === nego.offer_id);
  const demoResp = {
    channel: 'demo', response_mode: 'DEMO_HUMAN_ENTERED', vendor_response_verified: false,
    revised_price: Number(b.revised_price), currency: String(b.currency || '').toUpperCase(),
    received_at: new Date().toISOString(), source: 'LOCAL_DEMO_INPUT',
    delivery_days: b.delivery_days ?? 'unavailable', warranty: b.warranty ?? 'unavailable',
    payment_terms: b.payment_terms ?? 'unavailable', notes: b.notes ?? '',
  };
  const v = validateDemoResponse({ offer, ...demoResp });
  if (!v.valid) return safeJson(res, { error: v.reasons.join('; ') }, 422);
  await pool.query(`INSERT INTO demo_responses (procurement_id,negotiation_id,offer_id,revised_price,currency,delivery_days,warranty,payment_terms,notes,response_mode,source,vendor_response_verified,entered_by)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'DEMO_HUMAN_ENTERED','LOCAL_DEMO_INPUT',false,'HUMAN')`,
    [req.params.id, nego.negotiation_id, offer.offer_id, demoResp.revised_price, demoResp.currency,
     demoResp.delivery_days, demoResp.warranty, demoResp.payment_terms, demoResp.notes]);
  await pool.query('UPDATE negotiations SET status=$2 WHERE negotiation_id=$1', [nego.negotiation_id, 'DEMO_RESPONSE_RECEIVED']);
  await pool.query(`INSERT INTO negotiation_events (negotiation_id,procurement_id,event_type,trace_id,metadata)
                    VALUES ($1,$2,'demo_response_received',$3,$4)`,
    [nego.negotiation_id, req.params.id, trace, JSON.stringify({ mode: 'DEMO', actor: req.user.username })]);
  await transitionStatus(req.params.id, 'demo_response_received', { actor: req.user.username, reason: 'demo response entered' });
  safeJson(res, { status: 'DEMO_RESPONSE_RECEIVED', response_mode: 'DEMO_HUMAN_ENTERED' }, 201);
}));

app.post('/api/cases/:id/demo/reevaluate', asyncRoute(async (req, res) => {
  if (!isUuid(req.params.id)) return safeJson(res, { error: 'invalid procurement id' }, 400);
  const trace = crypto.randomUUID();
  const snap = (await pool.query(SNAPSHOT_SQL, [req.params.id])).rows[0]?.snapshot;
  if (!snap?.procurement) return safeJson(res, { error: 'not found' }, 404);
  if (snap.procurement.mode !== 'DEMO') return safeJson(res, { error: 'case is not in DEMO mode' }, 409);
  const nego = (snap.negotiations || []).find((n) => n.negotiation_id === (req.body?.negotiation_id || null) && n.mode === 'DEMO')
    || (snap.negotiations || []).find((n) => n.mode === 'DEMO');
  if (!nego) return safeJson(res, { error: 'no DEMO negotiation' }, 409);
  const demo = (snap.demo_responses || []).filter((r) => r.negotiation_id === nego.negotiation_id).at(-1);
  if (!demo) return safeJson(res, { error: 'no human-entered demo response yet' }, 409);
  await checkTransition(req.params.id, 'reevaluated');
  const offer = (snap.offers || []).find((o) => o.offer_id === nego.offer_id);
  const vendor = (snap.vendors || []).find((v) => v.vendor_id === nego.vendor_id);
  const comp = (snap.comparisons || []).find((c) => c.product_id === nego.product_id);
  const origComps = {};
  for (const [k, v] of Object.entries(comp?.criteria_scores || {})) origComps[k] = v && typeof v.score === 'number' ? v.score : null;
  const response = {
    channel: 'demo', response_mode: 'DEMO_HUMAN_ENTERED', vendor_response_verified: false,
    vendor_id: nego.vendor_id, offer_id: nego.offer_id, revised_price: Number(demo.revised_price),
    currency: demo.currency, received_at: demo.created_at, source: 'LOCAL_DEMO_INPUT',
  };
  const r = reevaluate({
    original: { components: origComps, price: Number(offer.net_price), currency: offer.currency, budget: snap.procurement.budget && snap.procurement.quantity ? Number(snap.procurement.budget) / Number(snap.procurement.quantity) : null },
    response, weights: DEFAULT_WEIGHTS, mode: 'DEMO',
    ctx: { negotiation: nego, offer, vendor, product: { product_id: nego.product_id }, response },
  });
  if (r.status !== 'REEVALUATED') return safeJson(res, { error: 'rejected', reasons: r.reasons ?? [] }, 422);
  const t0 = Date.now();
  const provenance = { scoring_rules_version: r.scoring_rules_version || SCORING_RULES_VERSION, criteria: r.score_provenance || {} };
  await pool.query(`INSERT INTO reevaluations (procurement_id,negotiation_id,product_id,vendor_id,offer_id,mode,original_score,revised_score,score_delta,original_price,revised_price,currency,absolute_savings,percentage_savings,criteria_changed,criteria_used,criteria_missing,evidence_urls,status,score_provenance)
                    VALUES ($1,$2,$3,$4,$5,'DEMO',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'REEVALUATED',$18)
                    ON CONFLICT (procurement_id,negotiation_id) DO UPDATE SET revised_score=EXCLUDED.revised_score,score_delta=EXCLUDED.score_delta,revised_price=EXCLUDED.revised_price,absolute_savings=EXCLUDED.absolute_savings,percentage_savings=EXCLUDED.percentage_savings,criteria_changed=EXCLUDED.criteria_changed,score_provenance=EXCLUDED.score_provenance`,
    [req.params.id, nego.negotiation_id, nego.product_id, nego.vendor_id, nego.offer_id,
     r.original_score, r.revised_score, r.score_delta, r.original_price, r.revised_price, r.currency,
     r.absolute_savings, r.percentage_savings, JSON.stringify(r.criteria_changed),
     JSON.stringify(r.criteria_used), JSON.stringify(r.criteria_missing), JSON.stringify([offer.source_url]), JSON.stringify(provenance)]);
  await transitionStatus(req.params.id, 'reevaluated', { actor: req.user.username, reason: 'demo re-evaluation completed' });
  await pool.query('INSERT INTO agent_executions (procurement_id,trace_id,agent_name,status,input_hash,output_hash,completed_at,latency_ms) VALUES ($1,$2,$3,$4,$5,$6,now(),$7)',
    [req.params.id, trace, 'reevaluation', 'succeeded', 'demo', 'demo', Date.now() - t0]);
  // History is preserved: every run appends its full before/after payload here;
  // the reevaluations row keeps only the latest.
  await pool.query('INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES ($1,$2,$3,$4,$5)',
    [req.params.id, trace, 'reevaluation', 'reevaluation_completed',
     JSON.stringify({ actor: req.user.username, negotiation_id: nego.negotiation_id, original_price: r.original_price, revised_price: r.revised_price, currency: r.currency, absolute_savings: r.absolute_savings, percentage_savings: r.percentage_savings, original_score: r.original_score, revised_score: r.revised_score, score_delta: r.score_delta, criteria_changed: r.criteria_changed, score_provenance: provenance })]);
  // Decision recompute against the revised terms: the original decision row is
  // history and is never rewritten. Instead the gates run on a revised overlay
  // (demo terms labeled hypothetical) and the assessment is recorded on the
  // audit trail, the trace, and the response. A lower price alone never flips
  // blockers that are about evidence, not price.
  const revisedOffersByProduct = {};
  for (const p of (snap.products || [])) revisedOffersByProduct[p.product_id] = [];
  for (const o of (snap.offers || [])) {
    if (o.offer_id === nego.offer_id) {
      revisedOffersByProduct[o.product_id].push({ ...o, net_price: Number(demo.revised_price), _hypothetical: true });
    } else {
      revisedOffersByProduct[o.product_id].push(o);
    }
  }
  const postReeval = decide({
    procurement: { procurement_id: req.params.id, budget: snap.procurement.budget != null ? Number(snap.procurement.budget) : null, currency: snap.procurement.currency, quantity: snap.procurement.quantity },
    ranked: (snap.comparisons || []).map((x) => ({ ...x, overall_score: x.product_id === nego.product_id && typeof r.revised_score === 'number' ? r.revised_score : (x.overall_score === null ? null : Number(x.overall_score)) })),
    offersByProduct: revisedOffersByProduct,
    vendorsById: Object.fromEntries((snap.vendors || []).map((vv) => [vv.vendor_id, { ...vv, contact_channel: null }])),
    productsById: Object.fromEntries((snap.products || []).map((pp) => [pp.product_id, { ...pp, specifications: typeof pp.specifications === 'string' ? JSON.parse(pp.specifications) : pp.specifications }])),
    mandatory: normalizeMandatory(snap.procurement.mandatory_specs),
  });
  await pool.query('INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES ($1,$2,$3,$4,$5)',
    [req.params.id, trace, 'decision', 'post_reevaluation_assessment',
     JSON.stringify({ actor: req.user.username, hypothetical_terms: true, mode: 'DEMO', revised_price: r.revised_price, currency: r.currency, outcome: postReeval.decision, reason: postReeval.decision_reason, blocking: postReeval.blocking_reasons })]);
  await sendMessage({ id: req.params.id, trace, sender: 'decision', recipient: 'human', type: 'handoff',
    objective: 'Report the post-reevaluation assessment against the revised (hypothetical, DEMO-labeled) terms.',
    payload: { outcome: postReeval.decision, blocking_reasons: postReeval.blocking_reasons, revised_price: r.revised_price, currency: r.currency, hypothetical_terms: true },
    requested_action: 'review the assessment and the original decision before approving anything',
    reason: `Re-running the gates on revised demo terms yields ${postReeval.decision}: ${postReeval.decision_reason} Original decision row unchanged.`,
    status: 'sent' });
  await sendMessage({ id: req.params.id, trace, sender: 'reevaluation', recipient: 'human', type: 'handoff',
    objective: 'Hand revised terms and score deltas to a human for the approval decision.',
    payload: { negotiation_id: nego.negotiation_id, revised_score: r.revised_score, score_delta: r.score_delta, absolute_savings: r.absolute_savings, score_provenance: provenance, post_reevaluation_assessment: postReeval.decision },
    requested_action: 'review the re-evaluation and record an explicit approval decision',
    reason: `Re-scored with the same engine: ${r.original_score} -> ${r.revised_score} (delta ${r.score_delta}); savings ${r.absolute_savings} ${r.currency}. Demo input stays labeled, never verified. Post-reevaluation assessment: ${postReeval.decision}.`,
    status: 'sent' });
  safeJson(res, { status: 'REEVALUATED', mode: 'DEMO', ...r, score_provenance: provenance, post_reevaluation_assessment: { outcome: postReeval.decision, reason: postReeval.decision_reason, blocking_reasons: postReeval.blocking_reasons, hypothetical_terms: true } });
}));

function assemblePackage(snap, reevaluation) {
  const offer = (snap.offers || [])[0] || null;
  const product = offer && (snap.products || []).find((p) => p.product_id === offer.product_id);
  const vendor = offer && (snap.vendors || []).find((v) => v.vendor_id === offer.vendor_id);
  const comp = offer && (snap.comparisons || []).find((c) => c.product_id === offer.product_id);
  const re = reevaluation || (snap.reevaluations || []).find((x) => x.mode === 'DEMO') || null;
  // Quantity-aware budget basis: budget is a TOTAL for `quantity` units; offers
  // are UNIT prices. Totals below are partial estimates (tax/shipping/delivery
  // unknown, never invented).
  const qty = Number.isInteger(snap.procurement.quantity) && snap.procurement.quantity > 0 ? snap.procurement.quantity : null;
  const ub = (snap.procurement.budget != null && qty !== null) ? unitBudget(Number(snap.procurement.budget), qty) : null;
  const unitP = offer && typeof offer.net_price === 'number' ? Number(offer.net_price) : (offer && typeof offer.unit_price === 'number' ? Number(offer.unit_price) : null);
  const totalEst = (unitP !== null && qty !== null) ? totalFor(unitP, qty) : null;
  const bv = (unitP !== null) ? budgetVerdict({ unitPrice: unitP, currency: offer?.currency, budget: snap.procurement.budget != null ? Number(snap.procurement.budget) : null, budgetCurrency: snap.procurement.currency, quantity: snap.procurement.quantity }) : null;
  return {
    procurement_request: { requirement: snap.procurement.requirement, quantity: snap.procurement.quantity, budget: snap.procurement.budget, currency: snap.procurement.currency,
      budget_basis: 'total_budget_for_quantity',
      unit_budget: ub, total_estimate: totalEst, total_budget: snap.procurement.budget != null ? Number(snap.procurement.budget) : null,
      budget_verdict: bv?.verdict ?? 'unavailable', budget_verdict_reason: bv?.reason ?? null,
      partial_estimate: true, partial_excludes: ['tax', 'shipping', 'delivery', 'discounts', 'availability'] },
    selected_product: product ? { product_id: product.product_id, name: product.name } : 'unavailable',
    selected_vendor: vendor ? { vendor_id: vendor.vendor_id, vendor_name: vendor.vendor_name } : 'unavailable',
    original_offer: offer ?? 'unavailable',
    revised_offer: re ? { revised_price: re.revised_price, currency: re.currency, absolute_savings: re.absolute_savings, percentage_savings: re.percentage_savings,
      hypothetical: (snap.procurement.mode || 'REAL') === 'DEMO',
      hypothetical_note: (snap.procurement.mode || 'REAL') === 'DEMO' ? 'human-entered DEMO price, not a verified vendor quotation' : null } : 'unavailable',
    original_score: comp?.overall_score ?? re?.original_score ?? 'unavailable',
    revised_score: re?.revised_score ?? 'unavailable',
    savings: re ? { absolute: re.absolute_savings ?? 'unavailable', percentage: re.percentage_savings ?? 'unavailable', currency: re.currency } : 'unavailable',
    quality_evidence: 'see quality_evaluations table',
    review_evidence: 'see quality_evaluations table',
    delivery_information: offer?.delivery_days ?? demoFallback(snap, 'delivery'),
    warranty_information: offer?.warranty_months ?? demoFallback(snap, 'warranty'),
    payment_terms: offer?.payment_terms ?? demoFallback(snap, 'payment'),
    // When a re-evaluation exists, the package mirrors the STORED reevaluation
    // row for criteria/provenance (the revised score's actual basis), not the
    // pre-revision comparison row — otherwise the package would disagree with
    // the re-evaluation record (e.g. [] vs ['budget_compliance']).
    criteria_used: re?.criteria_used ?? comp?.criteria_used ?? [],
    criteria_missing: re?.criteria_missing ?? comp?.criteria_missing ?? [],
    // Score provenance mirrors the stored reevaluation row when one exists,
    // so the package never disagrees with the re-evaluation record.
    score_provenance: re?.score_provenance ?? 'unavailable',
    scoring_rules_version: (snap.scoring_configs || [])[0]?.rules_version ?? 'unavailable',
    limitations: ['PROCUREMENT MODE: ' + (snap.procurement.mode || 'REAL'),
      ...(snap.procurement.mode === 'DEMO' ? ['VENDOR RESPONSE: HUMAN-ENTERED DEMO DATA', 'NO REAL VENDOR CONTACTED', 'NO MESSAGE SENT TO VENDOR'] : []),
      ...((comp?.limitations ?? re?.limitations) || [])],
    evidence_urls: comp?.evidence_urls ?? [],
    negotiation_history: (snap.negotiations || []).map((n) => ({ mode: n.mode, status: n.status, offer_id: n.offer_id })),
    status: 'PENDING_APPROVAL',
  };
  function demoFallback(s, kind) {
    const d = (s.demo_responses || []).at(-1);
    if (!d) return 'unavailable';
    if (kind === 'delivery') return d.delivery_days ?? 'unavailable';
    if (kind === 'warranty') return d.warranty ?? 'unavailable';
    return d.payment_terms ?? 'unavailable';
  }
}

app.post('/api/cases/:id/approvals', asyncRoute(async (req, res) => {
  if (!isUuid(req.params.id)) return safeJson(res, { error: 'invalid procurement id' }, 400);
  const trace = crypto.randomUUID();
  const snap = (await pool.query(SNAPSHOT_SQL, [req.params.id])).rows[0]?.snapshot;
  if (!snap?.procurement) return safeJson(res, { error: 'not found' }, 404);
  if (['closed'].includes(snap.procurement.status)) {
    return safeJson(res, { error: 'case is closed; approvals are immutable history' }, 409);
  }
  await checkTransition(req.params.id, 'pending_approval');
  const existingPending = (snap.approvals || []).find((a) => a.status === 'PENDING_APPROVAL');
  if (existingPending) {
    return safeJson(res, { approval_id: existingPending.approval_id, status: 'PENDING_APPROVAL', existing: true }, 200);
  }
  // REAL guard: a non-PROCEED case with no eligible offer cannot become
  // a REAL purchase through approval — resolve evidence first (or use DEMO).
  const elig = (snap.offers || []).filter((o) => Number(o.net_price) > 0 && o.currency &&
    (snap.vendors || []).some((v) => v.vendor_id === o.vendor_id && v.vendor_name && v.vendor_name !== 'unavailable'));
  if ((snap.procurement.mode || 'REAL') === 'REAL' && ['INSUFFICIENT_DATA', 'NO_ELIGIBLE_OFFERS', 'RESEARCH_REQUIRED'].includes(snap.decision?.decision) && !elig.length) {
    return safeJson(res, { error: `REAL approval blocked: ${snap.decision.decision} with no eligible offer. Gather evidence or demonstrate in DEMO mode.` }, 422);
  }
  const pkg = assemblePackage(snap, null);
  const pkgCheck = validatePackage(pkg);
  if (!pkgCheck.complete) return safeJson(res, { error: 'package incomplete: ' + pkgCheck.missing.join(',') }, 422);
  const offer = (snap.offers || [])[0] || null;
  const product = offer && (snap.products || []).find((p) => p.product_id === offer.product_id);
  const vendor = offer && (snap.vendors || []).find((v) => v.vendor_id === offer.vendor_id);
  const apprId = crypto.randomUUID();
  let newApprovalId;
  const scoringVersion = (snap.scoring_configs || [])[0]?.rules_version || SCORING_RULES_VERSION;
  const decisionAtPkg = snap.decision?.decision || null;
  try {
    const ins = await pool.query(
      `INSERT INTO approvals (approval_id,procurement_id,selected_product_id,selected_vendor_id,selected_offer_id,mode,status,approval_package,request_version,scoring_version,decision_at_package,offer_price,offer_currency)
       VALUES ($1,$2,$3,$4,$5,$6,'PENDING_APPROVAL',$7,$8,$9,$10,$11,$12) RETURNING approval_id`,
      [apprId, req.params.id, product?.product_id ?? null, vendor?.vendor_id ?? null, offer?.offer_id ?? null,
       snap.procurement.mode || 'REAL', JSON.stringify(pkg), snap.procurement.version ?? 1,
       scoringVersion, decisionAtPkg,
       offer && typeof offer.net_price === 'number' ? Number(offer.net_price) : null,
       offer?.currency || null]);
    newApprovalId = ins.rows[0].approval_id;
  } catch (e) {
    // Concurrent duplicate: the partial unique index kept exactly one PENDING
    // row — return it instead of failing (idempotent under retries/races).
    if (e.code === '23505') {
      const dup = await pool.query(
        `SELECT approval_id FROM approvals WHERE procurement_id=$1 AND status='PENDING_APPROVAL' ORDER BY created_at DESC LIMIT 1`,
        [req.params.id]);
      if (dup.rows.length) return safeJson(res, { approval_id: dup.rows[0].approval_id, status: 'PENDING_APPROVAL', existing: true }, 200);
    }
    throw e;
  }
  await pool.query(`INSERT INTO approval_events (approval_id,procurement_id,event_type,actor,trace_id,metadata)
                    VALUES ($1,$2,'approval_created',$3,$4,$5)`,
    [newApprovalId, req.params.id, req.user.username, trace,
     JSON.stringify({ mode: snap.procurement.mode || 'REAL', request_version: snap.procurement.version ?? 1 })]);
  await transitionStatus(req.params.id, 'pending_approval', { actor: req.user.username, reason: 'approval package created' });
  safeJson(res, { approval_id: newApprovalId, status: 'PENDING_APPROVAL' }, 201);
}));

app.post('/api/approvals/:approvalId/decision', asyncRoute(async (req, res) => {
  const { decision, reason } = req.body || {};
  const actor = req.user.username;
  const trace = crypto.randomUUID();
  const { rows } = await pool.query('SELECT * FROM approvals WHERE approval_id=$1', [req.params.approvalId]);
  const appr = rows[0];
  if (!appr) return safeJson(res, { error: 'approval not found' }, 404);
  if (appr.status !== 'PENDING_APPROVAL') return safeJson(res, { error: 'already decided: ' + appr.status }, 409);
  const cs = await pool.query('SELECT status, mode, version, budget, quantity, currency, owner_user_id FROM procurement_cases WHERE procurement_id=$1', [appr.procurement_id]);
  const c = cs.rows[0];
  if (!c) return safeJson(res, { error: 'case not found' }, 404);
  // Unified stale-package guard: mode, request version, offer identity/price/
  // currency, scoring version, and quantity/budget (totals) must all still match
  // the reviewed package. Any drift fails closed with a fresh-package message.
  {
    const curOffer = appr.selected_offer_id
      ? (await pool.query('SELECT net_price, currency FROM offers WHERE offer_id=$1 AND procurement_id=$2', [appr.selected_offer_id, appr.procurement_id])).rows[0] || null
      : null;
    const curScoring = (await pool.query('SELECT rules_version FROM scoring_configs WHERE procurement_id=$1', [appr.procurement_id])).rows[0]?.rules_version || SCORING_RULES_VERSION;
    const stale = isApprovalStale({
      approval: { ...appr, scoring_version: appr.scoring_version || appr.approval_package?.scoring_rules_version },
      current: { mode: c.mode, version: c.version, selected_offer_id: appr.selected_offer_id,
        offer_price: curOffer ? Number(curOffer.net_price) : null, offer_currency: curOffer?.currency || null,
        scoring_version: curScoring, quantity: c.quantity, budget: c.budget != null ? Number(c.budget) : null },
    });
    if (stale.stale) {
      await pool.query(`INSERT INTO approval_events (approval_id,procurement_id,event_type,actor,trace_id,metadata)
                        VALUES ($1,$2,'decision_rejected_stale',$3,$4,$5)`,
        [appr.approval_id, appr.procurement_id, actor, trace, JSON.stringify({ reasons: stale.reasons })]);
      const first = stale.reasons[0] || 'package stale';
      if (/mode/i.test(first)) return safeJson(res, { error: `stale package: ${first}` }, 409);
      return safeJson(res, { error: `stale package: ${stale.reasons.join('; ')}. Request a new package.` }, 409);
    }
  }
  if (c.owner_user_id && c.owner_user_id === req.session.user_id) {
    return safeJson(res, { error: 'separation of duties: cannot approve your own request' }, 403);
  }
  const limit = req.user.approval_limit;
  if (limit != null && c.budget != null && Number(c.budget) > limit) {
    return safeJson(res, { error: `over authorization limit (${limit}); case budget is ${c.budget}` }, 403);
  }
  if (appr.selected_offer_id) {
    const off = await pool.query('SELECT net_price, currency FROM offers WHERE offer_id=$1 AND procurement_id=$2', [appr.selected_offer_id, appr.procurement_id]);
    const pkgOffer = appr.approval_package?.original_offer;
    if (!off.rows.length || (pkgOffer && pkgOffer !== 'unavailable' &&
        (Number(off.rows[0].net_price) !== Number(pkgOffer.net_price) || off.rows[0].currency !== pkgOffer.currency))) {
      return safeJson(res, { error: 'stale package: selected offer terms changed since review' }, 409);
    }
  }
  const v = validateDecisionInput({ approval_id: appr.approval_id, procurement_id: appr.procurement_id, decision, actor, decided_at: new Date().toISOString() });
  if (!v.valid) return safeJson(res, { error: v.reasons.join('; ') }, 422);
  // Approving past a non-PROCEED decision is an explicit human override: it
  // requires a written justification, never silence. (INSUFFICIENT_DATA must
  // never become an approval merely because a demo response was entered —
  // demo responses also require DEMO mode, enforced above via mode match.)
  if (decision === 'APPROVED') {
    const dr = await pool.query('SELECT decision FROM decisions WHERE procurement_id=$1', [appr.procurement_id]);
    const dv = dr.rows[0]?.decision;
    if ((!dv || dv !== 'PROCEED') && !(typeof reason === 'string' && reason.trim().length >= 10)) {
      return safeJson(res, { error: `approving a '${dv ?? 'undecided'}' case requires a written justification (min 10 chars)` }, 422);
    }
  }
  const close = closureTransition(decision);
  const closeChk = canClose(decision, appr.mode);
  if (close.close && !closeChk.ok) return safeJson(res, { error: closeChk.reason }, 409);
  await checkTransition(appr.procurement_id, close.status);
  const newStatus = decision === 'APPROVED' ? 'APPROVED' : decision === 'REJECTED' ? 'REJECTED' : 'CHANGES_REQUESTED';
  await pool.query('UPDATE approvals SET status=$2,approved_by=$3,approved_at=now(),decision_reason=$4,decided_by_user_id=$5,decided_role=$6,request_version=$7 WHERE approval_id=$1',
    [appr.approval_id, newStatus, actor, reason ?? null, req.session.user_id, req.user.role, c.version]);
  await pool.query(`INSERT INTO approval_events (approval_id,procurement_id,event_type,actor,trace_id,metadata)
                    VALUES ($1,$2,$3,$4,$5,$6)`,
    [appr.approval_id, appr.procurement_id, close.event, actor, trace,
     JSON.stringify({ mode: appr.mode, decided_by: req.session.user_id, role: req.user.role, request_version: c.version })]);
  await transitionStatus(appr.procurement_id, close.status, { actor, reason: `approval decision ${newStatus}` });
  safeJson(res, { status: newStatus, case_status: close.status, closed: close.close, decided_by: actor,
    mode: appr.mode, simulation: appr.mode === 'DEMO',
    simulation_note: appr.mode === 'DEMO' ? 'DEMO simulation only — not a real purchase authorization' : null });
}));

// Purchase handoff: records verified downstream progress for a REAL approval.
// Only from a closed case whose latest approval is APPROVED + REAL (a DEMO
// approval is never purchasing authorization). Terminal state after this.
app.post('/api/cases/:id/handoff', asyncRoute(async (req, res) => {
  if (!isUuid(req.params.id)) return safeJson(res, { error: 'invalid procurement id' }, 400);
  if (!['admin', 'officer'].includes(req.user.role)) return safeJson(res, { error: 'forbidden for role ' + req.user.role }, 403);
  const snap = (await pool.query(SNAPSHOT_SQL, [req.params.id])).rows[0]?.snapshot;
  if (!snap?.procurement) return safeJson(res, { error: 'not found' }, 404);
  const vis = await assertCaseVisible(req, req.params.id);
  if (vis !== true) return safeJson(res, { error: 'not found' }, 404);
  const latest = (snap.approvals || [])[0] || null;
  if (snap.procurement.status === 'purchase_handoff' && latest?.status === 'APPROVED' && (latest.mode || 'REAL') === 'REAL') {
    return safeJson(res, { status: 'purchase_handoff', approval_id: latest?.approval_id ?? null, existing: true });
  }
  // REAL handoff requires a current PROCEED decision on top of a REAL APPROVED
  // approval: INSUFFICIENT_DATA / NEGOTIATE / NO_ELIGIBLE_OFFERS /
  // RESEARCH_REQUIRED can close with justification but can never hand off
  // directly. DEMO approvals are simulation only, never authorization.
  const chk = canHandoff({ caseStatus: snap.procurement.status, latestApproval: latest, latestDecision: snap.decision });
  if (!chk.ok) return safeJson(res, { error: chk.reason, demo_simulation: (latest?.mode || snap.procurement.mode) === 'DEMO' }, 409);
  const trace = crypto.randomUUID();
  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : '';
  await transitionStatus(req.params.id, 'purchase_handoff', { actor: req.user.username, reason: 'purchase handoff recorded' });
  await pool.query('INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES ($1,$2,$3,$4,$5)',
    [req.params.id, trace, req.user.username, 'purchase_handoff_recorded',
     JSON.stringify({ actor: req.user.username, approval_id: latest.approval_id, offer_id: latest.selected_offer_id, note })]);
  safeJson(res, { status: 'purchase_handoff', approval_id: latest.approval_id }, 201);
}));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('request failed:', req.method, req.path, '-', err.message);
  if (err.status && err.status >= 400 && err.status < 500) return safeJson(res, { error: err.message }, err.status);
  safeJson(res, { error: 'internal error' }, 500);
});

pool.query('SELECT 1').then(() => {
  app.listen(PORT, '127.0.0.1', () => console.log(`BuyWise web on http://localhost:${PORT}`));
}).catch((e) => {
  console.error('Postgres unreachable:', e.message);
  process.exit(1);
});
