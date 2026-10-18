// BuyWise DEMO run: explicit local demonstration on REAL provider data. No new agents.
// Manual human entries arrive via DEMO_* env vars (set explicitly by the operator at
// run time = the "form"). NOTHING is sent anywhere; no vendor is contacted.
// Every demo artifact is labeled DEMO_HUMAN_ENTERED / LOCAL_DEMO_INPUT / mode DEMO.
// Run: DEMO_PROC=<id> DEMO_PRICE=69500 DEMO_CCY=INR DEMO_DECISION=APPROVED ... node tests/demo_run.mjs
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { selectMode, validateDemoResponse, realModeBlockers } from "../tools/_lib/demo.js";
import { reevaluate } from "../tools/_lib/reevaluation.js";
import { validateDecisionInput, closureTransition, validatePackage } from "../tools/_lib/approval.js";
import { DEFAULT_WEIGHTS } from "../tools/_lib/scoring.js";

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
const E = (k, dflt = null) => (process.env[k] !== undefined && process.env[k] !== "" ? process.env[k] : dflt);

const PROC_ID = E("DEMO_PROC");
if (!PROC_ID) throw new Error("DEMO_PROC (real procurement id) required; run commercial_run.mjs first");
const trace_id = randomUUID();
const out = { mode: null, sent: 0, contacted_vendors: 0 };

// 0. Load REAL persisted state; prove REAL path blocked (no weakening)
const cases = psqlJson(`SELECT procurement_id,budget::text AS budget,currency,quantity,mode,status FROM procurement_cases WHERE procurement_id=${sqlLit(PROC_ID)}`);
if (!cases.length) throw new Error("procurement not found");
const c = cases[0];
const products = psqlJson(`SELECT product_id,name,specifications,source_url FROM products WHERE procurement_id=${sqlLit(PROC_ID)}`);
const ranked = psqlJson(`SELECT comparison_id,product_id,rank,overall_score,criteria_used,criteria_missing,evidence_urls FROM comparisons WHERE procurement_id=${sqlLit(PROC_ID)} ORDER BY rank`).map((r) => ({ ...r, overall_score: r.overall_score === null ? null : Number(r.overall_score) }));
const offers = psqlJson(`SELECT offer_id,product_id,vendor_id,net_price,currency,source_url,delivery_days,warranty_months,payment_terms FROM offers WHERE procurement_id=${sqlLit(PROC_ID)}`).map((o) => ({ ...o, net_price: Number(o.net_price) }));
const vendors = psqlJson(`SELECT vendor_id,vendor_name,source_url FROM vendors WHERE procurement_id=${sqlLit(PROC_ID)}`);
const blockers = realModeBlockers({ vendors: vendors.map((v) => ({ ...v, contact_channel: null })), offers, procurement: { currency: c.currency } });
console.log(JSON.stringify({ procurement_id: PROC_ID, case_mode: c.mode, case_status: c.status, products: products.length, offers: offers.length, vendors: vendors.length, real_blockers: blockers.blockers, external_sends: 0 }));

// 1. Explicit DEMO selection (reason mandatory)
const sel = selectMode({ current: c.mode, requested: "DEMO", reason: E("DEMO_REASON", "local end-to-end demonstration; no vendor contact") });
out.mode = sel.mode;
psql(`UPDATE procurement_cases SET mode='DEMO' WHERE procurement_id=${sqlLit(PROC_ID)}`);
psql(`INSERT INTO negotiation_events (negotiation_id,procurement_id,event_type,trace_id,metadata) VALUES (NULL,${sqlLit(PROC_ID)},'demo_mode_selected',${sqlLit(trace_id)},${sqlJson({ mode: "DEMO", reason: sel.reason, actor: "HUMAN" })})`);

// 2. Pick a REAL offer deterministically: in-budget INR offer on spec-verified product,
// else top-ranked product's cheapest INR offer. Never invented.
const unitBudget = Number(c.budget) / Number(c.quantity || 1);
const specOk = (pid) => {
  const p = products.find((x) => x.product_id === pid);
  const s = typeof p?.specifications === "string" ? JSON.parse(p.specifications) : (p?.specifications || {});
  const n = (v) => (typeof v === "number" ? v : (typeof v === "string" && /^[0-9.]+$/.test(v) ? Number(v) : null));
  return n(s.ram_gb ?? s.ram) !== null && n(s.ram_gb ?? s.ram) >= 16 && n(s.storage_gb ?? s.storage) !== null && n(s.storage_gb ?? s.storage) >= 512;
};
const inr = offers.filter((o) => o.currency === c.currency);
const withSpecs = inr.filter((o) => specOk(o.product_id) && o.net_price <= unitBudget);
const pool = withSpecs.length ? withSpecs : inr.filter((o) => o.net_price <= unitBudget);
const chosen = (E("DEMO_OFFER") ? inr.find((o) => o.offer_id === E("DEMO_OFFER")) : null) || pool.sort((a, b) => a.net_price - b.net_price)[0] || inr.sort((a, b) => a.net_price - b.net_price)[0];
if (!chosen) throw new Error("demo refused: no real offers exist on this case");
const vendor = vendors.find((v) => v.vendor_id === chosen.vendor_id);
const product = products.find((p) => p.product_id === chosen.product_id);
console.log(JSON.stringify({ demo_offer: chosen.offer_id, vendor: vendor.vendor_name, product: product.name.slice(0, 80), price: chosen.net_price, currency: chosen.currency }));

// 3. DEMO negotiation (real FKs, DEMO labels, do_not_send; NOTHING sent — no send code exists in this file)
const target = E("DEMO_TARGET") ? Number(E("DEMO_TARGET")) : (unitBudget < chosen.net_price ? unitBudget : chosen.net_price);
const negotiation_id = randomUUID();
psql(`INSERT INTO negotiations (negotiation_id,procurement_id,product_id,vendor_id,offer_id,mode,status,current_price,currency,target_price,requested_discount_percent,requested_terms,contact_channel,human_confirmation,do_not_send) VALUES (${sqlLit(negotiation_id)},${sqlLit(PROC_ID)},${sqlLit(chosen.product_id)},${sqlLit(chosen.vendor_id)},${sqlLit(chosen.offer_id)},'DEMO','DEMO_READY_FOR_RESPONSE',${chosen.net_price},${sqlLit(chosen.currency)},${target},${Math.round((1 - target / chosen.net_price) * 10000) / 100},'[]','{"type":"other","address":"LOCAL_DEMO_ONLY"}',false,true)`);
psql(`INSERT INTO negotiation_events (negotiation_id,procurement_id,event_type,trace_id,metadata) VALUES (${sqlLit(negotiation_id)},${sqlLit(PROC_ID)},'demo_negotiation_created',${sqlLit(trace_id)},${sqlJson({ mode: "DEMO", no_message_sent: true, external_sends: 0, actor: "HUMAN" })})`);
psql(`UPDATE procurement_cases SET status='demo_negotiating' WHERE procurement_id=${sqlLit(PROC_ID)}`);
console.log(JSON.stringify({ negotiation: "DEMO_READY_FOR_RESPONSE", target_price: target, message: "NO MESSAGE SENT TO VENDOR" }));

// 4. MY manual demo response (env-provided = human entry; validated, labeled)
const demoResp = {
  channel: "demo", response_mode: "DEMO_HUMAN_ENTERED", vendor_response_verified: false,
  revised_price: Number(E("DEMO_PRICE")), currency: String(E("DEMO_CCY", chosen.currency)).toUpperCase(),
  received_at: new Date().toISOString(), source: "LOCAL_DEMO_INPUT",
  delivery_days: E("DEMO_DELIVERY", "unavailable"), warranty: E("DEMO_WARRANTY", "unavailable"),
  payment_terms: E("DEMO_TERMS", "unavailable"), notes: E("DEMO_NOTES", ""),
};
const dv = validateDemoResponse({ offer: chosen, ...demoResp });
if (!dv.valid) throw new Error("demo response rejected: " + dv.reasons.join("; "));
psql(`INSERT INTO demo_responses (procurement_id,negotiation_id,offer_id,revised_price,currency,delivery_days,warranty,payment_terms,notes,response_mode,source,vendor_response_verified,entered_by) VALUES (${sqlLit(PROC_ID)},${sqlLit(negotiation_id)},${sqlLit(chosen.offer_id)},${demoResp.revised_price},${sqlLit(demoResp.currency)},${sqlLit(demoResp.delivery_days)},${sqlLit(demoResp.warranty)},${sqlLit(demoResp.payment_terms)},${sqlLit(demoResp.notes)},'DEMO_HUMAN_ENTERED','LOCAL_DEMO_INPUT',false,'HUMAN')`);
psql(`UPDATE negotiations SET status='DEMO_RESPONSE_RECEIVED' WHERE negotiation_id=${sqlLit(negotiation_id)}`);
psql(`INSERT INTO negotiation_events (negotiation_id,procurement_id,event_type,trace_id,metadata) VALUES (${sqlLit(negotiation_id)},${sqlLit(PROC_ID)},'demo_response_received',${sqlLit(trace_id)},${sqlJson({ mode: "DEMO", actor: "HUMAN" })})`);
psql(`UPDATE procurement_cases SET status='demo_response_received' WHERE procurement_id=${sqlLit(PROC_ID)}`);
console.log(JSON.stringify({ demo_response: "DEMO_RESPONSE_RECEIVED", revised_price: demoResp.revised_price, currency: demoResp.currency }));

// 5. Re-evaluation through the EXISTING engine (mode DEMO, no duplicated math)
const comp = ranked.find((r) => r.product_id === chosen.product_id);
const origComps = {};
{
  const full = psqlJson(`SELECT criteria_scores FROM comparisons WHERE procurement_id=${sqlLit(PROC_ID)} AND product_id=${sqlLit(chosen.product_id)}`)[0]?.criteria_scores || {};
  for (const [k, v] of Object.entries(full)) origComps[k] = v && typeof v.score === "number" ? v.score : null;
}
const t1 = Date.now();
psql(`INSERT INTO agent_executions (procurement_id,trace_id,agent_name,status,input_hash) VALUES (${sqlLit(PROC_ID)},${sqlLit(trace_id)},'reevaluation','started',${sqlLit(sha({ negotiation_id }))})`);
const r = reevaluate({
  original: { components: origComps, price: chosen.net_price, currency: chosen.currency, budget: unitBudget },
  response: demoResp, weights: DEFAULT_WEIGHTS, mode: "DEMO",
  ctx: { negotiation: { negotiation_id }, offer: chosen, vendor, product: { product_id: product.product_id }, response: demoResp },
});
if (r.status !== "REEVALUATED") throw new Error("reevaluation failed: " + JSON.stringify(r));
const reevId = randomUUID();
psql(`INSERT INTO reevaluations (reevaluation_id,procurement_id,negotiation_id,product_id,vendor_id,offer_id,mode,original_score,revised_score,score_delta,original_price,revised_price,currency,absolute_savings,percentage_savings,criteria_changed,criteria_used,criteria_missing,evidence_urls,status) VALUES (${sqlLit(reevId)},${sqlLit(PROC_ID)},${sqlLit(negotiation_id)},${sqlLit(chosen.product_id)},${sqlLit(chosen.vendor_id)},${sqlLit(chosen.offer_id)},'DEMO',${r.original_score ?? "NULL"},${r.revised_score ?? "NULL"},${r.score_delta ?? "NULL"},${r.original_price ?? "NULL"},${r.revised_price ?? "NULL"},${sqlLit(r.currency)},${r.absolute_savings ?? "NULL"},${r.percentage_savings ?? "NULL"},${sqlJson(r.criteria_changed)},${sqlJson(r.criteria_used)},${sqlJson(r.criteria_missing)},${sqlJson([chosen.source_url])},'REEVALUATED')`);
psql(`UPDATE agent_executions SET status='succeeded',output_hash=${sqlLit(sha(r))},completed_at=now(),latency_ms=${Date.now() - t1} WHERE trace_id=${sqlLit(trace_id)} AND agent_name='reevaluation'`);
psql(`UPDATE procurement_cases SET status='reevaluated' WHERE procurement_id=${sqlLit(PROC_ID)}`);
console.log(JSON.stringify({ reevaluation: "REEVALUATED", original_score: r.original_score, revised_score: r.revised_score, delta: r.score_delta, savings: r.absolute_savings, currency: r.currency }));

// 6. Approval package (labeled DEMO throughout) + MY explicit human decision
const pkg = {
  procurement_id: PROC_ID, procurement_request: { budget: Number(c.budget), currency: c.currency, quantity: Number(c.quantity) },
  selected_product: { product_id: product.product_id, name: product.name },
  selected_vendor: { vendor_id: vendor.vendor_id, vendor_name: vendor.vendor_name },
  original_offer: chosen, revised_offer: { ...demoResp }, original_score: r.original_score ?? "unavailable",
  revised_score: r.revised_score ?? "unavailable", savings: { absolute: r.absolute_savings ?? "unavailable", percentage: r.percentage_savings ?? "unavailable", currency: r.currency },
  quality_evidence: "see quality_evaluations", review_evidence: "see quality_evaluations",
  delivery_information: demoResp.delivery_days, warranty_information: demoResp.warranty, payment_terms: demoResp.payment_terms,
  criteria_used: r.criteria_used, criteria_missing: r.criteria_missing,
  limitations: ["PROCUREMENT MODE: DEMO", "VENDOR RESPONSE: HUMAN-ENTERED DEMO DATA", "NO REAL VENDOR CONTACTED", "NO MESSAGE SENT TO VENDOR"],
  evidence_urls: [chosen.source_url], negotiation_history: [{ mode: "DEMO", status: "DEMO_RESPONSE_RECEIVED" }],
  status: "PENDING_APPROVAL",
};
const pv = validatePackage(pkg);
if (!pv.complete) throw new Error("package incomplete: " + pv.missing.join(","));
const apprId = randomUUID();
psql(`INSERT INTO approvals (approval_id,procurement_id,selected_product_id,selected_vendor_id,selected_offer_id,mode,status,approval_package) VALUES (${sqlLit(apprId)},${sqlLit(PROC_ID)},${sqlLit(chosen.product_id)},${sqlLit(chosen.vendor_id)},${sqlLit(chosen.offer_id)},'DEMO','PENDING_APPROVAL',${sqlJson(pkg)})`);
psql(`INSERT INTO approval_events (approval_id,procurement_id,event_type,actor,trace_id,metadata) VALUES (${sqlLit(apprId)},${sqlLit(PROC_ID)},'approval_created','system',${sqlLit(trace_id)},${sqlJson({ mode: "DEMO" })})`);
psql(`UPDATE procurement_cases SET status='pending_approval' WHERE procurement_id=${sqlLit(PROC_ID)}`);
const decision = String(E("DEMO_DECISION", "")).toUpperCase();
const actor = E("DEMO_ACTOR", "");
const dv2 = validateDecisionInput({ approval_id: apprId, procurement_id: PROC_ID, decision, actor, decided_at: new Date().toISOString() });
if (!dv2.valid) throw new Error("human decision rejected: " + dv2.reasons.join("; "));
const close = closureTransition(decision);
psql(`UPDATE approvals SET status=${sqlLit(decision === "APPROVED" ? "APPROVED" : decision === "REJECTED" ? "REJECTED" : "CHANGES_REQUESTED")},approved_by=${sqlLit(actor.trim())},approved_at=now(),decision_reason=${sqlLit(E("DEMO_REASON", "human demo decision"))} WHERE approval_id=${sqlLit(apprId)}`);
const evName = decision === "APPROVED" ? "approval_approved" : decision === "REJECTED" ? "approval_rejected" : "approval_changes_requested";
psql(`INSERT INTO approval_events (approval_id,procurement_id,event_type,actor,trace_id,metadata) VALUES (${sqlLit(apprId)},${sqlLit(PROC_ID)},${sqlLit(evName)},${sqlLit(actor.trim())},${sqlLit(trace_id)},${sqlJson({ mode: "DEMO" })})`);
psql(`UPDATE procurement_cases SET status=${sqlLit(close.status)} WHERE procurement_id=${sqlLit(PROC_ID)}`);
psql(`INSERT INTO agent_executions (procurement_id,trace_id,agent_name,status,input_hash,output_hash,completed_at,latency_ms) VALUES (${sqlLit(PROC_ID)},${sqlLit(trace_id)},'approval','succeeded',${sqlLit(sha(pkg))},${sqlLit(sha({ decision, actor }))},now(),0)`);
console.log(JSON.stringify({ approval: decision, approved_by: actor.trim(), final_state: close.status, mode: "DEMO", auto: false }));
console.log(JSON.stringify({ done: true, external_sends: 0, vendors_contacted: 0 }));
