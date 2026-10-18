// BuyWise lifecycle unit tests: central transition map + closure/handoff guards.
// Pure logic, no DB. Run: node tests/lifecycle.unit.test.mjs
import { TRANSITIONS, TERMINAL, canTransition, canClose, canHandoff } from "../tools/_lib/lifecycle.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${c ? "" : " — " + String(d).slice(0, 200)}`); c ? pass++ : fail++; };

// Legal research path
{
  ok("lifecycle:research-path", ["product_done", "vendor_done", "quality_done", "compared", "decided"]
    .every((s, i, a) => i === 0 || canTransition(a[i - 1], s).ok), "research chain broken");
}
// Approval path
{
  ok("lifecycle:approval-path", canTransition("decided", "pending_approval").ok, "decided->pending blocked");
  ok("lifecycle:approve-close", canTransition("pending_approval", "closed").ok, "pending->closed blocked");
  ok("lifecycle:negotiating-approve", canTransition("negotiating", "pending_approval").ok, "negotiating->pending blocked");
  ok("lifecycle:demo-approve", canTransition("demo_negotiating", "pending_approval").ok, "demo_negotiating->pending blocked");
  ok("lifecycle:demo-response-approve", canTransition("demo_response_received", "pending_approval").ok, "demo_response_received->pending blocked");
  ok("lifecycle:changes-loop", canTransition("pending_approval", "changes_requested").ok
    && canTransition("changes_requested", "pending_approval").ok, "changes loop broken");
}
// Terminal states admit nothing
{
  ok("lifecycle:closed-terminal", !canTransition("closed", "decided").ok && !canTransition("closed", "pending_approval").ok, "closed escapable");
  ok("lifecycle:closed-handoff-exit", canTransition("closed", "purchase_handoff").ok, "verified handoff must be the one legal exit from closed");
  ok("lifecycle:handoff-terminal", !canTransition("purchase_handoff", "closed").ok, "handoff escapable");
  ok("lifecycle:same-noop", canTransition("decided", "decided").ok, "same-state must be a no-op");
}
// Illegal jumps rejected with reasons
{
  const bad = canTransition("created", "closed");
  ok("lifecycle:created-closed-illegal", !bad.ok && /illegal transition/.test(bad.reason), JSON.stringify(bad));
  const bad2 = canTransition("decided", "closed");
  ok("lifecycle:decided-closed-illegal", !bad2.ok, "decision must not jump straight to closed");
  const bad3 = canTransition("bogus", "decided");
  ok("lifecycle:unknown-state", !bad3.ok, "unknown state accepted");
  const bad4 = canTransition("pending_approval", "decided");
  ok("lifecycle:no-backwards", !bad4.ok, "approval must not rewind to decided");
}
// Closure + handoff guards
{
  ok("lifecycle:close-approved", canClose("APPROVED", "REAL").ok, "approved close rejected");
  ok("lifecycle:close-rejected", canClose("REJECTED", "REAL").ok, "rejected close rejected");
  ok("lifecycle:close-pending", !canClose("PENDING_APPROVAL", "REAL").ok, "pending close allowed");
  ok("lifecycle:handoff-real", canHandoff({ caseStatus: "closed", latestApproval: { status: "APPROVED", mode: "REAL" }, latestDecision: { decision: "PROCEED" } }).ok, "real handoff rejected");
  ok("lifecycle:handoff-demo", !canHandoff({ caseStatus: "closed", latestApproval: { status: "APPROVED", mode: "DEMO" }, latestDecision: { decision: "PROCEED" } }).ok, "demo handoff allowed");
  ok("lifecycle:handoff-no-approval", !canHandoff({ caseStatus: "closed", latestApproval: null, latestDecision: { decision: "PROCEED" } }).ok, "handoff without approval allowed");
  ok("lifecycle:handoff-not-closed", !canHandoff({ caseStatus: "decided", latestApproval: { status: "APPROVED", mode: "REAL" }, latestDecision: { decision: "PROCEED" } }).ok, "handoff before close allowed");
  ok("lifecycle:handoff-insufficient-blocked", !canHandoff({ caseStatus: "closed", latestApproval: { status: "APPROVED", mode: "REAL" }, latestDecision: { decision: "INSUFFICIENT_DATA" } }).ok, "INSUFFICIENT_DATA handoff allowed");
  ok("lifecycle:handoff-negotiate-blocked", !canHandoff({ caseStatus: "closed", latestApproval: { status: "APPROVED", mode: "REAL" }, latestDecision: "NEGOTIATE" }).ok, "NEGOTIATE handoff allowed");
  ok("lifecycle:terminal-set", TERMINAL.includes("closed") && TERMINAL.includes("purchase_handoff"), "terminal set wrong");
  ok("lifecycle:demo-path", canTransition("decided", "demo_negotiating").ok
    && canTransition("demo_negotiating", "demo_response_received").ok
    && canTransition("demo_response_received", "reevaluated").ok
    && canTransition("reevaluated", "pending_approval").ok, "demo chain broken");
}

console.log(`\nLIFECYCLE UNIT RESULTS: ${pass} PASS, ${fail} FAIL`);
if (fail) process.exit(1);
