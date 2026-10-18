// Fast-track remaining deterministic stages for a webhook-created case whose n8n
// orchestrator stopped after vendor research. Runs the CANONICAL libs (same code
// as the 40/50/65 n8n Code nodes): Review&Quality (deterministic tiers +
// completeness only; NO Tavily per-product searches, reviews stay unavailable),
// Comparison+Scoring (engine), Decision (gates). Writes the same rows + state
// transitions the harnesses (phase2a/phase2b) write. No mocks: missing stays missing.
// Run: $env:PROC_ID="<uuid>"; node tests/fast_track_case.mjs
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { classifySource } from "../tools/_lib/source_quality.js";
import { specCompleteness } from "../tools/_lib/evidence.js";
import { score, rankRows, DEFAULT_WEIGHTS } from "../tools/_lib/scoring.js";
import { decide } from "../tools/_lib/decision.js";

for (const line of readFileSync("D:\\flexi\\.env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && m[2]) process.env[m[1]] ??= m[2];
}
const PROC_ID = process.env.PROC_ID;
if (!PROC_ID) throw new Error("set PROC_ID env var");
const sha = (o) => createHash("sha256").update(JSON.stringify(o)).digest("hex");
const sqlLit = (v) => (v === null || v === undefined ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'");
const sqlJson = (o) => sqlLit(JSON.stringify(o));
function psqlJson(sql) {
  const out = execFileSync("docker", ["exec", "-i", "buywise-postgres", "psql", "-U", "buywise", "-d", "buywise", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A", "-c", `SELECT coalesce(json_agg(t),'[]') FROM (${sql}) t`], { encoding: "utf8" });
  return JSON.parse(out.trim());
}
function psql(sql) { execFileSync("docker", ["exec", "-i", "buywise-postgres", "psql", "-U", "buywise", "-d", "buywise", "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], { encoding: "utf8" }); }

const trace_id = randomUUID();
const SPEC_FIELDS = ["processor", "ram", "storage", "operating_system", "display", "battery", "graphics"];

const caseRows = psqlJson(`SELECT budget::text AS budget, currency, quantity, mandatory_specs, status FROM procurement_cases WHERE procurement_id=${sqlLit(PROC_ID)}`);
if (!caseRows.length) throw new Error("procurement not found: " + PROC_ID);
const c = caseRows[0];
const products = psqlJson(`SELECT product_id, name, specifications, source, source_url, retrieved_at, data_status, confidence::text AS confidence FROM products WHERE procurement_id=${sqlLit(PROC_ID)} ORDER BY product_id`).map((p) => ({ ...p, specifications: typeof p.specifications === "string" ? JSON.parse(p.specifications) : (p.specifications ?? {}), confidence: Number(p.confidence) }));
if (!products.length) throw new Error("no products to evaluate");
console.log(JSON.stringify({ procurement_id: PROC_ID, case_status: c.status, products: products.length }));
psql(`UPDATE procurement_cases SET status='vendor_done' WHERE procurement_id=${sqlLit(PROC_ID)}`);

// scoring config + review_quality execution row
psql(`INSERT INTO scoring_configs (procurement_id,weights,spec_fields,notes) VALUES (${sqlLit(PROC_ID)},${sqlJson(DEFAULT_WEIGHTS)},${sqlJson(SPEC_FIELDS)},'Fast-track defaults (same as Phase 2A); no Tavily review searches, reviews unavailable') ON CONFLICT (procurement_id) DO UPDATE SET weights=EXCLUDED.weights,spec_fields=EXCLUDED.spec_fields,notes=EXCLUDED.notes`);
const t0 = Date.now();
psql(`INSERT INTO agent_executions (procurement_id,trace_id,agent_name,status,input_hash) VALUES (${sqlLit(PROC_ID)},${sqlLit(trace_id)},'review_quality','started',${sqlLit(sha({ products: products.length }))})`);

// deterministic quality only (no provider calls)
const evals = products.map((p) => {
  const sq = classifySource(p.source_url);
  const sc = specCompleteness(p.specifications, SPEC_FIELDS);
  return {
    procurement_id: PROC_ID, product_id: p.product_id,
    source_quality: sq.tier, source_quality_score: sq.score,
    specification_completeness: sc.completeness, spec_fields_total: sc.total, spec_fields_verified: sc.verified,
    review_rating: "unavailable", review_scale: null, review_count: "unavailable",
    review_evidence: "not assessed — no verified review data; left unavailable",
    quality_evidence: [{ kind: "source_classification", tier: sq.tier, label: sq.label }, { kind: "spec_completeness", verified: sc.verified, total: sc.total }],
    quality_confidence: sq.score >= 0.8 ? 0.8 : sq.score,
    source_urls: [p.source_url],
    retrieved_at: new Date().toISOString(), data_status: "PARTIAL",
  };
});
for (const e of evals) {
  psql(`INSERT INTO quality_evaluations (procurement_id,product_id,source_quality,source_quality_score,specification_completeness,spec_fields_total,spec_fields_verified,review_rating,review_scale,review_count,review_evidence,quality_evidence,quality_confidence,source_urls,retrieved_at,data_status) VALUES (${sqlLit(e.procurement_id)},${sqlLit(e.product_id)},${sqlLit(e.source_quality)},${e.source_quality_score},${e.specification_completeness},${e.spec_fields_total},${e.spec_fields_verified},NULL,NULL,NULL,${sqlLit(e.review_evidence)},${sqlJson(e.quality_evidence)},${e.quality_confidence},${sqlJson(e.source_urls)},${sqlLit(e.retrieved_at)},'PARTIAL') ON CONFLICT (procurement_id,product_id) DO UPDATE SET source_quality=EXCLUDED.source_quality,source_quality_score=EXCLUDED.source_quality_score,specification_completeness=EXCLUDED.specification_completeness,review_rating=EXCLUDED.review_rating,review_scale=EXCLUDED.review_scale,review_count=EXCLUDED.review_count,review_evidence=EXCLUDED.review_evidence,quality_evidence=EXCLUDED.quality_evidence,quality_confidence=EXCLUDED.quality_confidence,source_urls=EXCLUDED.source_urls,retrieved_at=EXCLUDED.retrieved_at`);
}
psql(`UPDATE agent_executions SET status='succeeded',output_hash=${sqlLit(sha(evals))},completed_at=now(),latency_ms=${Date.now() - t0} WHERE trace_id=${sqlLit(trace_id)} AND agent_name='review_quality'`);
psql(`UPDATE procurement_cases SET status='quality_done' WHERE procurement_id=${sqlLit(PROC_ID)}`);
psql(`INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES (${sqlLit(PROC_ID)},${sqlLit(trace_id)},'review_quality','quality_evaluations_persisted',${sqlJson({ evaluated: evals.length, with_rating: 0, with_count: 0, note: "deterministic only; review searches skipped, reviews unavailable" })})`);
console.log(JSON.stringify({ evaluated: evals.length }));

// comparison (same components as phase2a: no offers -> price/vendor/etc excluded)
const t1 = Date.now();
psql(`INSERT INTO agent_executions (procurement_id,trace_id,agent_name,status,input_hash) VALUES (${sqlLit(PROC_ID)},${sqlLit(trace_id)},'comparison','started',${sqlLit(sha({ evals: evals.length }))})`);
const byId = Object.fromEntries(evals.map((e) => [e.product_id, e]));
const rows = products.map((p) => {
  const ev = byId[p.product_id];
  const components = {
    price: null, quality: null, reviews: null, delivery: null, warranty: null,
    vendor_reliability: null, payment_terms: null, budget_compliance: null,
    source_quality: ev.source_quality_score, specification_completeness: ev.specification_completeness,
  };
  const s = score(components, DEFAULT_WEIGHTS);
  const strengths = [], limitations = [];
  if (ev.source_quality === "HIGH") strengths.push(`High-quality evidence source (${p.source_url})`);
  else limitations.push(`Source quality is ${ev.source_quality} — candidate, not a verified product`);
  if (ev.spec_fields_verified > 0) strengths.push(`${ev.spec_fields_verified}/${ev.spec_fields_total} defined specifications verified`);
  else limitations.push("No defined specifications verifiable from source");
  limitations.push("Review data unavailable");
  limitations.push("Price comparison unavailable");
  return { product_id: p.product_id, overall_score: s.overall_score, criteria_scores: s.breakdown, criteria_used: s.criteria_used, criteria_missing: s.criteria_missing, effective_weight_total: s.effective_weight_total, budget_compliance: "unavailable", source_quality: ev.source_quality_score, specification_completeness: ev.specification_completeness, strengths, limitations, evidence_urls: ev.source_urls, confidence: p.confidence };
});
const ranked = rankRows(rows);
for (const r of ranked) {
  psql(`INSERT INTO comparisons (procurement_id,product_id,rank,overall_score,criteria_scores,criteria_used,criteria_missing,effective_weight_total,budget_compliance,source_quality,specification_completeness,strengths,limitations,evidence_urls) VALUES (${sqlLit(PROC_ID)},${sqlLit(r.product_id)},${r.rank},${typeof r.overall_score === "number" ? r.overall_score : "NULL"},${sqlJson(r.criteria_scores)},${sqlJson(r.criteria_used)},${sqlJson(r.criteria_missing)},${r.effective_weight_total},'unavailable',${r.source_quality},${r.specification_completeness},${sqlJson(r.strengths)},${sqlJson(r.limitations)},${sqlJson(r.evidence_urls)}) ON CONFLICT (procurement_id,product_id) DO UPDATE SET rank=EXCLUDED.rank,overall_score=EXCLUDED.overall_score,criteria_scores=EXCLUDED.criteria_scores,criteria_used=EXCLUDED.criteria_used,criteria_missing=EXCLUDED.criteria_missing,effective_weight_total=EXCLUDED.effective_weight_total,strengths=EXCLUDED.strengths,limitations=EXCLUDED.limitations,evidence_urls=EXCLUDED.evidence_urls`);
}
psql(`UPDATE procurement_cases SET status='compared' WHERE procurement_id=${sqlLit(PROC_ID)}`);
psql(`UPDATE agent_executions SET status='succeeded',output_hash=${sqlLit(sha(ranked.map((r) => [r.product_id, r.rank, r.overall_score])))},completed_at=now(),latency_ms=${Date.now() - t1} WHERE trace_id=${sqlLit(trace_id)} AND agent_name='comparison'`);
psql(`INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES (${sqlLit(PROC_ID)},${sqlLit(trace_id)},'comparison','comparisons_persisted',${sqlJson({ ranked: ranked.length, criteria_note: "price/vendor/delivery/warranty/budget/reviews excluded (no verified data); rank from source_quality + specification_completeness" })})`);
console.log(JSON.stringify({ ranked: ranked.length }));

// decision (same gates as phase2b / 65-agent-decision)
const mandatory = {};
const mspecs = typeof c.mandatory_specs === "string" ? JSON.parse(c.mandatory_specs || "{}") : (c.mandatory_specs || {});
for (const [k, v] of Object.entries(mspecs)) {
  const s = String(k);
  if (s.endsWith("_min")) mandatory[s.slice(0, -4)] = { min: v };
  else if (s.endsWith("_max")) mandatory[s.slice(0, -4)] = { ...(mandatory[s.slice(0, -4)] || {}), max: v };
  else mandatory[s] = { equals: v };
}
const procurement = { procurement_id: PROC_ID, budget: c.budget ? Number(c.budget) : null, currency: c.currency, quantity: c.quantity };
const offers = psqlJson(`SELECT offer_id, product_id, vendor_id, net_price::text AS net_price, currency FROM offers WHERE procurement_id=${sqlLit(PROC_ID)}`).map((o) => ({ ...o, net_price: o.net_price === null ? null : Number(o.net_price) }));
const vendors = psqlJson(`SELECT vendor_id, vendor_name, source_url FROM vendors WHERE procurement_id=${sqlLit(PROC_ID)}`);
const t2 = Date.now();
psql(`INSERT INTO agent_executions (procurement_id,trace_id,agent_name,status,input_hash) VALUES (${sqlLit(PROC_ID)},${sqlLit(trace_id)},'decision','started',${sqlLit(sha({ ranked: ranked.length }))})`);
const d = decide({
  procurement,
  ranked: ranked.map((r) => ({ ...r, comparison_id: r.comparison_id })),
  offersByProduct: Object.fromEntries(products.map((p) => [p.product_id, offers.filter((o) => o.product_id === p.product_id)])),
  vendorsById: Object.fromEntries(vendors.map((v) => [v.vendor_id, { ...v, contact_channel: null }])),
  productsById: Object.fromEntries(products.map((p) => [p.product_id, { ...p, specifications: typeof p.specifications === "string" ? JSON.parse(p.specifications) : p.specifications }])),
  mandatory,
});
psql(`INSERT INTO decisions (procurement_id,product_id,comparison_id,decision,decision_reason,blocking_reasons,criteria_used,criteria_missing,evidence_urls) VALUES (${sqlLit(PROC_ID)},${sqlLit(d.product_id)},${sqlLit(d.comparison_id)},${sqlLit(d.decision)},${sqlLit(d.decision_reason)},${sqlJson(d.blocking_reasons)},${sqlJson(d.criteria_used)},${sqlJson(d.criteria_missing)},${sqlJson(d.evidence_urls)}) ON CONFLICT (procurement_id) DO UPDATE SET product_id=EXCLUDED.product_id,comparison_id=EXCLUDED.comparison_id,decision=EXCLUDED.decision,decision_reason=EXCLUDED.decision_reason,blocking_reasons=EXCLUDED.blocking_reasons,criteria_used=EXCLUDED.criteria_used,criteria_missing=EXCLUDED.criteria_missing,evidence_urls=EXCLUDED.evidence_urls`);
psql(`UPDATE agent_executions SET status='succeeded',output_hash=${sqlLit(sha(d))},completed_at=now(),latency_ms=${Date.now() - t2} WHERE trace_id=${sqlLit(trace_id)} AND agent_name='decision'`);
psql(`UPDATE procurement_cases SET status='decided' WHERE procurement_id=${sqlLit(PROC_ID)}`);
psql(`INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES (${sqlLit(PROC_ID)},${sqlLit(trace_id)},'decision','decision_persisted',${sqlJson({ decision: d.decision, product_id: d.product_id, blocking: d.blocking_reasons })})`);
if (d.decision !== "NEGOTIATE") {
  psql(`INSERT INTO negotiation_events (negotiation_id,procurement_id,event_type,trace_id,metadata) VALUES (NULL,${sqlLit(PROC_ID)},'evaluated_not_ready',${sqlLit(trace_id)},${sqlJson({ decision: d.decision, reasons: d.blocking_reasons, note: "no negotiation row: no verified vendor+offer" })})`);
  console.log(JSON.stringify({ negotiation: "NOT_READY", rows_created: 0 }));
}
console.log(JSON.stringify({ decision: d.decision, reason: d.decision_reason.slice(0, 160), blocking: d.blocking_reasons, done: true }));
