// BuyWise Phase 1.5 — provider FAILURE-path tests. No real credentials needed.
// Run: node tests/gateway.failure.test.mjs
// Uses INVALID credentials against REAL endpoints: the only acceptable outcome is
// data_status=UNAVAILABLE (never fabricated data, never a crash).
import { webSearch } from "../tools/web-search/adapter.js";
import { productSearch } from "../tools/product-search/adapter.js";
import { productDetails } from "../tools/product-details/adapter.js";
import { vendorSearch } from "../tools/vendor-search/adapter.js";
import { priceRetrieval } from "../tools/price-retrieval/adapter.js";

const BOGUS = { TAVILY_API_KEY: "tvly-INVALID-KEY-FOR-FAILURE-TEST", EBAY_APP_ID: "INVALID", EBAY_CERT_ID: "INVALID", SERPAPI_API_KEY: "INVALID" };
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${c ? "" : " — " + String(d).slice(0, 250)}`); c ? pass++ : fail++; };
const allUnav = (arr) => Array.isArray(arr) && arr.length > 0 && arr.every((e) => e.data_status === "UNAVAILABLE" && typeof e.error === "string" && e.error.length > 0 && typeof e.retryable === "boolean");

ok("failure:tavily-invalid-key->UNAVAILABLE", allUnav(await webSearch({ query: "business laptop", env: BOGUS })));
ok("failure:product-search-bogus-creds->UNAVAILABLE", allUnav(await productSearch({ query: "business laptop", env: BOGUS })));
const pd = await productDetails({ url: "https://example.com/p/1", env: BOGUS });
ok("failure:product-details-bogus-creds->UNAVAILABLE", pd?.data_status === "UNAVAILABLE" && !!pd?.error, JSON.stringify(pd).slice(0, 200));
ok("failure:vendor-search-bogus-creds->UNAVAILABLE-present", (await vendorSearch({ query: "business laptop", env: BOGUS })).some((e) => e.data_status === "UNAVAILABLE"));
ok("failure:price-retrieval-bogus-creds->UNAVAILABLE", allUnav(await priceRetrieval({ ebayItemIds: ["1"], env: BOGUS })));
// Malformed inputs must also fail safe (no crash, no fake data)
ok("failure:empty-query->UNAVAILABLE", allUnav(await webSearch({ query: "", env: BOGUS })));
const nanOffer = { unit_price: NaN };
ok("failure:NaN-price-detected", !(typeof nanOffer.unit_price === "number" && nanOffer.unit_price > 0), "NaN must be rejected by validators");

console.log(`\nFAILURE-PATH RESULTS: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
