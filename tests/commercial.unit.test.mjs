// BuyWise commercial evidence unit tests (offer/vendor/identity rules).
// Run: node tests/commercial.unit.test.mjs
import { validateOfferEvidence, validateVendorEvidence, productIdentity, merchantKey, evidenceConfidence } from "../tools/_lib/commercial.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${c ? "" : " — " + String(d).slice(0, 200)}`); c ? pass++ : fail++; };
const good = { product_name: "ThinkPad T14", product_url: "https://www.shop.example/p/t14", merchant_name: "ShopExample", merchant_url: "https://www.shop.example/buy/t14", price: 78500, currency: "INR", source_url: "https://www.shop.example/p/t14" };

// Offer matrix
{
  ok("offer:valid-accepted", validateOfferEvidence(good).accepted, "rejected valid");
  const m = (k, v) => validateOfferEvidence({ ...good, [k]: v });
  ok("offer:missing-merchant", !m("merchant_name", "unavailable").accepted, "accepted");
  ok("offer:missing-price", !m("price", "unavailable").accepted, "accepted");
  ok("offer:zero-price", !m("price", 0).accepted, "accepted");
  ok("offer:string-price", !m("price", "78500").accepted, "accepted non-numeric");
  ok("offer:missing-currency", !m("currency", "unavailable").accepted, "accepted");
  ok("offer:bad-currency", !m("currency", "Rupees").accepted, "accepted guessed currency");
  ok("offer:missing-url", !m("source_url", null).accepted, "accepted");
  ok("offer:malformed-url", !m("source_url", "not a url").accepted, "accepted");
  ok("offer:unclear-product", !m("product_name", "unavailable").accepted, "accepted");
}
// Vendor matrix incl. placeholders
{
  ok("vendor:real-accepted", validateVendorEvidence({ vendor_name: "ShopExample", merchant_url: "https://www.shop.example/", provider: "serpapi_shopping" }).accepted, "rejected");
  for (const fake of ["Vendor A", "Vendor B", "Test Vendor", "unknown", ""]) {
    ok(`vendor:placeholder-${fake || "blank"}`, !validateVendorEvidence({ vendor_name: fake, merchant_url: "https://x.example/", provider: "s" }).accepted, "accepted placeholder");
  }
  ok("vendor:no-url", !validateVendorEvidence({ vendor_name: "Real", provider: "s" }).accepted, "accepted");
}
// Identity: URL > serpapi_id > brand+model; never merge on names
{
  const a = productIdentity({ product_url: "https://s.example/p/X?ref=1", brand: "B", model: "M" });
  const b = productIdentity({ product_url: "https://s.example/p/X?ref=2", brand: "B", model: "M" });
  ok("identity:url-stable", a.kind === "url" && a.key === b.key, JSON.stringify(a));
  const a2 = productIdentity({ product_url: "https://s.example/p/X", serpapi_product_id: "1", brand: "B", model: "M" });
  ok("identity:serpapi-wins", a2.kind === "serpapi_id" && a2.key === "serpapi:1", JSON.stringify(a2));
  const redir = productIdentity({ product_url: "https://www.google.com/search?ibp=oshop&q=x&prds=productid:1", serpapi_product_id: null, brand: null, model: null });
  ok("identity:redirector-never-key", redir.kind === "weak" && redir.key === null, JSON.stringify(redir));
  const c = productIdentity({ serpapi_product_id: "99", brand: "B", model: "M" });
  ok("identity:serpapi-fallback", c.kind === "serpapi_id", c.kind);
  const d = productIdentity({ brand: "Lenovo", model: "T14" });
  ok("identity:brand-model", d.kind === "brand_model", d.kind);
  const e = productIdentity({ brand: "Lenovo", model: "unavailable" });
  ok("identity:weak-no-merge", e.kind === "weak" && e.key === null, JSON.stringify(e));
}
// Merchants: distinct sellers never collapse
{
  const k1 = merchantKey({ merchant_name: "ShopExample", merchant_url: "https://www.shop.example/buy" });
  const k2 = merchantKey({ merchant_name: "ShopExample", merchant_url: "https://www.shop.example/buy" });
  const k3 = merchantKey({ merchant_name: "OtherStore", merchant_url: "https://other.example/buy" });
  ok("merchant:same-same", k1 === k2, "split identical");
  ok("merchant:distinct-kept", k1 !== k3, "collapsed distinct sellers");
  ok("merchant:blank-null", merchantKey({ merchant_name: "" }) === null, "key for blank");
}
ok("confidence:scale", evidenceConfidence({ a: 1, b: "x", c: "unavailable", d: null }) < evidenceConfidence({ a: 1, b: "x", c: "y", d: "z" }), "not completeness-based");

console.log(`\nCOMMERCIAL UNIT RESULTS: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
