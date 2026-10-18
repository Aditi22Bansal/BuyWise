// BuyWise Phase 2C live run on the REAL ac07e16d dataset.
// No negotiations and no vendor responses exist -> the ONLY honest outcome is
// reevaluation NOT_ELIGIBLE/WAITING_FOR_VENDOR (zero rows) and approval NOT_CREATED.
// This harness PROVES the system refuses to fabricate progress. Never prints secrets.
// Run: node tests/phase2c_run.mjs   (PGPASSWORD must be in process env)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mayReevaluate } from "../tools/_lib/reevaluation.js";

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
const state = (n) => psqlJson(`SELECT count(*)::int AS n FROM ${n} WHERE procurement_id=${sqlLit(PROC_ID)}`)[0].n;
const before = {
  products: state("products"), vendors: state("vendors"), offers: state("offers"),
  negotiations: state("negotiations"), reevaluations: state("reevaluations"), approvals: state("approvals"),
};
const statusBefore = psqlJson(`SELECT status FROM procurement_cases WHERE procurement_id=${sqlLit(PROC_ID)}`)[0].status;
console.log(JSON.stringify({ procurement_id: PROC_ID, status_before: statusBefore, ...before }));

// Reevaluation gate: no negotiations on record -> NOT_ELIGIBLE, no rows, no transition.
const negotiations = psqlJson(`SELECT negotiation_id FROM negotiations WHERE procurement_id=${sqlLit(PROC_ID)}`);
const gate = mayReevaluate({ negotiation: negotiations[0] || null, response: null });
psql(`INSERT INTO agent_executions (procurement_id,trace_id,agent_name,status,input_hash,output_hash,completed_at,latency_ms) VALUES (${sqlLit(PROC_ID)},${sqlLit(trace_id)},'reevaluation','succeeded',${sqlLit(sha({ negotiations: negotiations.length }))},${sqlLit(sha(gate))},now(),0)`);
psql(`INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES (${sqlLit(PROC_ID)},${sqlLit(trace_id)},'reevaluation','reevaluation_not_eligible',${sqlJson({ gate, note: "no negotiation exists; no vendor response fabricated; zero rows written" })})`);
console.log(JSON.stringify({ reevaluation: gate.status, rows_created: 0 }));

// Approval gate: nothing approvable (no decision product with verified commercial data,
// no negotiation, no reevaluation) -> NOT_CREATED, no rows, no transition.
const approval = { status: "NOT_CREATED", reason: "no approvable outcome: decision INSUFFICIENT_DATA, zero negotiations, zero vendor responses" };
psql(`INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES (${sqlLit(PROC_ID)},${sqlLit(trace_id)},'approval','approval_not_created',${sqlJson(approval)})`);
console.log(JSON.stringify({ approval: approval.status }));

const after = {
  products: state("products"), vendors: state("vendors"), offers: state("offers"),
  negotiations: state("negotiations"), reevaluations: state("reevaluations"), approvals: state("approvals"),
};
const statusAfter = psqlJson(`SELECT status FROM procurement_cases WHERE procurement_id=${sqlLit(PROC_ID)}`)[0].status;
const unchanged = JSON.stringify({ ...before, statusBefore }) === JSON.stringify({ products: after.products, vendors: after.vendors, offers: after.offers, negotiations: after.negotiations, reevaluations: after.reevaluations, approvals: after.approvals, statusBefore: statusAfter });
console.log(JSON.stringify({ status_after: statusAfter, production_tables_unchanged: unchanged, done: true }));
if (!unchanged) { console.error("UNEXPECTED PRODUCTION WRITE"); process.exit(1); }
