// BuyWise Phase 2C integration test: verifies REAL post-run DB state for ac07e16d.
// Run AFTER tests/phase2c_run.mjs: node tests/phase2c.integration.test.mjs
// Expected: reevaluations 0, approvals 0, case still decided, nothing fabricated.
import { execFileSync } from "node:child_process";

const PROC_ID = "ac07e16d-f392-49e2-a2ac-4b81542cf603";
function psqlJson(sql) {
  const out = execFileSync("docker", ["exec", "-i", "buywise-postgres", "psql", "-U", "buywise", "-d", "buywise", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A", "-c", `SELECT coalesce(json_agg(t),'[]') FROM (${sql}) t`], { encoding: "utf8" });
  return JSON.parse(out.trim());
}
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${c ? "" : " — " + String(d).slice(0, 200)}`); c ? pass++ : fail++; };
const L = (s) => `'${String(s).replace(/'/g, "''")}'`;

const tables = psqlJson(`SELECT (SELECT count(*)::int FROM reevaluations WHERE procurement_id=${L(PROC_ID)}) AS r, (SELECT count(*)::int FROM approvals WHERE procurement_id=${L(PROC_ID)}) AS a, (SELECT count(*)::int FROM approval_events WHERE procurement_id=${L(PROC_ID)}) AS e, (SELECT count(*)::int FROM vendors WHERE procurement_id=${L(PROC_ID)}) AS v, (SELECT count(*)::int FROM offers WHERE procurement_id=${L(PROC_ID)}) AS o, (SELECT count(*)::int FROM products WHERE procurement_id=${L(PROC_ID)}) AS p, (SELECT count(*)::int FROM negotiations WHERE procurement_id=${L(PROC_ID)}) AS n`)[0];
ok("integration:no-reevaluations", tables.r === 0, `reevaluations=${tables.r}`);
ok("integration:no-approvals", tables.a === 0, `approvals=${tables.a}`);
ok("integration:no-approval-events", tables.e === 0, `events=${tables.e}`);
ok("integration:no-fake-vendors", tables.v === 0, `vendors=${tables.v}`);
ok("integration:no-fake-offers", tables.o === 0, `offers=${tables.o}`);
ok("integration:no-negotiations", tables.n === 0, `negotiations=${tables.n}`);
ok("integration:products-intact", tables.p === 9, `products=${tables.p}`);

const st = psqlJson(`SELECT status FROM procurement_cases WHERE procurement_id=${L(PROC_ID)}`);
ok("integration:state-decided", st[0]?.status === "decided", st[0]?.status);

const leak = psqlJson(`SELECT (SELECT count(*)::int FROM reevaluations WHERE evidence_urls::text ILIKE '%tvly-%') + (SELECT count(*)::int FROM approvals WHERE approval_package::text ILIKE '%tvly-%' OR approval_package::text ILIKE '%bearer%') + (SELECT count(*)::int FROM approval_events WHERE metadata::text ILIKE '%tvly-%') AS n`);
ok("integration:no-secrets-in-2c-tables", leak[0]?.n === 0, `hits=${leak[0]?.n}`);

console.log(`\nPHASE 2C INTEGRATION RESULTS: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
