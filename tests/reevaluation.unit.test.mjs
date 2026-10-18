// BuyWise Phase 2C re-evaluation unit tests. Fixtures synthetic, never LIVE/production.
// Run: node tests/reevaluation.unit.test.mjs
import { readFileSync } from "node:fs";
import { validateResponse, reevaluate, mayReevaluate } from "../tools/_lib/reevaluation.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/phase2c_cases.json", import.meta.url), "utf8"));
const ctx = () => ({ negotiation: fx.negotiation, offer: fx.offer, vendor: fx.vendor, product: fx.product, response: JSON.parse(JSON.stringify(fx.response_ok)) });
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${c ? "" : " — " + String(d).slice(0, 220)}`); c ? pass++ : fail++; };

// Gates
{
  ok("gate:no-negotiation-not-eligible", mayReevaluate({ negotiation: null, response: fx.response_ok }).status === "NOT_ELIGIBLE", "wrong");
  ok("gate:no-response-waiting", mayReevaluate({ negotiation: fx.negotiation, response: null }).status === "WAITING_FOR_VENDOR", "wrong");
  ok("gate:ready", mayReevaluate({ negotiation: fx.negotiation, response: fx.response_ok }).ok === true, "wrong");
}
// Validation matrix
{
  ok("response:valid", validateResponse(ctx()).valid, JSON.stringify(validateResponse(ctx()).reasons));
  const badPrice = ctx(); badPrice.response.revised_price = "cheap";
  ok("response:bad-price", !validateResponse(badPrice).valid, "accepted");
  const noCcy = ctx(); delete noCcy.response.currency;
  ok("response:no-currency", !validateResponse(noCcy).valid, "accepted");
  const mismatch = ctx(); mismatch.response.vendor_id = "v-OTHER";
  ok("response:vendor-mismatch", !validateResponse(mismatch).valid, "accepted");
  const noTime = ctx(); delete noTime.response.received_at;
  ok("response:no-timestamp", !validateResponse(noTime).valid, "accepted");
  const noSrc = ctx(); delete noSrc.response.source_url;
  ok("response:no-evidence", !validateResponse(noSrc).valid, "accepted");
  const badChan = ctx(); badChan.response.channel = "phone-call";
  ok("response:bad-channel", !validateResponse(badChan).valid, "accepted");
}
// Recompute: original vs revised via engine reuse
{
  const r = reevaluate({ original: fx.original, response: fx.response_ok, weights: fx.original.weights, ctx: ctx() });
  ok("reeval:status", r.status === "REEVALUATED", JSON.stringify(r.status));
  ok("reeval:scores", typeof r.original_score === "number" && typeof r.revised_score === "number", `${r.original_score}/${r.revised_score}`);
  ok("reeval:delta", typeof r.score_delta === "number" && r.score_delta > 0, JSON.stringify(r.score_delta));
  ok("reeval:savings", r.absolute_savings === 7000 && r.percentage_savings === 8.24, `${r.absolute_savings}/${r.percentage_savings}`);
  ok("reeval:changed", r.criteria_changed.includes("budget_compliance"), JSON.stringify(r.criteria_changed));
  ok("reeval:rejected-bad", reevaluate({ original: fx.original, response: { ...fx.response_ok, revised_price: -5 }, weights: fx.original.weights, ctx: ctx() }).status === "REJECTED", "accepted bad price");
}
// FX mismatch: no savings, budget excluded
{
  const r = reevaluate({ original: fx.original, response: fx.response_fx, weights: fx.original.weights, ctx: { ...ctx(), response: fx.response_fx } });
  ok("reeval:fx-no-savings", r.absolute_savings === null && r.percentage_savings === null, `${r.absolute_savings}/${r.percentage_savings}`);
  ok("reeval:fx-budget-excluded", r.criteria_missing.includes("budget_compliance"), JSON.stringify(r.criteria_missing));
}
// Determinism
{
  const mk = () => reevaluate({ original: fx.original, response: fx.response_ok, weights: fx.original.weights, ctx: ctx() });
  ok("reeval:deterministic", JSON.stringify(mk()) === JSON.stringify(mk()), "non-deterministic");
}
// Score provenance: every revised score records per-criterion source/weight/method
{
  // All criteria missing -> null, never a fabricated number
  const r = reevaluate({
    original: { components: { price: null, quality: null, reviews: null, delivery: null, warranty: null, vendor_reliability: null, payment_terms: null, budget_compliance: null, source_quality: null, specification_completeness: null }, price: 100, currency: "INR", budget: null },
    response: { ...fx.response_ok, revised_price: 90 },
    weights: fx.original.weights, ctx: ctx(),
  });
  ok("reeval:null-stays-null", r.status === "REEVALUATED" && r.revised_score === null, JSON.stringify(r.revised_score));
  ok("reeval:provenance-present", r.score_provenance && typeof r.score_provenance === "object", "provenance missing");
  // One valid criterion -> single-criterion score with explicit thin provenance
  const r2 = reevaluate({
    original: { components: { price: null, quality: null, reviews: null, delivery: null, warranty: null, vendor_reliability: null, payment_terms: null, budget_compliance: null, source_quality: null, specification_completeness: null }, price: 15006, currency: "INR", budget: 40000 },
    response: { ...fx.response_ok, revised_price: 13799 },
    weights: fx.original.weights, ctx: ctx(),
  });
  ok("reeval:single-criterion-score", r2.status === "REEVALUATED" && r2.revised_score === 1, JSON.stringify(r2.revised_score));
  const prov = r2.score_provenance?.budget_compliance;
  ok("reeval:provenance-thin-flagged", prov?.source === "revised_price_vs_budget" && prov?.method === "boolean_in_budget" && Object.keys(r2.score_provenance).length === 1, JSON.stringify(r2.score_provenance));
  ok("reeval:rules-version", r2.scoring_rules_version === "1.0.0", String(r2.scoring_rules_version));
  // Same engine + version for initial and revised scoring (unweighted criteria
  // are skipped by design, not counted as missing).
  ok("reeval:same-engine", r2.criteria_used.length === 1 && r2.criteria_used[0] === "budget_compliance"
    && r2.criteria_missing.includes("price") && !r2.criteria_missing.includes("delivery"), JSON.stringify({ u: r2.criteria_used, m: r2.criteria_missing }));
}

console.log(`\nREEVALUATION UNIT RESULTS: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
