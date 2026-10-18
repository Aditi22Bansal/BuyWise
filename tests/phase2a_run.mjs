// BuyWise Phase 2A live pipeline run: Review & Quality -> Comparison -> Scoring -> PostgreSQL.
// Runs the ACTUAL 9 persisted Phase 1.5 products through the deterministic pipeline.
// No LLM (Ollama unavailable): source tiers, spec completeness, scoring, ranking are CODE
// (same algorithms as 40/50/60 n8n workflows; canonical libs in tools/_lib/).
// Review evidence: ONE real Tavily basic search per product; rating/count accepted ONLY
// on strict explicit patterns, else "unavailable". Never prints secrets.
// Run: node tests/phase2a_run.mjs   (PGPASSWORD must be in process env)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { webSearch } from "../tools/web-search/adapter.js";
import { classifySource } from "../tools/_lib/source_quality.js";
import { specCompleteness, extractAttributableRating, extractReviewCount } from "../tools/_lib/evidence.js";
import { score, rankRows, DEFAULT_WEIGHTS } from "../tools/_lib/scoring.js";
// Relevance tokens derived from the procurement requirement (laptop category).
// A rating is attributed to a candidate ONLY with product context + exactly one rating pattern.
const RELEVANCE_TOKENS = ["laptop", "notebook", "16gb", "16 gb", "512gb", "512 gb", "ssd", "ram"];

for (const line of readFileSync("D:\\flexi\\.env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && m[2]) process.env[m[1]] ??= m[2];
}
const sha = (o) => createHash("sha256").update(JSON.stringify(o)).digest("hex");
const sqlLit = (v) => (v === null || v === undefined ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'");
const sqlJson = (o) => sqlLit(JSON.stringify(o));
function psqlJson(sql) {
  const out = execFileSync("docker", ["exec", "-i", "buywise-postgres", "psql", "-U", "buywise", "-d", "buywise", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A", "-c", `SELECT coalesce(json_agg(t),'[]') FROM (${sql}) t`], { encoding: "utf8" });
  return JSON.parse(out.trim());
}
function psql(sql) { execFileSync("docker", ["exec", "-i", "buywise-postgres", "psql", "-U", "buywise", "-d", "buywise", "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], { encoding: "utf8" }); }

const PROC_ID = "ac07e16d-f392-49e2-a2ac-4b81542cf603"; // Phase 1.5 live procurement (9 real products)
const trace_id = randomUUID();
const SPEC_FIELDS = ["processor", "ram", "storage", "operating_system", "display", "battery", "graphics"];

// 1. Load real case + products (read-only; nothing fabricated)
const caseRows = psqlJson(`SELECT budget::text AS budget, currency, status FROM procurement_cases WHERE procurement_id=${sqlLit(PROC_ID)}`);
const { budget: budgetStr, currency, status: caseStatus } = caseRows[0];
const budget = budgetStr && budgetStr !== "" ? Number(budgetStr) : null;
const products = psqlJson(`SELECT product_id, name, brand, specifications, source, source_url, retrieved_at, data_status, confidence::text AS confidence FROM products WHERE procurement_id=${sqlLit(PROC_ID)} ORDER BY product_id`).map((p) => ({ ...p, specifications: typeof p.specifications === "string" ? JSON.parse(p.specifications) : (p.specifications ?? {}), confidence: Number(p.confidence) }));
console.log(JSON.stringify({ procurement_id: PROC_ID, case_status: caseStatus, budget, currency, products_loaded: products.length }));
if (!products.length) throw new Error("no products to evaluate");

// 2. Scoring config (defaults; procurement-overridable, never in LLM prompts)
psql(`INSERT INTO scoring_configs (procurement_id,weights,spec_fields,notes) VALUES (${sqlLit(PROC_ID)},${sqlJson(DEFAULT_WEIGHTS)},${sqlJson(SPEC_FIELDS)},'Phase 2A defaults for laptop use case') ON CONFLICT (procurement_id) DO UPDATE SET weights=EXCLUDED.weights,spec_fields=EXCLUDED.spec_fields,notes=EXCLUDED.notes`);
psql(`INSERT INTO agent_executions (procurement_id,trace_id,agent_name,status,input_hash) VALUES (${sqlLit(PROC_ID)},${sqlLit(trace_id)},'review_quality','started',${sqlLit(sha({ products: products.length }))})`);

// 3. Review & Quality: deterministic tiers + completeness + ONE real review search each
const t0 = Date.now();
const evals = [];
for (const p of products) {
  const sq = classifySource(p.source_url);
  const sc = specCompleteness(p.specifications, SPEC_FIELDS);
  let rating = null, rcount = null, revSnippet = "unavailable", revUrls = [];
  const rejections = [];
  try {
    const res = await webSearch({ query: `${p.name.slice(0, 80)} review rating`, max_results: 5 });
    for (const e of res.filter((x) => x.data_status !== "UNAVAILABLE" && x.source_url)) {
      const text = `${e.data?.title ?? ""} ${e.data?.snippet ?? ""}`;
      const attr = extractAttributableRating(text, RELEVANCE_TOKENS);
      revUrls.push(e.source_url);
      if (attr && !attr.rejected && !rating) {
        rating = attr; revSnippet = attr.context;
        const n = extractReviewCount(text);
        if (n) rcount = n;
      } else if (attr && attr.rejected && rejections.length < 3) {
        rejections.push({ reason: attr.rejected, url: e.source_url });
      }
      if (rating && rcount) break;
    }
    if (!rating && revUrls.length) revSnippet = "review mentions found but no attributable rating";
  } catch (err) { revSnippet = "unavailable"; }
  evals.push({
    procurement_id: PROC_ID, product_id: p.product_id,
    source_quality: sq.tier, source_quality_score: sq.score,
    specification_completeness: sc.completeness, spec_fields_total: sc.total, spec_fields_verified: sc.verified,
    review_rating: rating ? rating.rating : "unavailable", review_scale: rating ? rating.scale : null,
    review_count: rcount ? rcount.count : "unavailable", review_evidence: revSnippet,
    quality_evidence: [{ kind: "source_classification", tier: sq.tier, label: sq.label }, { kind: "spec_completeness", verified: sc.verified, total: sc.total }, ...(rating ? [{ kind: "review_rating", basis: rating.basis }] : []), ...(rcount ? [{ kind: "review_count", basis: rcount.basis }] : []), ...rejections.map((x) => ({ kind: "rating_rejected", ...x }))],
    quality_confidence: sq.score >= 0.8 ? 0.8 : sq.score,
    source_urls: [p.source_url, ...revUrls.slice(0, 5)],
    retrieved_at: new Date().toISOString(), data_status: "PARTIAL",
  });
}
for (const e of evals) {
  psql(`INSERT INTO quality_evaluations (procurement_id,product_id,source_quality,source_quality_score,specification_completeness,spec_fields_total,spec_fields_verified,review_rating,review_scale,review_count,review_evidence,quality_evidence,quality_confidence,source_urls,retrieved_at,data_status) VALUES (${sqlLit(e.procurement_id)},${sqlLit(e.product_id)},${sqlLit(e.source_quality)},${e.source_quality_score},${e.specification_completeness},${e.spec_fields_total},${e.spec_fields_verified},${typeof e.review_rating === "number" ? e.review_rating : "NULL"},${typeof e.review_scale === "number" ? e.review_scale : "NULL"},${Number.isInteger(e.review_count) ? e.review_count : "NULL"},${sqlLit(e.review_evidence)},${sqlJson(e.quality_evidence)},${e.quality_confidence},${sqlJson(e.source_urls)},${sqlLit(e.retrieved_at)},'PARTIAL') ON CONFLICT (procurement_id,product_id) DO UPDATE SET source_quality=EXCLUDED.source_quality,source_quality_score=EXCLUDED.source_quality_score,specification_completeness=EXCLUDED.specification_completeness,review_rating=EXCLUDED.review_rating,review_scale=EXCLUDED.review_scale,review_count=EXCLUDED.review_count,review_evidence=EXCLUDED.review_evidence,quality_evidence=EXCLUDED.quality_evidence,quality_confidence=EXCLUDED.quality_confidence,source_urls=EXCLUDED.source_urls,retrieved_at=EXCLUDED.retrieved_at`);
}
psql(`UPDATE agent_executions SET status='succeeded',output_hash=${sqlLit(sha(evals))},completed_at=now(),latency_ms=${Date.now() - t0} WHERE trace_id=${sqlLit(trace_id)} AND agent_name='review_quality'`);
psql(`UPDATE procurement_cases SET status='quality_done' WHERE procurement_id=${sqlLit(PROC_ID)}`);
psql(`INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES (${sqlLit(PROC_ID)},${sqlLit(trace_id)},'review_quality','quality_evaluations_persisted',${sqlJson({ evaluated: evals.length, with_rating: evals.filter((e) => typeof e.review_rating === "number").length, with_count: evals.filter((e) => Number.isInteger(e.review_count)).length })})`);
console.log(JSON.stringify({ evaluated: evals.length, with_rating: evals.filter((e) => typeof e.review_rating === "number").length, with_count: evals.filter((e) => Number.isInteger(e.review_count)).length }));

// 4. Comparison: deterministic components -> engine -> deterministic rank
const t1 = Date.now();
psql(`INSERT INTO agent_executions (procurement_id,trace_id,agent_name,status,input_hash) VALUES (${sqlLit(PROC_ID)},${sqlLit(trace_id)},'comparison','started',${sqlLit(sha({ evals: evals.length }))})`);
const byId = Object.fromEntries(evals.map((e) => [e.product_id, e]));
const rows = products.map((p) => {
  const ev = byId[p.product_id];
  const revScore = typeof ev.review_rating === "number" ? ev.review_rating / (ev.review_scale ?? 5) : null;
  const components = {
    price: null, quality: revScore, reviews: revScore, delivery: null, warranty: null,
    vendor_reliability: null, payment_terms: null, budget_compliance: null, // no offers: no verdict
    source_quality: ev.source_quality_score, specification_completeness: ev.specification_completeness,
  };
  const s = score(components, DEFAULT_WEIGHTS);
  const strengths = [], limitations = [];
  if (ev.source_quality === "HIGH") strengths.push(`High-quality evidence source (${p.source_url})`);
  else limitations.push(`Source quality is ${ev.source_quality} — candidate, not a verified product`);
  if (ev.spec_fields_verified > 0) strengths.push(`${ev.spec_fields_verified}/${ev.spec_fields_total} defined specifications verified`);
  else limitations.push("No defined specifications verifiable from source");
  if (revScore !== null) strengths.push(`Verified review rating ${ev.review_rating}/${ev.review_scale}`);
  else limitations.push("Review data unavailable");
  limitations.push("Price comparison unavailable");
  return { product_id: p.product_id, overall_score: s.overall_score, criteria_scores: s.breakdown, criteria_used: s.criteria_used, criteria_missing: s.criteria_missing, effective_weight_total: s.effective_weight_total, budget_compliance: "unavailable", source_quality: ev.source_quality_score, specification_completeness: ev.specification_completeness, strengths, limitations, evidence_urls: ev.source_urls, confidence: p.confidence };
});
const ranked = rankRows(rows);
for (const r of ranked) {
  psql(`INSERT INTO comparisons (procurement_id,product_id,rank,overall_score,criteria_scores,criteria_used,criteria_missing,effective_weight_total,budget_compliance,source_quality,specification_completeness,strengths,limitations,evidence_urls) VALUES (${sqlLit(PROC_ID)},${sqlLit(r.product_id)},${r.rank},${typeof r.overall_score === "number" ? r.overall_score : "NULL"},${sqlJson(r.criteria_scores)},${sqlJson(r.criteria_used)},${sqlJson(r.criteria_missing)},${r.effective_weight_total},'unavailable',${r.source_quality},${r.specification_completeness},${sqlJson(r.strengths)},${sqlJson(r.limitations)},${sqlJson(r.evidence_urls)}) ON CONFLICT (procurement_id,product_id) DO UPDATE SET rank=EXCLUDED.rank,overall_score=EXCLUDED.overall_score,criteria_scores=EXCLUDED.criteria_scores,criteria_used=EXCLUDED.criteria_used,criteria_missing=EXCLUDED.criteria_missing,effective_weight_total=EXCLUDED.effective_weight_total,strengths=EXCLUDED.strengths,limitations=EXCLUDED.limitations,evidence_urls=EXCLUDED.evidence_urls`);
}
psql(`UPDATE procurement_cases SET status='compared' WHERE procurement_id=${sqlLit(PROC_ID)}`);
psql(`UPDATE agent_executions SET status='succeeded',output_hash=${sqlLit(sha(ranked.map((r) => [r.product_id, r.rank, r.overall_score])))},completed_at=now(),latency_ms=${Date.now() - t1} WHERE trace_id=${sqlLit(trace_id)} AND agent_name='comparison'`);
psql(`INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES (${sqlLit(PROC_ID)},${sqlLit(trace_id)},'comparison','comparisons_persisted',${sqlJson({ ranked: ranked.length, criteria_note: "price/vendor/delivery/warranty/budget excluded (no verified offers); rank from source_quality + specification_completeness + reviews where available" })})`);

console.log(JSON.stringify({ ranked: ranked.length, case_status: "compared" }));
for (const r of ranked) console.log(JSON.stringify({ rank: r.rank, product_id: r.product_id, overall_score: r.overall_score, used: r.criteria_used, missing: r.criteria_missing }));
