// BuyWise Phase 2B integration test: verifies REAL post-run DB state for ac07e16d.
// Run AFTER tests/phase2b_run.mjs: node tests/phase2b.integration.test.mjs
// Asserts: INSUFFICIENT_DATA decision, zero negotiation/message rows, NOT_READY event,
// vendors/offers still 0 (nothing fabricated), case == decided, no secrets in new tables.
import { execFileSync } from "node:child_process";

const PROC_ID = "ac07e16d-f392-49e2-a2ac-4b81542cf603";
function psqlJson(sql) {
  const out = execFileSync("docker", ["exec", "-i", "buywise-postgres", "psql", "-U", "buywise", "-d", "buywise", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A", "-c", `SELECT coalesce(json_agg(t),'[]') FROM (${sql}) t`], { encoding: "utf8" });
  return JSON.parse(out.trim());
}
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${c ? "" : " — " + String(d).slice(0, 200)}`); c ? pass++ : fail++; };
const L = (s) => `'${String(s).replace(/'/g, "''")}'`;

const decisions = psqlJson(`SELECT decision, product_id, comparison_id, blocking_reasons, evidence_urls FROM decisions WHERE procurement_id=${L(PROC_ID)}`);
ok("integration:one-decision", decisions.length === 1, `rows=${decisions.length}`);
ok("integration:decision-insufficient", decisions[0]?.decision === "INSUFFICIENT_DATA", decisions[0]?.decision);
ok("integration:decision-attached-rank1", decisions[0]?.product_id === "p-tavily-1b10c1191a56", decisions[0]?.product_id);
ok("integration:decision-blocks-offers", (decisions[0]?.blocking_reasons || []).includes("no verified offers"), JSON.stringify(decisions[0]?.blocking_reasons));
ok("integration:decision-evidence", (decisions[0]?.evidence_urls || []).length > 0, "no evidence urls");

const negs = psqlJson(`SELECT status FROM negotiations WHERE procurement_id=${L(PROC_ID)}`);
ok("integration:zero-negotiation-rows", negs.length === 0, `rows=${negs.length}`);
const msgs = psqlJson(`SELECT count(*)::int AS n FROM negotiation_messages m JOIN negotiations n ON n.negotiation_id=m.negotiation_id WHERE n.procurement_id=${L(PROC_ID)}`);
ok("integration:zero-messages", msgs[0]?.n === 0, JSON.stringify(msgs[0]));
const evts = psqlJson(`SELECT event_type, negotiation_id FROM negotiation_events WHERE procurement_id=${L(PROC_ID)} ORDER BY created_at`);
ok("integration:not-ready-event", evts.some((e) => e.event_type === "evaluated_not_ready" && e.negotiation_id === null), JSON.stringify(evts.map((e) => e.event_type)));
ok("integration:no-2c-events", !evts.some((e) => ["message_sent", "vendor_response_received", "human_confirmed"].includes(e.event_type)), "Phase 2C event leaked");

const counts = psqlJson(`SELECT (SELECT count(*)::int FROM vendors WHERE procurement_id=${L(PROC_ID)}) AS v, (SELECT count(*)::int FROM offers WHERE procurement_id=${L(PROC_ID)}) AS o, (SELECT count(*)::int FROM products WHERE procurement_id=${L(PROC_ID)}) AS p, (SELECT count(*)::int FROM comparisons WHERE procurement_id=${L(PROC_ID)}) AS c`);
ok("integration:no-fake-vendors", counts[0]?.v === 0, `vendors=${counts[0]?.v}`);
ok("integration:no-fake-offers", counts[0]?.o === 0, `offers=${counts[0]?.o}`);
ok("integration:products-untouched", counts[0]?.p === 9, `products=${counts[0]?.p}`);
ok("integration:comparisons-untouched", counts[0]?.c === 9, `comparisons=${counts[0]?.c}`);

const st = psqlJson(`SELECT status FROM procurement_cases WHERE procurement_id=${L(PROC_ID)}`);
ok("integration:status-decided", st[0]?.status === "decided", st[0]?.status);

const leak = psqlJson(`SELECT (SELECT count(*)::int FROM decisions WHERE decision_reason ILIKE '%tvly-%' OR decision_reason ILIKE '%bearer%') + (SELECT count(*)::int FROM negotiation_events WHERE metadata::text ILIKE '%tvly-%' OR metadata::text ILIKE '%bearer%') AS n`);
ok("integration:no-secrets-in-2b-tables", leak[0]?.n === 0, `hits=${leak[0]?.n}`);

console.log(`\nPHASE 2B INTEGRATION RESULTS: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
