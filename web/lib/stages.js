// BuyWise stage derivation: 9 functional stages computed ONLY from persisted
// backend state (tables + agent_executions). Never invents progress.
// Each stage: { key, name, responsibility, status, source, started_at,
// completed_at, latency_ms, summary, evidence_urls, error, missing }.
// status: pending | running | completed | failed | blocked
// source: 'execution' (an agent_executions row exists) | 'evidence' (output rows
//   exist but no execution row was recorded) | 'none'.

const STAGES = [
  { key: 'product_research', name: 'Product Research Agent', agent: 'product_research',
    responsibility: 'Finds relevant products from real sources (SerpAPI + Tavily).' },
  { key: 'vendor_research', name: 'Vendor Research Agent', agent: 'vendor_research',
    responsibility: 'Identifies real merchants and commercial offers.' },
  { key: 'review_quality', name: 'Review & Quality Agent', agent: 'review_quality',
    responsibility: 'Examines review/quality evidence, validates info, flags missing data.' },
  { key: 'comparison', name: 'Comparison Agent', agent: 'comparison',
    responsibility: 'Normalizes and compares the available offers.' },
  { key: 'scoring', name: 'Deterministic Scoring Engine', agent: null,
    responsibility: 'Reproducible scores from configured weights and available evidence. Code, not an LLM.' },
  { key: 'decision', name: 'Decision Agent', agent: 'decision',
    responsibility: 'Recommends PROCEED, NEGOTIATE, NO_ELIGIBLE_OFFERS, RESEARCH_REQUIRED, or INSUFFICIENT_DATA with reasons.' },
  { key: 'negotiation', name: 'Negotiation Agent', agent: 'negotiation',
    responsibility: 'Drafts a negotiation proposal from a real offer. Never sends it.' },
  { key: 'reevaluation', name: 'Re-evaluation Agent', agent: 'reevaluation',
    responsibility: 'Re-scores a real or demo revised offer with the same engine.' },
  { key: 'approval', name: 'Approval Agent', agent: 'approval',
    responsibility: 'Prepares the approval package and waits for an explicit human decision.' },
];

function latestExec(execs, agent) {
  const rows = (execs || []).filter((e) => e.agent_name === agent);
  if (!rows.length) return null;
  rows.sort((a, b) => new Date(b.started_at || 0) - new Date(a.started_at || 0));
  return rows[0];
}

function fromExec(exec) {
  if (!exec) return null;
  const status = exec.status === 'succeeded' ? 'completed'
    : exec.status === 'failed' ? 'failed'
    : exec.status === 'started' ? 'running' : 'pending';
  return { status, source: 'execution', started_at: exec.started_at || null,
    completed_at: exec.completed_at || null, latency_ms: exec.latency_ms ?? null,
    error: exec.error_message || null };
}

export function deriveStages(snap) {
  const execs = snap.agent_executions || [];
  const has = (arr) => Array.isArray(arr) && arr.length > 0;
  const urlsOf = (rows, n = 3) => (rows || []).flatMap((r) => r.source_url ? [r.source_url] : []).slice(0, n);
  const out = [];

  // 1. product research
  {
    const e = fromExec(latestExec(execs, 'product_research'));
    const n = (snap.products || []).length;
    out.push({ ...STAGES[0],
      ...(e || (n > 0
        ? { status: 'completed', source: 'evidence', started_at: null, completed_at: null, latency_ms: null, error: null }
        : { status: 'pending', source: 'none', started_at: null, completed_at: null, latency_ms: null, error: null })),
      summary: n > 0 ? `${n} real product(s) discovered` : 'No products discovered yet',
      evidence_urls: urlsOf(snap.products), missing: n > 0 ? [] : ['products'] });
  }
  // 2. vendor research (offer rows are provider-discovered source records;
  // "verified" is reserved for independently confirmed quotations, which these
  // rows alone do not substantiate)
  {
    const e = fromExec(latestExec(execs, 'vendor_research'));
    const nv = (snap.vendors || []).length, no = (snap.offers || []).length;
    out.push({ ...STAGES[1],
      ...(e || ((nv > 0 || no > 0)
        ? { status: 'completed', source: 'evidence', started_at: null, completed_at: null, latency_ms: null, error: null }
        : { status: 'pending', source: 'none', started_at: null, completed_at: null, latency_ms: null, error: null })),
      summary: (nv > 0 || no > 0) ? `${nv} merchant(s), ${no} source offer record(s)` : 'No merchants/offers yet',
      evidence_urls: urlsOf(snap.offers), missing: no > 0 ? [] : ['source offer records'] });
  }
  // 3. review & quality
  {
    const e = fromExec(latestExec(execs, 'review_quality'));
    const nq = (snap.quality_evaluations || []).length;
    const unrated = (snap.quality_evaluations || []).filter((q) => q.review_rating == null).length;
    out.push({ ...STAGES[2],
      ...(e || (nq > 0
        ? { status: 'completed', source: 'evidence', started_at: null, completed_at: null, latency_ms: null, error: null }
        : { status: 'pending', source: 'none', started_at: null, completed_at: null, latency_ms: null, error: null })),
      summary: nq > 0 ? `${nq} quality evaluation(s); ${unrated} without review ratings` : 'No quality evaluations yet',
      evidence_urls: urlsOf(snap.quality_evaluations), missing: nq > 0 ? (unrated > 0 ? ['review ratings for some products'] : []) : ['quality evaluations'] });
  }
  // 4+5. comparison + scoring (engine output = comparisons rows). Counts come
  // from the same persisted rows the Comparison page reads: only a numeric
  // overall_score counts as scored, and "ranked"/"top rank" is claimed only
  // when a score-based ranking actually exists.
  {
    const e = fromExec(latestExec(execs, 'comparison'));
    const nc = (snap.comparisons || []).length;
    const base = e || (nc > 0
      ? { status: 'completed', source: 'evidence', started_at: null, completed_at: null, latency_ms: null, error: null }
      : { status: 'pending', source: 'none', started_at: null, completed_at: null, latency_ms: null, error: null });
    const comps = snap.comparisons || [];
    const scoredCount = comps.filter((c) => typeof c.overall_score === 'number' && isFinite(c.overall_score)).length;
    const ranked = scoredCount > 0 ? comps.filter((c) => c.rank === 1)[0] : null;
    out.push({ ...STAGES[3], ...base,
      summary: nc > 0 ? `${nc} candidate(s) processed, ${scoredCount} with calculable score(s)${ranked ? '; top rank set' : '; no score-based ranking'}` : 'No comparison yet',
      evidence_urls: (ranked?.evidence_urls || []).slice(0, 3), missing: nc > 0 ? (scoredCount > 0 ? [] : ['calculable scores']) : ['comparison'] });
    const weights = snap.scoring_configs?.[0]?.weights || snap.scoring_configs?.weights || null;
    const configured = weights && typeof weights === 'object' && Object.keys(weights).length > 0;
    out.push({ ...STAGES[4], ...base,
      summary: nc > 0
        ? (scoredCount > 0
          ? `Scores computed for ${scoredCount} of ${nc} candidate(s)${configured ? ' with configured weights' : ' (default weights; no saved config)'}`
          : `${nc} candidate(s) processed — no calculable scores (missing evidence is excluded, never zero-filled)`)
        : 'No scores computed yet',
      evidence_urls: [], missing: nc > 0 ? (scoredCount > 0 ? [] : ['calculable scores']) : ['scores'] });
  }
  // 6. decision
  {
    const e = fromExec(latestExec(execs, 'decision'));
    const d = snap.decision || null;
    out.push({ ...STAGES[5],
      ...(e || (d
        ? { status: 'completed', source: 'evidence', started_at: null, completed_at: null, latency_ms: null, error: null }
        : { status: 'pending', source: 'none', started_at: null, completed_at: null, latency_ms: null, error: null })),
      summary: d ? `Decision: ${d.decision}` : 'No decision yet',
      evidence_urls: d?.evidence_urls || [], missing: d ? [] : ['decision'] });
  }
  // 7. negotiation
  {
    const e = fromExec(latestExec(execs, 'negotiation'));
    const negos = snap.negotiations || [];
    const real = negos.filter((n) => n.mode !== 'DEMO');
    const demo = negos.filter((n) => n.mode === 'DEMO');
    let st, summary, missing = [];
    if (e && e.status !== 'pending') { st = e; }
    else if (real.length > 0 || demo.length > 0) {
      st = { status: 'completed', source: 'evidence', started_at: null, completed_at: null, latency_ms: null, error: null };
    } else if (snap.decision?.decision === 'NEGOTIATE') {
      st = { status: 'blocked', source: 'none', started_at: null, completed_at: null, latency_ms: null, error: null };
      missing = ['verified vendor contact channel'];
      summary = 'Decision is NEGOTIATE but no verified contact channel exists — nothing sent (correct)';
    } else {
      st = { status: 'pending', source: 'none', started_at: null, completed_at: null, latency_ms: null, error: null };
    }
    out.push({ ...STAGES[6], ...st,
      summary: summary ?? (`${real.length} real + ${demo.length} demo negotiation(s)` +
        (demo.length > 0 ? ' — demo proposal(s) are local simulations (nothing sent to any vendor)' : '')),
      evidence_urls: [], missing });
  }
  // 8. re-evaluation
  {
    const e = fromExec(latestExec(execs, 'reevaluation'));
    const re = snap.reevaluations || [];
    const demoResp = (snap.demo_responses || []).length > 0;
    let st, summary, missing = [];
    if (e && e.status !== 'pending') { st = e; }
    else if (re.length > 0) {
      st = { status: 'completed', source: 'evidence', started_at: null, completed_at: null, latency_ms: null, error: null };
    } else if ((snap.negotiations || []).length > 0 && !demoResp) {
      st = { status: 'blocked', source: 'none', started_at: null, completed_at: null, latency_ms: null, error: null };
      missing = ['verified vendor response'];
      summary = 'Waiting for a real vendor response — nothing fabricated';
    } else {
      st = { status: 'pending', source: 'none', started_at: null, completed_at: null, latency_ms: null, error: null };
    }
    const last = re[re.length - 1];
    // Unit vs total savings use the persisted request quantity only — never
    // inferred. DEMO revisions stay labeled hypothetical, never vendor-confirmed.
    const toNum = (v) => (typeof v === 'number' && isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)) ? Number(v) : null));
    const qty = Number.isInteger(snap.procurement?.quantity) && snap.procurement.quantity > 0 ? snap.procurement.quantity : null;
    const unitSav = toNum(last?.absolute_savings);
    const totalPart = (unitSav !== null && qty !== null)
      ? ` (≈ ${Math.round(unitSav * qty * 100) / 100} ${last?.currency || ''} total for quantity ${qty}, partial estimate)` : '';
    const demoTag = (last?.mode || 'REAL') === 'DEMO' ? ' — hypothetical demo input, not a vendor-confirmed quotation' : '';
    out.push({ ...STAGES[7], ...st,
      summary: summary ?? (re.length > 0
        ? `Re-scored (${last?.mode || 'REAL'}${demoTag}): unit savings ${last?.absolute_savings ?? 'unavailable'} ${last?.currency || ''}${totalPart}`
        : 'No re-evaluation yet'),
      evidence_urls: last?.evidence_urls || [], missing });
  }
  // 9. approval
  {
    const e = fromExec(latestExec(execs, 'approval'));
    const a = (snap.approvals || [])[0] || null;
    let st, summary;
    if (e && e.status !== 'pending') { st = e; }
    else if (a) {
      st = { status: a.status === 'PENDING_APPROVAL' ? 'running' : 'completed', source: 'evidence', started_at: null, completed_at: null, latency_ms: null, error: null };
    } else {
      st = { status: 'pending', source: 'none', started_at: null, completed_at: null, latency_ms: null, error: null };
    }
    out.push({ ...STAGES[8], ...st,
      summary: summary ?? (a ? `Approval ${a.status}${a.approved_by ? ' by ' + a.approved_by : ''} (${a.mode || 'REAL'}${(a.mode || 'REAL') === 'DEMO' ? ' simulation — not a real purchase authorization' : ''})${a.selected_offer_id ? ` — package on offer ${a.selected_offer_id}` : ' — approval target not recorded'}` : 'No approval package yet'),
      evidence_urls: [], missing: a ? [] : ['human decision'] });
  }
  return out;
}

// Guided demo checklist derived from the same persisted state (milestones, not agents).
export function deriveChecklist(snap, stages) {
  const st = Object.fromEntries((stages || []).map((s) => [s.key, s]));
  const done = (k) => st[k]?.status === 'completed';
  const items = [
    { id: 'request', label: 'Create procurement request', done: !!snap.procurement, detail: snap.procurement ? snap.procurement.requirement?.slice(0, 80) : 'Not created' },
    { id: 'products', label: 'Discover real products', done: done('product_research'), detail: `${(snap.products || []).length} product(s)` },
    { id: 'vendors', label: 'Discover real vendors and prices', done: done('vendor_research'), detail: `${(snap.vendors || []).length} vendor(s), ${(snap.offers || []).length} source offer record(s)` },
    { id: 'evidence', label: 'Review evidence and mandatory specifications', done: done('review_quality'), detail: `${(snap.quality_evaluations || []).length} evaluation(s)` },
    { id: 'compare', label: 'Compare offers and inspect scoring', done: done('comparison'), detail: `${(snap.comparisons || []).length} compared · ${(snap.comparisons || []).filter((c) => typeof c.overall_score === 'number' && isFinite(c.overall_score)).length} scored` },
    { id: 'decision', label: 'Inspect the decision', done: done('decision'), detail: snap.decision ? snap.decision.decision : 'No decision' },
    { id: 'negotiate', label: 'Generate a local negotiation proposal', done: (snap.negotiations || []).length > 0, detail: (snap.negotiations || []).length > 0 ? `${snap.negotiations.length} proposal(s), nothing sent` : 'No proposal yet' },
    { id: 'respond', label: 'Enter a demo response', done: (snap.demo_responses || []).length > 0, detail: (snap.demo_responses || []).length > 0 ? 'Entered locally as DEMO_HUMAN_ENTERED' : 'Not entered' },
    { id: 'reeval', label: 'Re-evaluate the offer', done: done('reevaluation'), detail: (snap.reevaluations || []).length > 0 ? 'Re-scored' : 'Not re-evaluated' },
    { id: 'approve', label: 'Review and record human approval', done: ['APPROVED', 'REJECTED', 'CHANGES_REQUESTED'].includes((snap.approvals || [])[0]?.status), detail: (snap.approvals || [])[0]?.status || 'No decision recorded' },
    { id: 'audit', label: 'Inspect the audit trail', done: (snap.audit || []).length > 0, detail: `${(snap.audit || []).length} audit event(s)` },
  ];
  return { items, completed: items.filter((i) => i.done).length, total: items.length };
}
