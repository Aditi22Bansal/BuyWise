// Debug single-product enrichment insert params.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { serpapiShoppingSearch } from "../tools/product-search/serpapi-shopping.js";

for (const line of readFileSync("D:\\flexi\\.env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && m[2]) process.env[m[1]] ??= m[2];
}
function psqlJson(sql) {
  const out = execFileSync("docker", ["exec", "-i", "buywise-postgres", "psql", "-U", "buywise", "-d", "buywise", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A", "-c", `SELECT coalesce(json_agg(t),'[]') FROM (${sql}) t`], { encoding: "utf8" });
  return JSON.parse(out.trim());
}
const env = { SERPAPI_API_KEY: process.env.SERPAPI_API_KEY, SERPAPI_GL: "in", SERPAPI_HL: "en", SERPAPI_LOCATION: "" };
const products = psqlJson(`SELECT product_id, name FROM products WHERE procurement_id='f5026cfc-a0ad-462b-89df-672ab39a140d' LIMIT 1`);
console.log("PRODUCT " + JSON.stringify(products[0]).slice(0, 200));
const items = await serpapiShoppingSearch({ query: String(products[0].name).slice(0, 120), limit: 3, env });
for (const e of items) {
  console.log("ENVELOPE keys=" + Object.keys(e).join(","));
  console.log("  source=" + e.source + " status=" + e.data_status + " url=" + String(e.source_url).slice(0, 50));
  console.log("  retrieved_at=" + e.retrieved_at + " confidence=" + e.confidence);
  console.log("  data=" + JSON.stringify(e.data).slice(0, 300));
}
