// Unit tests for stage derivation + checklist. Synthetic snapshots only — these are
// clearly-labeled test fixtures, never production records, never inserted anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveStages, deriveChecklist } from '../lib/stages.js';

const base = () => ({
  procurement: { procurement_id: '00000000-0000-4000-8000-000000000099', requirement: 'TEST FIXTURE — NOT PRODUCTION DATA', mode: 'REAL' },
  products: [], vendors: [], offers: [], quality_evaluations: [], comparisons: [],
  decision: null, negotiations: [], demo_responses: [], reevaluations: [], approvals: [],
  approval_events: [], negotiation_events: [], audit: [], agent_executions: [],
  scoring_configs: [],
});

test('new case: only the request milestone is done, nothing fabricated', () => {
  const stages = deriveStages(base());
  assert.equal(stages.length, 9);
  for (const s of stages) {
    assert.equal(s.status, 'pending');
    assert.equal(s.source, 'none');
  }
  const cl = deriveChecklist(base(), stages);
  assert.equal(cl.completed, 1); // only "request" — the persisted procurement row itself
  assert.equal(cl.total, 11);
  assert.equal(cl.items.find((i) => i.id === 'request').done, true);
});

test('evidence without execution rows still counts (labeled evidence)', () => {
  const snap = base();
  snap.products = [{ product_id: 'p1', source_url: 'https://example.com/p1' }];
  const stages = deriveStages(snap);
  assert.equal(stages[0].status, 'completed');
  assert.equal(stages[0].source, 'evidence');
  assert.equal(stages[1].status, 'pending');
});

test('failed execution surfaces as failed with the recorded error', () => {
  const snap = base();
  snap.agent_executions = [{ agent_name: 'product_research', status: 'failed', error_message: 'boom', started_at: null, completed_at: null, latency_ms: null }];
  const stages = deriveStages(snap);
  assert.equal(stages[0].status, 'failed');
  assert.equal(stages[0].source, 'execution');
  assert.equal(stages[0].error, 'boom');
});

test('NEGOTIATE without contact blocks negotiation honestly', () => {
  const snap = base();
  snap.decision = { decision: 'NEGOTIATE', evidence_urls: [] };
  snap.comparisons = [{ rank: 1, criteria_scores: {}, criteria_used: [], criteria_missing: [], evidence_urls: [] }];
  const stages = deriveStages(snap);
  const neg = stages.find((s) => s.key === 'negotiation');
  assert.equal(neg.status, 'blocked');
  assert.ok(neg.missing.includes('verified vendor contact channel'));
  assert.ok(neg.summary.includes('nothing sent'));
});

test('reevaluation blocked without any response', () => {
  const snap = base();
  snap.negotiations = [{ mode: 'REAL', status: 'WAITING_FOR_VENDOR' }];
  const stages = deriveStages(snap);
  const r = stages.find((s) => s.key === 'reevaluation');
  assert.equal(r.status, 'blocked');
});

test('PENDING approval shows as running, decided approval as completed', () => {
  const snap = base();
  snap.approvals = [{ status: 'PENDING_APPROVAL', mode: 'DEMO' }];
  let stages = deriveStages(snap);
  assert.equal(stages.find((s) => s.key === 'approval').status, 'running');
  snap.approvals = [{ status: 'APPROVED', approved_by: 'Tester', mode: 'DEMO' }];
  stages = deriveStages(snap);
  assert.equal(stages.find((s) => s.key === 'approval').status, 'completed');
});

test('checklist counts only persisted milestones', () => {
  const snap = base();
  snap.products = [{ product_id: 'p1' }];
  snap.audit = [{ event: 'x' }];
  const stages = deriveStages(snap);
  const cl = deriveChecklist(snap, stages);
  assert.equal(cl.items.find((i) => i.id === 'request').done, true);
  assert.equal(cl.items.find((i) => i.id === 'products').done, true);
  assert.equal(cl.items.find((i) => i.id === 'approve').done, false);
});

test('unscored comparisons claim no ranking and no computed scores', () => {
  const snap = base();
  snap.comparisons = [
    { product_id: 'p1', rank: 1, overall_score: null, criteria_used: [], criteria_missing: [] },
    { product_id: 'p2', rank: 2, overall_score: null, criteria_used: [], criteria_missing: [] },
  ];
  snap.scoring_configs = [{ weights: {}, rules_version: '1.0.0' }];
  const stages = deriveStages(snap);
  const cmp = stages.find((s) => s.key === 'comparison');
  assert.ok(!cmp.summary.includes('top rank set'), 'must not claim a top rank without scores: ' + cmp.summary);
  assert.ok(cmp.summary.includes('no score-based ranking'), 'must state the ranking gap: ' + cmp.summary);
  assert.ok(cmp.summary.includes('0 with calculable score'), 'counts must come from persisted rows: ' + cmp.summary);
  const sco = stages.find((s) => s.key === 'scoring');
  assert.ok(sco.summary.includes('no calculable scores'), 'must not claim computed scores: ' + sco.summary);
  assert.ok(!sco.summary.includes('configured weights'), 'empty weights are not a configuration: ' + sco.summary);
});

test('scored comparisons keep the top-rank claim with counts', () => {
  const snap = base();
  snap.comparisons = [
    { product_id: 'p1', rank: 1, overall_score: 0.8, criteria_used: ['a'], criteria_missing: ['b'] },
    { product_id: 'p2', rank: 2, overall_score: null, criteria_used: [], criteria_missing: [] },
  ];
  snap.scoring_configs = [{ weights: { a: 1 }, rules_version: '1.0.0' }];
  const stages = deriveStages(snap);
  assert.ok(stages.find((s) => s.key === 'comparison').summary.includes('top rank set'));
  assert.ok(stages.find((s) => s.key === 'scoring').summary.includes('Scores computed for 1 of 2'));
});

test('vendor stage says source offer records, never verified offers', () => {
  const snap = base();
  snap.vendors = [{ vendor_id: 'v1' }];
  snap.offers = [{ offer_id: 'o1' }];
  const stages = deriveStages(snap);
  const v = stages.find((s) => s.key === 'vendor_research');
  assert.ok(v.summary.includes('source offer record(s)'), v.summary);
  assert.ok(!v.summary.includes('verified offer'), v.summary);
});

test('DEMO approval is labeled simulation with its target offer', () => {
  const snap = base();
  snap.approvals = [{ status: 'APPROVED', approved_by: 'Tester', mode: 'DEMO', selected_offer_id: 'o-1' }];
  const stages = deriveStages(snap);
  const a = stages.find((s) => s.key === 'approval');
  assert.ok(a.summary.includes('DEMO'), a.summary);
  assert.ok(a.summary.includes('not a real purchase authorization'), a.summary);
  assert.ok(a.summary.includes('o-1'), 'must state what was approved: ' + a.summary);
});

test('DEMO re-evaluation labels hypothetical unit vs quantity total', () => {
  const snap = base();
  snap.procurement.quantity = 8;
  snap.reevaluations = [{ mode: 'DEMO', absolute_savings: '1207.00', currency: 'INR', evidence_urls: [] }];
  const stages = deriveStages(snap);
  const r = stages.find((s) => s.key === 'reevaluation');
  assert.ok(r.summary.includes('hypothetical demo input'), r.summary);
  assert.ok(r.summary.includes('unit savings 1207'), r.summary);
  assert.ok(r.summary.includes('9656') && r.summary.includes('quantity 8'), 'total must derive from persisted quantity: ' + r.summary);
});
