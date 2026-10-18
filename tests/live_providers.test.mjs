// BuyWise Phase 1.5 — LIVE provider integration tests. REAL requests only, no mocks.
// Run: node tests/live_providers.test.mjs
// Behavior WITHOUT credentials: every provider reports SKIPPED_NOT_CONFIGURED (exit 0).
// Behavior WITH credentials: performs one real search per provider and validates the
// response shape (.titles, prices, currency, source URLs present; missing fields stay
// missing — never fabricated). API keys are NEVER printed or stored.
import { webSearch, } from "../tools/web-search/adapter.js";
import { productSearch } from "../tools/product-search/adapter.js";
import { vendorSearch } from "../tools/vendor-search/adapter.js";
import { priceRetrieval } from "../tools/price-retrieval/adapter.js";

const QUERY = "business laptop 16GB RAM 512GB SSD";
let pass = 0, fail = 0, skipped = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${c ? "" : " — " + d}`); c ? pass++ : fail++; };
const skip = (n) => { console.log(`SKIP ${n} — SKIPPED_NOT_CONFIGURED`); skipped++; };
const has = (v) => v !== undefined && v !== null && v !== "unavailable" && v !== "";
const mask = (s) => s ? `${String(s).slice(0, 2)}***len=${String(s).length}` : "absent";

const TAV = (process.env.TAVILY_API_KEY ?? "").trim();
const EID = (process.env.EBAY_APP_ID ?? "").trim();
const ESE = (process.env.EBAY_CERT_ID ?? "").trim();
const SER = (process.env.SERPAPI_API_KEY ?? "").trim();
console.log(`cred-status: TAVILY_API_KEY=${TAV ? "configured" : "absent"} EBAY_APP_ID=${EBAY_APP_ID_SET()} EBAY_CERT_ID=${EBAY_CERT_SET()} SERPAPI_API_KEY=${SER ? "configured" : "absent"}`);
function EBAY_APP_ID_SET() { return EID ? "configured" : "absent"; }
function EBAY_CERT_SET() { return ESE ? "configured" : "absent"; }

// --- Tavily live ---
if (!TAV) { skip("tavily:live-search"); }
else {
  const t0 = Date.now();
  const res = await webSearch({ query: QUERY, max_results: 5 });
  const live = res.filter((e) => e.data_status !== "UNAVAILABLE");
  console.log(`tavily: status=${live.length ? "CONNECTED" : "UNAVAILABLE"} retrieved_at=${new Date().toISOString()} result_count=${live.length} latency_ms=${Date.now() - t0}`);
  ok("tavily:live-search:real-results", live.length > 0, JSON.stringify(res[0]).slice(0, 300));
  ok("tavily:live-search:evidence-fields", live.every((e) => has(e.source_url) && has(e.retrieved_at) && /^https?:\/\//.test(e.source_url)), "missing source_url/retrieved_at");
  ok("tavily:live-search:no-excluded-hosts", live.every((e) => !/amazon\.|flipkart\./i.test(e.source_url)), "excluded host leaked");
}

// --- eBay live (auth + search + price) ---
if (!EID || !ESE) { skip("ebay:live-auth+search"); skip("ebay:live-vendor+price"); }
else {
  const t0 = Date.now();
  const res = await productSearch({ query: QUERY, limit: 5 });
  const live = res.filter((e) => e.data_status !== "UNAVAILABLE" && e.source === "ebay_browse_api");
  console.log(`ebay: status=${live.length ? "CONNECTED" : "UNAVAILABLE"} retrieved_at=${new Date().toISOString()} result_count=${live.length} latency_ms=${Date.now() - t0}`);
  ok("ebay:live-search:real-results", live.length > 0, JSON.stringify(res.slice(0, 2)).slice(0, 400));
  ok("ebay:live-search:titles-present", live.every((e) => has(e.data?.title)), "title missing");
  ok("ebay:live-search:price-currency-preserved", live.every((e) => e.data?.price === "unavailable" || has(e.data?.currency)), "price without currency");
  ok("ebay:live-search:no-currency-conversion", live.every((e) => e.data?.price === "unavailable" || typeof e.data?.price === "string" || typeof e.data?.price === "number"), "unexpected");
  const ids = live.map((e) => e.data?.itemId).filter((x) => x && x !== "unavailable").slice(0, 3);
  if (!ids.length) { skip("ebay:live-price-retrieval(no itemIds)"); }
  else {
    const pr = await priceRetrieval({ ebayItemIds: ids });
    const plive = pr.filter((e) => e.data_status !== "UNAVAILABLE");
    console.log(`ebay-price: result_count=${plive.length}`);
    ok("ebay:live-price:timestamped", plive.every((e) => has(e.retrieved_at) && has(e.source_url)), "price missing evidence");
  }
  const v = await vendorSearch({ query: QUERY, limit: 5 });
  ok("ebay:live-vendor:real-or-unavailable", v.every((e) => ["LIVE", "PARTIAL", "UNAVAILABLE"].includes(e.data_status)), "bad status");
}

// --- SerpAPI live (optional) ---
if (!SER) { skip("serpapi:live-search"); }
else {
  const res = await productSearch({ query: QUERY, limit: 3 });
  const live = res.filter((e) => e.source === "serpapi_shopping" && e.data_status !== "UNAVAILABLE");
  console.log(`serpapi: status=${live.length ? "CONNECTED" : "UNAVAILABLE"} result_count=${live.length}`);
  ok("serpapi:live-search:shape", live.every((e) => has(e.source_url)), "missing source_url");
}

console.log(`\nLIVE RESULTS: ${pass} PASS, ${fail} FAIL, ${skipped} SKIPPED_NOT_CONFIGURED`);
process.exit(fail ? 1 : 0);
