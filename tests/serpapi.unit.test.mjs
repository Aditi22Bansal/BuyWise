// BuyWise SerpAPI adapter unit tests. Fixtures synthetic, never LIVE/production.
// Run: node tests/serpapi.unit.test.mjs
import { readFileSync } from "node:fs";
import { parsePrice, mapHttpError, normalizeShoppingItem, normalizeSeller } from "../tools/product-search/serpapi-shopping.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/serpapi_cases.json", import.meta.url), "utf8"));
const NOW = "2026-10-08T00:00:00Z";
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${c ? "" : " — " + String(d).slice(0, 200)}`); c ? pass++ : fail++; };

// parsePrice: explicit symbols/codes only; never guessed
{
  const inr = parsePrice("₹78,500");
  ok("price:inr-symbol", inr.price === 78500 && inr.currency === "INR", JSON.stringify(inr));
  const usd = parsePrice("$1,199.00");
  ok("price:usd-symbol", usd.price === 1199 && usd.currency === "USD", JSON.stringify(usd));
  const code = parsePrice("78500 INR");
  ok("price:code", code.price === 78500 && code.currency === "INR", JSON.stringify(code));
  const bare = parsePrice("78500");
  ok("price:no-symbol-no-currency", bare.price === 78500 && bare.currency === null, JSON.stringify(bare));
  const range = parsePrice("Starting from ₹70,000");
  ok("price:range-rejected", range.price === null, JSON.stringify(range));
  const nan = parsePrice("Price on request");
  ok("price:text-rejected", nan.price === null, JSON.stringify(nan));
  const neg = parsePrice(-5, "INR");
  ok("price:negative-rejected", neg.price === null, JSON.stringify(neg));
  const badccy = parsePrice(100, "XX");
  ok("price:bad-code-rejected", badccy.currency === null, JSON.stringify(badccy));
}
// mapHttpError: 401/403 no-retry; 429/5xx retryable
{
  ok("http:401-no-retry", mapHttpError(401, "bad key").retryable === false, "retries on 401");
  ok("http:403-no-retry", mapHttpError(403, "denied").retryable === false, "retries on 403");
  ok("http:429-retry", mapHttpError(429, "slow down").retryable === true, "no retry on 429");
  ok("http:500-retry", mapHttpError(500, "boom").retryable === true, "no retry on 500");
  ok("http:error-text", mapHttpError(401, "bad key").error.includes("401"), "status lost");
}
// normalizeShoppingItem
{
  const full = normalizeShoppingItem(fx.full_item, NOW);
  ok("item:full-live", full.data_status === "LIVE" && full.source === "serpapi_shopping", full.data_status);
  ok("item:full-fields", full.data.price === 78500 && full.data.currency === "INR" && full.data.merchant_name === "ShopExample" && full.data.rating === 4.4 && full.data.review_count === 212, JSON.stringify(full.data));
  ok("item:timestamp", full.retrieved_at === NOW, "timestamp not actual");
  const nm = normalizeShoppingItem(fx.no_merchant, NOW);
  ok("item:merchant-unavailable", nm.data.merchant_name === "unavailable" && nm.data_status === "PARTIAL", JSON.stringify(nm.data.merchant_name));
  const np = normalizeShoppingItem(fx.no_price, NOW);
  ok("item:price-unavailable", np.data.price === "unavailable", "invented price");
  const ns = normalizeShoppingItem(fx.no_symbol_price, NOW);
  ok("item:currency-not-guessed", ns.data.price === 78500 && ns.data.currency === "unavailable", JSON.stringify(ns.data));
  const rg = normalizeShoppingItem(fx.range_price, NOW);
  ok("item:range-not-offer-price", rg.data.price === "unavailable", "range treated as price");
  ok("item:excluded-host", normalizeShoppingItem(fx.excluded_host, NOW) === null, "excluded host leaked");
  const br = normalizeShoppingItem(fx.bad_rating, NOW);
  ok("item:bad-rating-sanitized", br.data.rating === "unavailable" && br.data.review_count === "unavailable", "kept malformed rating");
  ok("item:null-safe", normalizeShoppingItem(null, NOW) === null, "crashed on null");
}
// normalizeSeller
{
  const s = normalizeSeller(fx.seller_full, { product_url: "https://www.shop.example/p/t14", product_name: "T14" }, NOW);
  ok("seller:live", s.data_status === "LIVE" && s.data.merchant_name === "ShopExample" && s.data.price === 76900 && s.data.currency === "INR", JSON.stringify(s.data));
  ok("seller:no-price-partial", normalizeSeller(fx.seller_no_price, null, NOW).data.price === "unavailable", "invented");
  ok("seller:no-name-null", normalizeSeller(fx.seller_no_name, null, NOW) === null, "nameless seller kept");
}
// Adapter reads key only from env (static check)
{
  const src = readFileSync(new URL("../tools/product-search/serpapi-shopping.js", import.meta.url), "utf8");
  ok("adapter:key-from-env", src.includes('requireEnv("SERPAPI_API_KEY"'), "key not from env");
  ok("adapter:no-literal-key", !/tvly-|re_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9]{8,}|"[A-Za-z0-9]{32,}"/.test(src), "literal secret?");
}

console.log(`\nSERPAPI UNIT RESULTS: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
