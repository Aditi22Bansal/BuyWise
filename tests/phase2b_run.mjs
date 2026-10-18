// BuyWise Phase 2B live run: Decision -> (conditional) Negotiation on the REAL ac07e16d dataset.
// Mirrors 00-orchestrator + 65-agent-decision + 70-agent-negotiation logic EXACTLY
// (deterministic libs; no LLM on this host). No Tavily calls needed (persisted data only).
// Expected: INSUFFICIENT_DATA + NOT_READY, zero negotiation rows. Never prints secrets.
// Run: node tests/phase2b_run.mjs   (PGPASSWORD must be in process env)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { decide } from "../tools/_lib/decision.js";
import { buildRequest, draftMessage } from "../tools/_lib/negotiation.js";

for (const line of readFileSync("D:\\flexi\\.env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && m[2]) process.env[m[1]] ??= m[2];
}
const sha = (o) => createHash("sha256").update(JSON.stringify(o)).digest("hex");
const sqlLit = (v) => (v === null || v === undefined ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'");
const sqlJson = (o) => sqlLit(JSON.stringify(o));
function psqlJson(sql) {
  const out = execFileSync("docker", ["exec", "-i", "buywise-postgres", "psql", "-U", "buywise", "-d", "buywise", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A", "-c", `SELECT coalesce(json_agg(t),'[]') FROM (${sql}) t`], { encoding: "utf8" });
  return JSON.parse(out.trim());
}
function psql(sql) { execFileSync("docker", ["exec", "-i", "buywise-postgres", "psql", "-U", "buywise", "-d", "buywise", "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], { encoding: "utf8" }); }

const PROC_ID = "ac07e16d-f392-49e2-a2ac-4b81542cf603";
const trace_id = randomUUID();

// 1. Load real persisted state (read-only)
const cases = psqlJson(`SELECT procurement_id, budget::text AS budget, currency, quantity, mandatory_specs, status FROM procurement_cases WHERE procurement_id=${sqlLit(PROC_ID)}`);
if (!cases.length) throw new Error("procurement not found");
const c = cases[0];
const procurement = { procurement_id: c.procurement_id, budget: c.budget ? Number(c.budget) : null, currency: c.currency, quantity: c.quantity };
const products = psqlJson(`SELECT product_id, name, specifications, source_url, confidence::text AS confidence FROM products WHERE procurement_id=${sqlLit(PROC_ID)}`);
const ranked = psqlJson(`SELECT comparison_id, product_id, rank, overall_score::text AS overall_score, criteria_used, criteria_missing, evidence_urls FROM comparisons WHERE procurement_id=${sqlLit(PROC_ID)} ORDER BY rank`).map((r) => ({ ...r, overall_score: r.overall_score === null ? null : Number(r.overall_score) }));
const offers = psqlJson(`SELECT offer_id, product_id, vendor_id, net_price::text AS net_price, currency FROM offers WHERE procurement_id=${sqlLit(PROC_ID)}`).map((o) => ({ ...o, net_price: o.net_price === null ? null : Number(o.net_price) }));
const vendors = psqlJson(`SELECT vendor_id, vendor_name, source_url FROM vendors WHERE procurement_id=${sqlLit(PROC_ID)}`);
console.log(JSON.stringify({ procurement_id: PROC_ID, case_status: c.status, products: products.length, ranked: ranked.length, offers: offers.length, vendors: vendors.length }));

// 2. Decision (deterministic gates; mandatory mapping mirrors orchestrator Build Decision Input)
const mandatory = {};
const mspecs = typeof c.mandatory_specs === "string" ? JSON.parse(c.mandatory_specs || "{}") : (c.mandatory_specs || {});
for (const [k, v] of Object.entries(mspecs)) {
  const s = String(k);
  if (s.endsWith("_min")) mandatory[s.slice(0, -4)] = { min: v };
  else if (s.endsWith("_max")) mandatory[s.slice(0, -4)] = { ...(mandatory[s.slice(0, -4)] || {}), max: v };
  else mandatory[s] = { equals: v };
}
const t0 = Date.now();
psql(`INSERT INTO agent_executions (procurement_id,trace_id,agent_name,status,input_hash) VALUES (${sqlLit(PROC_ID)},${sqlLit(trace_id)},'decision','started',${sqlLit(sha({ ranked: ranked.length }))})`);
const d = decide({
  procurement,
  ranked: ranked.map((r) => ({ ...r, comparison_id: r.comparison_id })),
  offersByProduct: Object.fromEntries(products.map((p) => [p.product_id, offers.filter((o) => o.product_id === p.product_id)])),
  vendorsById: Object.fromEntries(vendors.map((v) => [v.vendor_id, { ...v, contact_channel: null }])),
  productsById: Object.fromEntries(products.map((p) => [p.product_id, { ...p, specifications: typeof p.specifications === "string" ? JSON.parse(p.specifications) : p.specifications }])),
  mandatory,
});
psql(`INSERT INTO decisions (procurement_id,product_id,comparison_id,decision,decision_reason,blocking_reasons,criteria_used,criteria_missing,evidence_urls) VALUES (${sqlLit(PROC_ID)},${sqlLit(d.product_id)},${sqlLit(d.comparison_id)},${sqlLit(d.decision)},${sqlLit(d.decision_reason)},${sqlJson(d.blocking_reasons)},${sqlJson(d.criteria_used)},${sqlJson(d.criteria_missing)},${sqlJson(d.evidence_urls)}) ON CONFLICT (procurement_id) DO UPDATE SET product_id=EXCLUDED.product_id,comparison_id=EXCLUDED.comparison_id,decision=EXCLUDED.decision,decision_reason=EXCLUDED.decision_reason,blocking_reasons=EXCLUDED.blocking_reasons,criteria_used=EXCLUDED.criteria_used,criteria_missing=EXCLUDED.criteria_missing,evidence_urls=EXCLUDED.evidence_urls`);
psql(`UPDATE agent_executions SET status='succeeded',output_hash=${sqlLit(sha(d))},completed_at=now(),latency_ms=${Date.now() - t0} WHERE trace_id=${sqlLit(trace_id)} AND agent_name='decision'`);
psql(`UPDATE procurement_cases SET status='decided' WHERE procurement_id=${sqlLit(PROC_ID)}`);
psql(`INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES (${sqlLit(PROC_ID)},${sqlLit(trace_id)},'decision','decision_persisted',${sqlJson({ decision: d.decision, product_id: d.product_id, blocking: d.blocking_reasons })})`);
console.log(JSON.stringify({ decision: d.decision, product_id: d.product_id, reason: d.decision_reason.slice(0, 160), blocking: d.blocking_reasons }));

// 3. Conditional negotiation (only on NEGOTIATE; else NOT_READY event, zero rows)
if (d.decision !== "NEGOTIATE") {
  psql(`INSERT INTO negotiation_events (negotiation_id,procurement_id,event_type,trace_id,metadata) VALUES (NULL,${sqlLit(PROC_ID)},'evaluated_not_ready',${sqlLit(trace_id)},${sqlJson({ decision: d.decision, reasons: d.blocking_reasons, note: "no negotiation row: no verified vendor+offer" })})`);
  console.log(JSON.stringify({ negotiation: "NOT_READY", rows_created: 0 }));
} else {
  const t1 = Date.now();
  psql(`INSERT INTO agent_executions (procurement_id,trace_id,agent_name,status,input_hash) VALUES (${sqlLit(PROC_ID)},${sqlLit(trace_id)},'negotiation','started',${sqlLit(sha(d))})`);
  const vendor = vendors.find((v) => v.vendor_id === d._offer.vendor_id);
  const offer = offers.find((o) => o.offer_id === d._offer.offer_id);
  const product = products.find((p) => p.product_id === d.product_id);
  const r = buildRequest({ procurement_id: PROC_ID, product_id: d.product_id, vendor, offer, target_price: null, target_basis: null });
  if (r.status === "NOT_READY") {
    psql(`INSERT INTO negotiation_events (negotiation_id,procurement_id,event_type,trace_id,metadata) VALUES (NULL,${sqlLit(PROC_ID)},'evaluated_not_ready',${sqlLit(trace_id)},${sqlJson({ reasons: r.reasons })})`);
    console.log(JSON.stringify({ negotiation: "NOT_READY", rows_created: 0 }));
  } else {
    const msg = draftMessage({ negotiation: r.negotiation, procurement, product: { ...product, evidence_urls: d.evidence_urls } });
    psql(`INSERT INTO negotiations (procurement_id,product_id,vendor_id,offer_id,status,current_price,currency,target_price,requested_discount_percent,requested_terms,contact_channel,human_confirmation,do_not_send) VALUES (${sqlLit(PROC_ID)},${sqlLit(r.negotiation.product_id)},${sqlLit(r.negotiation.vendor_id)},${sqlLit(r.negotiation.offer_id)},'READY_FOR_HUMAN_REVIEW',${r.negotiation.current_price},${sqlLit(r.negotiation.currency)},${r.negotiation.target_price},${r.negotiation.requested_discount_percent},${sqlJson(r.negotiation.requested_terms)},${sqlJson(r.negotiation.contact_channel)},false,true) ON CONFLICT (procurement_id,offer_id) DO NOTHING`);
    psql(`INSERT INTO negotiation_messages (negotiation_id,subject,body,facts_used,requested_changes,evidence_urls) VALUES ((SELECT negotiation_id FROM negotiations WHERE procurement_id=${sqlLit(PROC_ID)} AND offer_id=${sqlLit(r.negotiation.offer_id)}),${sqlLit(msg.subject)},${sqlLit(msg.body)},${sqlJson(msg.facts_used)},${sqlJson(msg.requested_changes)},${sqlJson(msg.evidence_urls)})`);
    psql(`INSERT INTO negotiation_events (negotiation_id,procurement_id,event_type,trace_id,metadata) VALUES ((SELECT negotiation_id FROM negotiations WHERE procurement_id=${sqlLit(PROC_ID)} AND offer_id=${sqlLit(r.negotiation.offer_id)}),${sqlLit(PROC_ID)},'human_review_required',${sqlLit(trace_id)},${sqlJson({ target_basis: r.target_basis, do_not_send: true })})`);
    psql(`UPDATE procurement_cases SET status='negotiating' WHERE procurement_id=${sqlLit(PROC_ID)}`);
    psql(`UPDATE agent_executions SET status='succeeded',output_hash=${sqlLit(sha(r.negotiation))},completed_at=now(),latency_ms=${Date.now() - t1} WHERE trace_id=${sqlLit(trace_id)} AND agent_name='negotiation'`);
    console.log(JSON.stringify({ negotiation: r.status, target: r.negotiation.target_price }));
  }
}
console.log(JSON.stringify({ done: true }));
