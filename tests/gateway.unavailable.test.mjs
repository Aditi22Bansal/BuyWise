// BuyWise Phase 1 gateway contract test — REAL behavior, no fake data.
// Run: node tests/gateway.unavailable.test.mjs
// With empty credentials every adapter MUST return UNAVAILABLE (retryable:false), never invented data.
import { webSearch } from "../tools/web-search/adapter.js";
import { productSearch } from "../tools/product-search/adapter.js";
import { productDetails } from "../tools/product-details/adapter.js";
import { vendorSearch } from "../tools/vendor-search/adapter.js";
import { priceRetrieval } from "../tools/price-retrieval/adapter.js";

const EMPTY_ENV = {};
let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " — " + detail}`);
  if (!cond) failures++;
};
const isUnav = (e) => e?.data_status === "UNAVAILABLE" && e?.retryable === false && e?.data === null;

const ws = await webSearch({ query: "office laptop 16GB RAM", env: EMPTY_ENV });
check("web-search/no-creds->UNAVAILABLE", Array.isArray(ws) && ws.every(isUnav), JSON.stringify(ws).slice(0, 200));

const ps = await productSearch({ query: "office laptop 16GB RAM", env: EMPTY_ENV });
check("product-search/no-creds->all-UNAVAILABLE", Array.isArray(ps) && ps.length > 0 && ps.every(isUnav), JSON.stringify(ps).slice(0, 200));

const pd = await productDetails({ url: "https://example.com/product/1", env: EMPTY_ENV });
check("product-details/no-creds->UNAVAILABLE", isUnav(pd), JSON.stringify(pd).slice(0, 200));

const pdExcl = await productDetails({ url: "https://www.amazon.in/dp/B0EXAMPLE", env: EMPTY_ENV });
check("product-details/amazon-excluded", pdExcl?.data_status === "UNAVAILABLE" && /exclud/i.test(pdExcl?.error ?? ""), JSON.stringify(pdExcl).slice(0, 200));

const vs = await vendorSearch({ query: "thinkpad t14", env: EMPTY_ENV });
check("vendor-search/no-creds->UNAVAILABLE-present", Array.isArray(vs) && vs.some(isUnav), JSON.stringify(vs).slice(0, 200));

const pr = await priceRetrieval({ ebayItemIds: ["123"], env: EMPTY_ENV });
check("price-retrieval/no-creds->UNAVAILABLE", Array.isArray(pr) && pr.every(isUnav), JSON.stringify(pr).slice(0, 200));

const empty = await webSearch({ query: "   ", env: EMPTY_ENV });
check("web-search/empty-query->UNAVAILABLE", Array.isArray(empty) && empty.every((e) => e.data_status === "UNAVAILABLE"), JSON.stringify(empty).slice(0, 200));

// No invented URLs: every LIVE envelope must carry a real https URL (none expected here, vacuously true)
const all = [...ws, ...ps, ...(Array.isArray(pd) ? pd : [pd]), ...vs, ...pr];
check("no-fabricated-live-data", all.filter((e) => e.data_status === "LIVE").every((e) => /^https:\/\//.test(e.source_url ?? "")));

console.log(failures ? `\n${failures} FAILURES` : "\nALL GATEWAY CONTRACT TESTS PASSED");
process.exit(failures ? 1 : 0);
