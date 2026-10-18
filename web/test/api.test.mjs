// Live API tests against the running server + real DB.
// Authenticated as requester (t_api_req, sees only own cases) and officer
// (t_api_off, sees all) to verify read isolation alongside contracts.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ensureUser, dropUser, closePool, login, call, BASE } from './helpers.mjs';

let S = null;
let O = null;
before(async () => {
  await ensureUser('t_api_req', 'apireq-pass-11', 'requester');
  await ensureUser('t_api_off', 'apireq-pass-22', 'officer');
  S = await login('t_api_req', 'apireq-pass-11');
  O = await login('t_api_off', 'apireq-pass-22');
});
after(async () => { await dropUser('t_api_req').catch(() => {}); await dropUser('t_api_off').catch(() => {}); await closePool(); });

async function get(path, expect = 200) {
  const r = await fetch(BASE + path, { headers: S?.cookie ? { cookie: S.cookie } : {} });
  assert.equal(r.status, expect, `${path} -> ${r.status}`);
  return r.json();
}
async function oget(path, expect = 200) {
  const r = await fetch(BASE + path, { headers: O?.cookie ? { cookie: O.cookie } : {} });
  assert.equal(r.status, expect, `officer ${path} -> ${r.status}`);
  return r.json();
}

test('health reports ok + db', async () => {
  const h = await get('/api/health');
  assert.equal(h.ok, true);
  assert.equal(h.db, true);
});

test('dashboard metrics are real numbers', async () => {
  const d = await get('/api/dashboard');
  for (const k of ['cases', 'active', 'completed', 'awaiting_approval']) {
    assert.ok(Number.isInteger(d.totals[k]), k);
  }
  assert.ok(Array.isArray(d.recent_runs));
  assert.ok(Array.isArray(d.recent_executions));
  assert.ok(Array.isArray(d.recent_decisions));
});

test('providers expose presence only, never values', async () => {
  const p = await get('/api/providers');
  assert.equal(typeof p.tavily.configured, 'boolean');
  assert.equal(typeof p.serpapi.configured, 'boolean');
  assert.equal(typeof p.n8n.reachable, 'boolean');
  const s = JSON.stringify(p);
  assert.ok(!/tvly-[A-Za-z0-9_-]{8,}/.test(s));
  assert.ok(!/re_[A-Za-z0-9]{16,}/.test(s));
});

test('invalid and unknown case ids are rejected cleanly', async () => {
  await get('/api/cases/not-a-uuid', 400);
  await get('/api/cases/00000000-0000-4000-8000-000000000000', 404);
  await get('/api/cases/00000000-0000-4000-8000-000000000000/stages', 404);
  await get('/api/cases/00000000-0000-4000-8000-000000000000/trace', 404);
});

test('intake validation rejects bad input without side effects', async () => {
  for (const body of [
    {},
    { requirement: 'abc', currency: 'INR' },
    { requirement: 'valid requirement text here', currency: 'usd' },
    { requirement: 'valid requirement text here', currency: 'INR', mode: 'DEMO' },
  ]) {
    const r = await fetch(BASE + '/api/procurements', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: S.cookie, 'x-csrf-token': S.csrf },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test('requesters see only their own cases; officers see all', async () => {
  const mine = await get('/api/cases');
  assert.equal(mine.cases.length, 0, 'requester with no cases must see none');
  const all = await oget('/api/cases');
  assert.ok(all.cases.length > 0, 'officer must see team cases');
  const otherId = all.cases[0].procurement_id;
  await get(`/api/cases/${otherId}`, 404);
  await get(`/api/cases/${otherId}/stages`, 404);
  await get(`/api/cases/${otherId}/trace`, 404);
  const seen = await oget(`/api/cases/${otherId}`);
  assert.ok(seen.procurement, 'officer must see the case');
});

test('stages endpoint returns nine derived stages on a real case', async () => {
  const dash = await oget('/api/dashboard');
  assert.ok(dash.recent_runs.length > 0, 'needs at least one real case');
  const id = dash.recent_runs[0].procurement_id;
  const st = await oget(`/api/cases/${id}/stages`);
  assert.equal(st.stages.length, 9);
  assert.ok(['REAL', 'DEMO'].includes(st.mode));
  for (const s of st.stages) {
    assert.ok(['pending', 'running', 'completed', 'failed', 'blocked'].includes(s.status), s.key);
    assert.ok(['execution', 'evidence', 'none'].includes(s.source), s.key);
    assert.ok(typeof s.responsibility === 'string' && s.responsibility.length > 0);
  }
  assert.equal(st.checklist.total, 11);
});

test('trace endpoint exposes persisted coordination messages without secrets', async () => {
  const { cases } = await oget('/api/cases');
  assert.ok(cases.length > 0, 'needs at least one case');
  let trace = null;
  for (const c of cases.slice(0, 12)) {
    const r = await fetch(BASE + `/api/cases/${c.procurement_id}/trace`, { headers: { cookie: O.cookie } });
    assert.equal(r.status, 200, 'trace on a real case must be 200 (pending flag when empty)');
    const t = await r.json();
    assert.ok(Array.isArray(t.messages) && Array.isArray(t.executions), 'trace shape');
    if ((t.messages || []).length > 0) { trace = t; break; }
  }
  assert.ok(trace && trace.messages.length > 0, 'needs at least one traced case');
  let last = '';
  for (const m of trace.messages) {
    assert.ok(m.message_id && m.sender_agent && m.recipient_agent && m.message_type && m.objective);
    assert.ok(m.sender_agent !== m.recipient_agent, 'self-send persisted');
    assert.ok(m.created_at >= last, 'messages must be chronological');
    last = m.created_at;
    if (['revision_request', 'decision', 'escalation'].includes(m.message_type)) {
      assert.ok(m.reason && m.reason.length > 0, `${m.message_type} without reason`);
    }
  }
  const types = new Set(trace.messages.map((m) => m.message_type));
  assert.ok(types.has('task_assignment') && types.has('evidence_report'), 'must show task/evidence handoffs');
  const s = JSON.stringify(trace);
  assert.ok(!/tvly-[A-Za-z0-9_-]{8,}/.test(s) && !/sk-(live|ant)-[A-Za-z0-9]+/.test(s), 'secret leaked in trace');
});
