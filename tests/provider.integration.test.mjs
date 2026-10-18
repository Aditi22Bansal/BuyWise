// BuyWise provider integration test: deterministic fixture path (NO network, NO DB).
// SerpAPI normalized result -> product -> vendor -> offer -> comparison -> decision.
// Fixtures synthetic, never LIVE/production. Run: node tests/provider.integration.test.mjs
import { readFileSync } from "node:fs";
import { normalizeShoppingItem } from "../tools/product-search/serpapi-shopping.js";
import { validateOfferEvidence, validateVendorEvidence, productIdentity, merchantKey } from "../tools/_lib/commercial.js";
import { score, DEFAULT_WEIGHTS } from "../tools/_lib/scoring.js";
import { decide } from "../tools/_lib/decision.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/serpapi_cases.json", import.meta.url), "utf8"));
const NOW = "2026-10-08T00:00:00Z";
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${c ? "" : " — " + String(d).slice(0, 200)}`); c ? pass++ : fail++; };

// Full happy path with fixture listing
{
  const env = normalizeShoppingItem(fx.full_item, NOW);
  const d = env.data;
  const ov = validateOfferEvidence({ product_name: d.product_name, product_url: d.product_url, merchant_name: d.merchant_name, merchant_url: d.product_url, price: d.price, currency: d.currency, source_url: env.source_url });
  ok("path:offer-accepted", ov.accepted, JSON.stringify(ov.missing));
  const vv = validateVendorEvidence({ vendor_name: d.merchant_name, merchant_url: d.product_url, provider: "serpapi_shopping" });
  ok("path:vendor-accepted", vv.accepted, JSON.stringify(vv.missing));
  const pid = productIdentity({ product_url: d.product_url, serpapi_product_id: d.model }).key;
  const mk = merchantKey({ merchant_name: d.merchant_name, merchant_url: d.product_url });
  ok("path:identity-stable", pid === "serpapi:123456789" && !!mk, `${pid}|${mk}`);
  const s = score({ price: 0.9, reviews: d.rating / 5, source_quality: 0.9, specification_completeness: 0 }, { price: 0.4, reviews: 0.2, source_quality: 0.3, specification_completeness: 0.1 });
  ok("path:scored", Math.abs(s.overall_score - 0.806) < 1e-9 && s.criteria_used.length === 4, JSON.stringify(s.overall_score));
  const dec = decide({
    procurement: { procurement_id: "00000000-0000-4000-8000-000000000003", currency: "INR", budget: 80000, quantity: 1 },
    ranked: [{ product_id: "p-x", rank: 1, overall_score: s.overall_score, criteria_used: s.criteria_used, criteria_missing: s.criteria_missing, evidence_urls: [env.source_url] }],
    offersByProduct: { "p-x": [{ offer_id: "o-x", product_id: "p-x", vendor_id: "v-x", net_price: 78500, currency: "INR" }] },
    vendorsById: { "v-x": { vendor_id: "v-x", contact_channel: { type: "email", address: "sales@shop.example", source_url: "https://www.shop.example/contact", status: "LIVE" } } },
    productsById: { "p-x": { product_id: "p-x", specifications: {} } },
    mandatory: {},
  });
  ok("path:decision-proceed", dec.decision === "PROCEED", dec.decision);
}
// Broken path: merchant-less listing never becomes an offer -> INSUFFICIENT_DATA
{
  const env = normalizeShoppingItem(fx.no_merchant, NOW);
  const ov = validateOfferEvidence({ product_name: env.data.product_name, product_url: env.data.product_url, merchant_name: env.data.merchant_name, merchant_url: null, price: env.data.price, currency: env.data.currency, source_url: env.source_url });
  ok("path:merchantless-no-offer", !ov.accepted, "became an offer");
  const dec = decide({
    procurement: { procurement_id: "00000000-0000-4000-8000-000000000003", currency: "INR", budget: 80000 },
    ranked: [{ product_id: "p-y", rank: 1, overall_score: 0.4, criteria_used: ["source_quality"], criteria_missing: ["price"], evidence_urls: [env.source_url] }],
    offersByProduct: {}, vendorsById: {},
    productsById: { "p-y": { product_id: "p-y", specifications: {} } },
    mandatory: {},
  });
  ok("path:merchantless-insufficient", dec.decision === "INSUFFICIENT_DATA", dec.decision);
}
// DEFAULT_WEIGHTS still valid with commercial criteria present
{
  const s = score({ price: 0.8, quality: 0.7, reviews: 0.88, source_quality: 0.9, specification_completeness: 0 }, DEFAULT_WEIGHTS);
  ok("path:default-weights", typeof s.overall_score === "number", "no score");
}

console.log(`\nPROVIDER INTEGRATION RESULTS: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
