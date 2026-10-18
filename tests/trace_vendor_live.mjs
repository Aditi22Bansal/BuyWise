// Live trace: run the real vendor-search adapter for the case's products and
// print raw envelopes to see why 0 offers persist.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { vendorSearch } from "../tools/vendor-search/adapter.js";

for (const line of readFileSync("D:\\flexi\\.env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && m[2]) process.env[m[1]] ??= m[2];
}
function psqlJson(sql) {
  const out = execFileSync("docker", ["exec", "-i", "buywise-postgres", "psql", "-U", "buywise", "-d", "buywise", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A", "-c", `SELECT coalesce(json_agg(t),'[]') FROM (${sql}) t`], { encoding: "utf8" });
  return JSON.parse(out.trim());
}
const id = "f5026cfc-a0ad-462b-89df-672ab39a140d";
const products = psqlJson(`SELECT product_id, name FROM products WHERE procurement_id='${id}' LIMIT 40`);
const names = products.slice(0, 5).map((p) => p.name).filter(Boolean).join(" ").slice(0, 300);
console.log("QUERY LEN " + names.length + " PRODUCTS " + products.length);
const items = await vendorSearch({ query: names || "business laptop", limit: 10 });
console.log("ENVELOPES " + items.length);
for (const e of items.slice(0, 14)) {
  const d = e.data || {};
  console.log(JSON.stringify({ source: e.source, status: e.data_status, merchant: d.merchant_name ?? d.vendor_name, price: String(d.price ?? "").slice(0, 40), currency: d.currency, serpapi_pid: String(d.serpapi_product_id ?? "").slice(0, 24), url: String(e.source_url ?? "").slice(0, 60) }));
}
