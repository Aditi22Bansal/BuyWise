// BuyWise DEMO MODE unit tests. All inputs synthetic, never LIVE/production.
// Run: node tests/demo.unit.test.mjs
import { selectMode, validateDemoResponse, realModeBlockers, assertDemoLabeled, DEMO_LABELS } from "../tools/_lib/demo.js";
import { validateResponse, mayReevaluate, reevaluate } from "../tools/_lib/reevaluation.js";
import { score } from "../tools/_lib/scoring.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${c ? "" : " — " + String(d).slice(0, 200)}`); c ? pass++ : fail++; };
const CTX = {
  negotiation: { negotiation_id: "n-9", mode: "DEMO" },
  offer: { offer_id: "o-9", product_id: "p-9", net_price: 75000, currency: "INR" },
  vendor: { vendor_id: "v-9", vendor_name: "Real Merchant", source_url: "https://m.example/" },
  product: { product_id: "p-9" },
};
const DEMO_RESP = { channel: "demo", response_mode: "DEMO_HUMAN_ENTERED", vendor_response_verified: false, revised_price: 69500, currency: "INR", received_at: "2026-10-08T15:00:00Z", source: "LOCAL_DEMO_INPUT", delivery_days: "5", warranty: "1 year", payment_terms: "Net 30", notes: "Demo response for evaluation" };

// Mode selection
{
  ok("mode:default-real", selectMode({}).mode === "REAL" && selectMode({}).switched === false, "not REAL by default");
  ok("mode:explicit-demo", selectMode({ requested: "DEMO", reason: "local demo" }).mode === "DEMO", "rejected explicit");
  let threw = false;
  try { selectMode({ requested: "DEMO" }); } catch { threw = true; }
  ok("mode:demo-needs-reason", threw, "silent DEMO switch allowed");
  threw = false;
  try { selectMode({ requested: "SILENT" }); } catch { threw = true; }
  ok("mode:unknown-rejected", threw, "accepted unknown mode");
}
// Demo response validation
{
  ok("demo:valid", validateDemoResponse({ offer: CTX.offer, ...DEMO_RESP }).valid, "rejected valid");
  ok("demo:no-price", !validateDemoResponse({ offer: CTX.offer, ...DEMO_RESP, revised_price: null }).valid, "accepted empty price (prepopulation guard)");
  ok("demo:currency-mismatch", !validateDemoResponse({ offer: CTX.offer, ...DEMO_RESP, currency: "USD" }).valid, "accepted FX");
  ok("demo:no-offer", !validateDemoResponse({ offer: null, ...DEMO_RESP }).valid, "accepted without offer");
}
// REAL blocker proof
{
  const b = realModeBlockers({ vendors: [], offers: [], procurement: { currency: "INR" } });
  ok("real:blocked-no-contact", b.blocked && b.blockers.includes("no verified contact channel") && b.sent === 0, JSON.stringify(b));
}
// Label confusion guard
{
  ok("labels:demo-ok", assertDemoLabeled({ mode: "DEMO", response_mode: "DEMO_HUMAN_ENTERED", vendor_response_verified: false }).ok, "flagged correct labels");
  ok("labels:real-status-rejected", !assertDemoLabeled({ mode: "DEMO", status: "VENDOR_RESPONSE_RECEIVED" }).ok, "allowed REAL status in demo");
  ok("labels:verified-claim-rejected", !assertDemoLabeled({ mode: "DEMO", vendor_response_verified: true }).ok, "allowed verified claim");
  ok("labels:constants", DEMO_LABELS.response_mode === "DEMO_HUMAN_ENTERED" && DEMO_LABELS.source === "LOCAL_DEMO_INPUT", "wrong constants");
}
// Mode-aware reevaluation gates: REAL untouched, DEMO accepted only when labeled
{
  const realCtx = { negotiation: { negotiation_id: "n-1" }, offer: CTX.offer, vendor: CTX.vendor, product: CTX.product, response: { ...DEMO_RESP, channel: "demo" } };
  ok("gate:demo-in-real-rejected", !validateResponse(realCtx).valid, "demo passed REAL validation");
  ok("gate:demo-in-real-gate", mayReevaluate({ negotiation: realCtx.negotiation, response: realCtx.response }).status === "REJECTED", "gate passed demo in REAL");
  const demoCtx = { ...realCtx, response: { ...realCtx.response } };
  const v = validateResponse({ ...demoCtx, mode: "DEMO" });
  ok("gate:demo-labeled-accepted", v.valid && v.demo === true, JSON.stringify(v.reasons));
  const mis = validateResponse({ ...demoCtx, mode: "DEMO", response: { ...demoCtx.response, response_mode: "VENDOR_RESPONSE_RECEIVED" } });
  ok("gate:mislabeled-rejected", !mis.valid, "accepted mislabeled demo");
}
// Demo flows through the EXISTING engine (no duplicated math)
{
  const r = reevaluate({
    original: { components: { price: 0.6, source_quality: 0.9, budget_compliance: 0 }, price: 75000, currency: "INR", budget: 80000 },
    response: DEMO_RESP, weights: { price: 0.4, source_quality: 0.4, budget_compliance: 0.2 }, mode: "DEMO",
    ctx: { negotiation: CTX.negotiation, offer: CTX.offer, vendor: CTX.vendor, product: CTX.product, response: DEMO_RESP },
  });
  const expect = score({ price: 0.6, source_quality: 0.9, budget_compliance: 1 }, { price: 0.4, source_quality: 0.4, budget_compliance: 0.2 });
  ok("demo:engine-reuse", r.status === "REEVALUATED" && r.revised_score === expect.overall_score, `${r.revised_score} vs ${expect.overall_score}`);
  ok("demo:savings", r.absolute_savings === 5500 && r.percentage_savings === 7.33, `${r.absolute_savings}/${r.percentage_savings}`);
  ok("demo:no-fx", reevaluate({ original: { components: {}, price: 75000, currency: "INR" }, response: { ...DEMO_RESP, currency: "USD" }, weights: {}, mode: "DEMO", ctx: { ...CTX, response: { ...DEMO_RESP, currency: "USD" } } }).absolute_savings === null, "converted FX");
}

console.log(`\nDEMO UNIT RESULTS: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
