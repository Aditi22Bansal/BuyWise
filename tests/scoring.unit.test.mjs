// BuyWise Phase 2A scoring/evidence unit tests. Fixtures are synthetic, never LIVE.
// Run: node tests/scoring.unit.test.mjs
import { readFileSync } from "node:fs";
import { score, validateWeights, normalizeRating, budgetCompliance, rankRows, DEFAULT_WEIGHTS, SCORING_RULES_VERSION } from "../tools/_lib/scoring.js";
import { classifySource, DEFAULT_TIERS } from "../tools/_lib/source_quality.js";
import { specCompleteness, extractRating, extractReviewCount, isVerified, extractAttributableRating, countRatingPatterns, containsToken, extractSpecs, extractContactEmail } from "../tools/_lib/evidence.js";

const scoringFx = JSON.parse(readFileSync(new URL("./fixtures/scoring_cases.json", import.meta.url), "utf8"));
const qualityFx = JSON.parse(readFileSync(new URL("./fixtures/quality_cases.json", import.meta.url), "utf8"));
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${c ? "" : " — " + String(d).slice(0, 200)}`); c ? pass++ : fail++; };
const approx = (a, b) => (a === null && b === null) || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9);

// --- scoring cases ---
for (const c of scoringFx.cases) {
  const r = score(c.components, c.weights);
  ok(`scoring:${c.id}:score`, approx(r.overall_score, c.expected_score), JSON.stringify(r.overall_score));
  if (c.expected_used) ok(`scoring:${c.id}:used`, JSON.stringify(r.criteria_used) === JSON.stringify(c.expected_used), JSON.stringify(r.criteria_used));
  if (c.expected_missing) ok(`scoring:${c.id}:missing`, JSON.stringify(r.criteria_missing) === JSON.stringify(c.expected_missing), JSON.stringify(r.criteria_missing));
}
// missing never becomes zero: some-missing case must beat naive zero-fill
{
  const partial = score({ price: 0.8, quality: null, source_quality: 0.9 }, { price: 0.5, quality: 0.3, source_quality: 0.2 });
  const zeroFilled = score({ price: 0.8, quality: 0, source_quality: 0.9 }, { price: 0.5, quality: 0.3, source_quality: 0.2 });
  ok("scoring:missing-excluded-not-zero", partial.overall_score > zeroFilled.overall_score, `${partial.overall_score} vs ${zeroFilled.overall_score}`);
  ok("scoring:effective-weight", Math.abs(partial.effective_weight_total - 0.7) < 1e-9, partial.effective_weight_total);
}
for (const c of scoringFx.invalid_weights) {
  ok(`weights:${c.id}:rejected`, validateWeights(c.weights).length > 0, "accepted invalid weights");
}
ok("weights:defaults-valid", validateWeights(DEFAULT_WEIGHTS).length === 0);
// ratings + budgets
for (const c of scoringFx.ratings) ok(`rating:${c.id}`, normalizeRating(c.rating, c.scale) === c.expected || approx(normalizeRating(c.rating, c.scale), c.expected), normalizeRating(c.rating, c.scale));
for (const c of scoringFx.budgets) ok(`budget:${c.id}`, budgetCompliance(c.price, c.currency, c.budget, c.budget_ccy) === c.expected, budgetCompliance(c.price, c.currency, c.budget, c.budget_ccy));
// ranking: deterministic, ties, nulls last, reproducibility
{
  const rows = [
    { product_id: "p-b", overall_score: 0.5, confidence: 0.9 },
    { product_id: "p-a", overall_score: 0.5, confidence: 0.9 },
    { product_id: "p-n", overall_score: null, confidence: 1.0 },
    { product_id: "p-c", overall_score: 0.7, confidence: 0.1 },
  ];
  const r1 = rankRows(rows).map((r) => r.product_id);
  const r2 = rankRows([...rows].reverse()).map((r) => r.product_id);
  ok("ranking:order", JSON.stringify(r1) === JSON.stringify(["p-c", "p-a", "p-b", "p-n"]), JSON.stringify(r1));
  ok("ranking:reproducible", JSON.stringify(r1) === JSON.stringify(r2), "order depends on input order");
}
// source tiers
for (const c of qualityFx.source_tiers) {
  const r = classifySource(c.url);
  ok(`tier:${c.url.slice(8, 38)}`, r.tier === c.tier && r.score === c.score, JSON.stringify(r));
}
ok("tiers:source-quality-not-product-quality", DEFAULT_TIERS.every((t) => t.label !== "good product"), "tier labels must describe evidence, not product goodness");
// specs
for (const c of qualityFx.specs) {
  const r = specCompleteness(c.specs, c.fields);
  ok(`specs:${c.id}`, Math.abs(r.completeness - c.completeness) < 1e-9 && r.verified === c.verified, JSON.stringify(r));
}
ok("specs:unavailable-case-insensitive", !isVerified("Unavailable") && !isVerified("  ") && isVerified(16) && isVerified("i5"), "verified() wrong");
// rating extraction incl. false-positive guards
for (const c of qualityFx.ratings) {
  const r = extractRating(c.text), n = extractReviewCount(c.text);
  ok(`extract:${c.id}:rating`, (r?.rating ?? null) === c.rating && (r?.scale ?? null) === (c.scale ?? null), JSON.stringify(r));
  ok(`extract:${c.id}:count`, (n?.count ?? null) === c.count, JSON.stringify(n));
}

for (const c of qualityFx.attribution) {
  const r = extractAttributableRating(c.text, c.tokens);
  if (c.accepted) ok(`attribution:${c.id}:accepted`, !!r && !r.rejected && r.rating === c.rating && !!r.context, JSON.stringify(r));
  else ok(`attribution:${c.id}:rejected`, r === null || !!r.rejected, JSON.stringify(r));
}

for (const c of qualityFx.spec_extract) {
  const r = extractSpecs(c.text);
  ok(`specextract:${c.id}:ram`, (r.ram_gb?.value ?? null) === c.ram, JSON.stringify(r.ram_gb));
  ok(`specextract:${c.id}:storage`, (r.storage_gb?.value ?? null) === c.storage, JSON.stringify(r.storage_gb));
  ok(`specextract:${c.id}:warranty`, (r.warranty_months?.value ?? null) === c.warranty, JSON.stringify(r.warranty_months));
}
for (const c of qualityFx.contact_extract) {
  const r = extractContactEmail(c.text);
  ok(`contactextract:${c.id}`, (r?.email ?? null) === c.email, JSON.stringify(r));
}
// Scoring rules version + reproducibility from stored inputs
{
  ok("scoring:rules-version", SCORING_RULES_VERSION === "1.0.0", String(SCORING_RULES_VERSION));
  // Recompute a stored-style breakdown: same components+weights must reproduce the score.
  const components = { price: null, quality: 0.8, reviews: null, delivery: null, warranty: null, vendor_reliability: null, payment_terms: null, budget_compliance: 1, source_quality: 0.9, specification_completeness: 0.5 };
  const a = score(components, DEFAULT_WEIGHTS);
  const b = score(JSON.parse(JSON.stringify(components)), JSON.parse(JSON.stringify(DEFAULT_WEIGHTS)));
  ok("scoring:reproducible", a.overall_score === b.overall_score && JSON.stringify(a.breakdown) === JSON.stringify(b.breakdown), "recompute diverged");
  ok("scoring:renormalized", Math.abs(a.overall_score - ((0.15 * 0.8 + 0.08 * 1 + 0.1 * 0.9 + 0.1 * 0.5) / (0.15 + 0.08 + 0.1 + 0.1))) < 1e-9, String(a.overall_score));
  ok("scoring:missing-excluded", a.criteria_missing.includes("price") && !a.criteria_used.includes("price"), "missing not excluded");
  ok("scoring:null-no-basis", score({ price: null, quality: null, reviews: null, delivery: null, warranty: null, vendor_reliability: null, payment_terms: null, budget_compliance: null, source_quality: null, specification_completeness: null }, DEFAULT_WEIGHTS).overall_score === null, "null expected");
}

console.log(`\nSCORING UNIT RESULTS: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
