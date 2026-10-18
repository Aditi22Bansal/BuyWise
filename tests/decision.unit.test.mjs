// BuyWise Phase 2B decision unit tests. Fixtures synthetic, never LIVE/production.
// Run: node tests/decision.unit.test.mjs
import { readFileSync } from "node:fs";
import { decide, checkMandatory } from "../tools/_lib/decision.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/phase2b_cases.json", import.meta.url), "utf8"));
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${c ? "" : " — " + String(d).slice(0, 200)}`); c ? pass++ : fail++; };

// PROCEED: verified offer within budget + contact + mandatory satisfied
{
  const r = decide({ procurement: fx.procurement, ranked: fx.ranked_proceed, offersByProduct: fx.offers_proceed, vendorsById: fx.vendors_proceed, productsById: fx.products_proceed, mandatory: fx.mandatory });
  ok("decision:proceed", r.decision === "PROCEED" && r.product_id === "p-good", JSON.stringify(r.decision));
  ok("decision:proceed-offer-attached", !!r._offer && r._offer.offer_id === "o-1", JSON.stringify(r._offer));
}
// NEGOTIATE: same setup but price exceeds budget
{
  const offers = { "p-good": [{ ...fx.offers_proceed["p-good"][0], net_price: 85000 }] };
  const r = decide({ procurement: fx.procurement, ranked: fx.ranked_proceed, offersByProduct: offers, vendorsById: fx.vendors_proceed, productsById: fx.products_proceed, mandatory: fx.mandatory });
  ok("decision:negotiate-over-budget", r.decision === "NEGOTIATE", JSON.stringify(r.decision));
}
// NO_ELIGIBLE_OFFERS: no offers at all (mirrors live ac07e16d dataset).
// Spec mapping (RETROSPECTIVE §5.4): zero verified offers across the ranking
// means nothing purchasable — previously INSUFFICIENT_DATA.
{
  const r = decide({ procurement: fx.procurement, ranked: fx.ranked_proceed, offersByProduct: {}, vendorsById: {}, productsById: fx.products_proceed, mandatory: fx.mandatory });
  ok("decision:no-offers-ineligible", r.decision === "NO_ELIGIBLE_OFFERS" && r.blocking_reasons.includes("no verified offers"), JSON.stringify(r.blocking_reasons));
}
// NO_ELIGIBLE_OFFERS: no ranked candidates. Spec mapping: empty ranking means
// nothing purchasable — previously INSUFFICIENT_DATA.
{
  const r = decide({ procurement: fx.procurement, ranked: [], offersByProduct: {}, vendorsById: {}, productsById: {}, mandatory: {} });
  ok("decision:no-candidates-ineligible", r.decision === "NO_ELIGIBLE_OFFERS" && r.product_id === null, JSON.stringify(r.decision));
}
// INSUFFICIENT_DATA: null score
{
  const ranked = [{ ...fx.ranked_proceed[0], overall_score: null, rank: 1 }];
  const r = decide({ procurement: fx.procurement, ranked, offersByProduct: fx.offers_proceed, vendorsById: fx.vendors_proceed, productsById: fx.products_proceed, mandatory: fx.mandatory });
  ok("decision:null-score-insufficient", r.decision === "INSUFFICIENT_DATA", JSON.stringify(r.decision));
}
// INSUFFICIENT_DATA: missing contact channel
{
  const vendors = { "v-1": { ...fx.vendors_proceed["v-1"], contact_channel: { status: "UNAVAILABLE" } } };
  const r = decide({ procurement: fx.procurement, ranked: fx.ranked_proceed, offersByProduct: fx.offers_proceed, vendorsById: vendors, productsById: fx.products_proceed, mandatory: fx.mandatory });
  ok("decision:no-contact-insufficient", r.decision === "INSUFFICIENT_DATA" && r.blocking_reasons.includes("no vendor contact channel"), JSON.stringify(r.blocking_reasons));
}
// INSUFFICIENT_DATA: currency mismatch (no FX)
{
  const offers = { "p-good": [{ ...fx.offers_proceed["p-good"][0], currency: "USD" }] };
  const r = decide({ procurement: fx.procurement, ranked: fx.ranked_proceed, offersByProduct: offers, vendorsById: fx.vendors_proceed, productsById: fx.products_proceed, mandatory: fx.mandatory });
  ok("decision:currency-mismatch-insufficient", r.decision === "INSUFFICIENT_DATA", JSON.stringify(r.decision));
}
// Mandatory: verified violation skips candidate; unverified blocks (never assumed)
{
  const bad = { specs: { ram_gb: 8, storage_gb: 512 }, mandatory: fx.mandatory };
  ok("mandatory:violation-fails", checkMandatory(bad.specs, bad.mandatory).failed.length === 1, "must fail");
  const unv = checkMandatory({ ram_gb: "unavailable" }, fx.mandatory);
  ok("mandatory:unverified-blocks", unv.unverifiable.includes("ram_gb") && unv.failed.length === 0, JSON.stringify(unv));
}
// Scan: blocked top candidate yields to a fully qualifying lower candidate
{
  const ranked = [
    { ...fx.ranked_proceed[0], rank: 1 },
    { ...fx.ranked_proceed[0], product_id: "p-second", rank: 2 },
  ];
  const products = {
    "p-good": { product_id: "p-good", specifications: {} },
    "p-second": { product_id: "p-second", specifications: { ram_gb: 16, storage_gb: 512 } },
  };
  const offers = {
    "p-good": [],
    "p-second": [{ offer_id: "o-2", product_id: "p-second", vendor_id: "v-1", net_price: 75000, currency: "INR" }],
  };
  const r = decide({ procurement: fx.procurement, ranked, offersByProduct: offers, vendorsById: fx.vendors_proceed, productsById: products, mandatory: fx.mandatory });
  ok("decision:scan-finds-qualifying-lower", r.decision === "PROCEED" && r.product_id === "p-second", JSON.stringify({ d: r.decision, p: r.product_id }));
}
// Mandatory violation on top is skipped, not procurement-blocking
{
  const ranked = [
    { ...fx.ranked_proceed[0], rank: 1 },
    { ...fx.ranked_proceed[0], product_id: "p-second", rank: 2 },
  ];
  const products = {
    "p-good": { product_id: "p-good", specifications: { ram_gb: 8, storage_gb: 512 } },
    "p-second": { product_id: "p-second", specifications: { ram_gb: 16, storage_gb: 512 } },
  };
  const offers = {
    "p-good": [{ offer_id: "o-1", product_id: "p-good", vendor_id: "v-1", net_price: 75000, currency: "INR" }],
    "p-second": [{ offer_id: "o-2", product_id: "p-second", vendor_id: "v-1", net_price: 75000, currency: "INR" }],
  };
  const r = decide({ procurement: fx.procurement, ranked, offersByProduct: offers, vendorsById: fx.vendors_proceed, productsById: products, mandatory: fx.mandatory });
  ok("decision:violation-skips-candidate", r.decision === "PROCEED" && r.product_id === "p-second", JSON.stringify({ d: r.decision, p: r.product_id }));
}
// NO_ELIGIBLE_OFFERS: every candidate fails mandatory gates (verified violations)
{
  const ranked = [
    { ...fx.ranked_proceed[0], rank: 1 },
    { ...fx.ranked_proceed[0], product_id: "p-second", rank: 2 },
  ];
  const products = {
    "p-good": { product_id: "p-good", specifications: { ram_gb: 8, storage_gb: 512 } },
    "p-second": { product_id: "p-second", specifications: { ram_gb: 4, storage_gb: 512 } },
  };
  const offers = {
    "p-good": [{ offer_id: "o-1", product_id: "p-good", vendor_id: "v-1", net_price: 75000, currency: "INR" }],
    "p-second": [{ offer_id: "o-2", product_id: "p-second", vendor_id: "v-1", net_price: 75000, currency: "INR" }],
  };
  const r = decide({ procurement: fx.procurement, ranked, offersByProduct: offers, vendorsById: fx.vendors_proceed, productsById: products, mandatory: fx.mandatory });
  ok("decision:all-failed-ineligible", r.decision === "NO_ELIGIBLE_OFFERS" && r.blocking_reasons.some((b) => b.startsWith("mandatory_failed:")), JSON.stringify(r.blocking_reasons));
}
// RESEARCH_REQUIRED: top blocked only by fillable gaps (unverifiable specs + missing offers)
{
  const ranked = [{ ...fx.ranked_proceed[0], rank: 1 }];
  const products = { "p-good": { product_id: "p-good", specifications: {} } };
  const r = decide({ procurement: fx.procurement, ranked, offersByProduct: { "p-good": [{ offer_id: "o-1", product_id: "p-good", vendor_id: "v-1", net_price: 75000, currency: "INR" }] }, vendorsById: fx.vendors_proceed, productsById: products, mandatory: fx.mandatory });
  ok("decision:fillable-gaps-research", r.decision === "RESEARCH_REQUIRED" && r.blocking_reasons.some((b) => b.startsWith("mandatory_unverifiable:")), JSON.stringify(r.blocking_reasons));
}
// Determinism + malformed input
{
  const args = { procurement: fx.procurement, ranked: fx.ranked_proceed, offersByProduct: {}, vendorsById: {}, productsById: fx.products_proceed, mandatory: fx.mandatory };
  const a = decide(args), b = decide(JSON.parse(JSON.stringify(args)));
  ok("decision:deterministic", JSON.stringify(a) === JSON.stringify(b), "non-deterministic");
  let threw = false;
  try { decide({ ranked: [] }); } catch { threw = true; }
  ok("decision:malformed-throws", threw, "accepted malformed input");
}

console.log(`\nDECISION UNIT RESULTS: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
