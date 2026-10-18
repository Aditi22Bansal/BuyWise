// BuyWise Phase 1.5 — real procurement run harness (Steps 4-6).
// Mirrors the n8n orchestrator + state-manager validation logic EXACTLY (same rules as
// 00-orchestrator-buywise / 10-agent-product-research / 90-util-state-manager Code nodes).
// LLM suitability judgement is NOT performed (Ollama unavailable) — products are stored
// as PARTIAL candidates with specs "unavailable". No offers are created from web-search
// snippets (no verified price evidence). NEVER prints secrets; envelopes carry none.
// Run: node tests/phase15_procurement_run.mjs   (PGPASSWORD must be in process env)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { productSearch } from "../tools/product-search/adapter.js";
import { vendorSearch } from "../tools/vendor-search/adapter.js";

// 1. Load .env silently (values never logged)
for (const line of readFileSync("D:\\flexi\\.env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && m[2]) process.env[m[1]] ??= m[2];
}
const sha = (o) => createHash("sha256").update(JSON.stringify(o)).digest("hex");
const sqlLit = (v) => (v === null || v === undefined ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'");
const sqlJson = (o) => sqlLit(JSON.stringify(o));
function psql(sql) {
  return execFileSync("docker", ["exec", "-i", "buywise-postgres", "psql", "-U", "buywise", "-d", "buywise", "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], { encoding: "utf8" });
}

const PROC = {
  requirement: "Business laptops for software development. Budget INR 80000 per unit. Minimum 16 GB RAM, 512 GB SSD. Windows or Linux acceptable. Quantity 1.",
  quantity: 1, budget: 80000, currency: "INR",
  mandatory_specs: { ram_gb_min: 16, storage_gb_min: 512 },
  preferred_specs: { os: ["Windows", "Linux"], use: "software_development" },
};
const procurement_id = randomUUID(), trace_id = randomUUID();
const t0 = Date.now();
console.log(JSON.stringify({ procurement_id, trace_id, requirement: PROC.requirement.slice(0, 60) + "..." }));

// 2. Intake: persist case (mirrors orchestrator Validate Intake + state-manager create_case)
psql(`INSERT INTO procurement_cases (procurement_id,status,requirement,quantity,budget,currency,mandatory_specs,preferred_specs,created_by) VALUES (${sqlLit(procurement_id)},'created',${sqlLit(PROC.requirement)},${PROC.quantity},${PROC.budget},${sqlLit(PROC.currency)},${sqlJson(PROC.mandatory_specs)},${sqlJson(PROC.preferred_specs)},'phase15-run')`);
psql(`INSERT INTO agent_executions (procurement_id,trace_id,agent_name,status,input_hash) VALUES (${sqlLit(procurement_id)},${sqlLit(trace_id)},'orchestrator','started',${sqlLit(sha(PROC))})`);

// 3. Product research via REAL gateway (Tavily; eBay penalized-pending -> UNAVAILABLE inside adapter)
const gw = await productSearch({ query: "business laptop 16GB RAM 512GB SSD buy India", limit: 10 });
const live = gw.filter((e) => e.data_status !== "UNAVAILABLE");
console.log(JSON.stringify({ gateway_envelopes: gw.length, live: live.length, errors: [...new Set(gw.filter((e) => e.error).map((e) => e.error))] }));

// 4. Validate EXACTLY like the n8n agent Validate Output node
const seen = new Set(); let accepted = [], rejected = 0;
for (const e of live) {
  const fail = (why) => { rejected++; console.log(JSON.stringify({ rejected: e.source_url, why })); };
  if (!e.source_url) { fail("missing source_url"); continue; }
  let host; try { host = new URL(e.source_url).hostname; } catch { fail("invalid source_url"); continue; }
  if (/amazon\.|flipkart\./i.test(host)) { fail("excluded source (Phase 1)"); continue; }
  if (!e.data?.title || !e.source || !e.retrieved_at) { fail("missing required field"); continue; }
  if (seen.has(e.source_url)) { fail("duplicate source_url"); continue; }
  seen.add(e.source_url);
  const pid = "p-tavily-" + createHash("sha1").update(e.source_url).digest("hex").slice(0, 12);
  accepted.push({
    product_id: pid, name: String(e.data.title).slice(0, 300), brand: "unavailable",
    specifications: { ram_gb: "unavailable", storage_gb: "unavailable", processor: "unavailable" },
    source: e.source, source_url: e.source_url, retrieved_at: e.retrieved_at,
    data_status: "PARTIAL", confidence: e.confidence ?? 0.6,
    raw: { title: e.data.title ?? null, snippet: (e.data.snippet ?? "").slice(0, 2000), suitability_review: "pending — LLM unavailable on current host" },
  });
}
// 5. Persist products (mirrors state-manager insert_products; specs "unavailable", never guessed)
for (const p of accepted) {
  psql(`INSERT INTO products (product_id,procurement_id,name,brand,specifications,source,source_url,retrieved_at,data_status,confidence,raw_response) VALUES (${sqlLit(p.product_id)},${sqlLit(procurement_id)},${sqlLit(p.name)},'unavailable',${sqlJson(p.specifications)},${sqlLit(p.source)},${sqlLit(p.source_url)},${sqlLit(p.retrieved_at)},'PARTIAL',${p.confidence},${sqlJson(p.raw)}) ON CONFLICT (procurement_id,source_url) DO NOTHING`);
}
psql(`UPDATE procurement_cases SET status='product_done' WHERE procurement_id=${sqlLit(procurement_id)}`);
const ms1 = Date.now() - t0;
psql(`INSERT INTO agent_executions (procurement_id,trace_id,agent_name,status,input_hash,output_hash,completed_at,latency_ms) VALUES (${sqlLit(procurement_id)},${sqlLit(trace_id)},'product_research','succeeded',${sqlLit(sha(PROC))},${sqlLit(sha(accepted))},now(),${ms1})`);
psql(`INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES (${sqlLit(procurement_id)},${sqlLit(trace_id)},'product_research','products_persisted',${sqlJson({ accepted: accepted.length, rejected, note: "specs unavailable; suitability pending LLM" })})`);

// 6. Vendor stage: run REAL vendor-search, create offers ONLY with price evidence (none expected from snippets)
const vres = await vendorSearch({ query: "business laptop 16GB RAM 512GB SSD buy India", limit: 10 });
const withPrice = vres.filter((e) => e.data_status !== "UNAVAILABLE" && typeof e.data?.price === "number" && e.data.price > 0 && e.data?.currency && e.data.currency !== "unavailable");
console.log(JSON.stringify({ vendor_envelopes: vres.length, with_verified_price: withPrice.length, offers_created: 0 }));
psql(`UPDATE procurement_cases SET status='partial' WHERE procurement_id=${sqlLit(procurement_id)}`);
psql(`INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES (${sqlLit(procurement_id)},${sqlLit(trace_id)},'orchestrator','vendor_stage_no_price_evidence',${sqlJson({ vendor_envelopes: vres.length, with_verified_price: 0, reason: "Tavily snippets carry no verified price/currency/seller; eBay PENDING_APPROVAL; 0 offers created rather than inventing data" })})`);
psql(`UPDATE agent_executions SET status='succeeded',output_hash=${sqlLit(sha({ accepted: accepted.length, offers: 0 }))},completed_at=now(),latency_ms=${Date.now() - t0} WHERE trace_id=${sqlLit(trace_id)} AND agent_name='orchestrator'`);

console.log(JSON.stringify({ done: true, products_accepted: accepted.length, products_rejected: rejected, vendors_accepted: 0, offers_accepted: 0, case_status: "partial", latency_ms: Date.now() - t0 }));
for (const p of accepted) console.log(JSON.stringify({ product_id: p.product_id, name: p.name.slice(0, 100), source_url: p.source_url, data_status: p.data_status, confidence: p.confidence }));
