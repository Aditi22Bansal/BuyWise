// BuyWise coordination unit tests: message contracts, bounded loops, escalation.
// All inputs synthetic, never LIVE/production. Run: node tests/coordination.unit.test.mjs
import { AGENTS, MAX_REPLANS_PER_CASE, MAX_TOOL_RETRIES, validateMessage } from "../tools/_lib/coordination.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${c ? "" : " — " + String(d).slice(0, 200)}`); c ? pass++ : fail++; };
const base = (over = {}) => ({
  sender_agent: "orchestrator", recipient_agent: "vendor_research", message_type: "task_assignment",
  objective: "Attach verified offers to known products.", payload: {}, evidence_refs: [], tool_calls: [], status: "sent",
  ...over,
});

// Agent role clarity: >=4 distinct agents, each with objective/tools/stopping/escalation
{
  const names = Object.keys(AGENTS).filter((n) => n !== "orchestrator");
  ok("agents:count", names.length >= 8, `only ${names.length}`);
  ok("agents:roles", names.every((n) => AGENTS[n].objective && AGENTS[n].objective.length > 10 && Array.isArray(AGENTS[n].tools) && AGENTS[n].stopping && AGENTS[n].escalation), "role incomplete");
  ok("agents:scoring-not-agent", !AGENTS.scoring_engine, "scoring engine must stay a deterministic component, not an agent");
}
// Loop/timeout/cost caps exist and are tight
{
  ok("caps:replans", MAX_REPLANS_PER_CASE === 1, "replan cap must be 1");
  ok("caps:retries", MAX_TOOL_RETRIES === 1, "tool retry cap must be 1");
}
// Valid messages accepted
{
  ok("msg:task", validateMessage(base()).valid, "rejected valid task");
  ok("msg:evidence", validateMessage(base({ sender_agent: "vendor_research", recipient_agent: "orchestrator", message_type: "evidence_report", tool_calls: [{ tool: "serpapiShoppingSearch", calls: 5 }] })).valid, "rejected valid evidence");
  ok("msg:revision", validateMessage(base({ sender_agent: "decision", recipient_agent: "vendor_research", message_type: "revision_request", requested_action: "targeted enrichment", reason: "rank-1 lacks offers" })).valid, "rejected valid revision");
  ok("msg:decision", validateMessage(base({ sender_agent: "decision", recipient_agent: "orchestrator", message_type: "decision", reason: "gates applied; INSUFFICIENT_DATA" })).valid, "rejected valid decision");
  ok("msg:escalation", validateMessage(base({ sender_agent: "decision", recipient_agent: "human", message_type: "escalation", requested_action: "record explicit decision", reason: "risks listed" })).valid, "rejected valid escalation");
  ok("msg:handoff", validateMessage(base({ sender_agent: "reevaluation", recipient_agent: "human", message_type: "handoff", requested_action: "review", reason: "re-scored" })).valid, "rejected valid handoff");
}
// Malformed / unsafe messages rejected
{
  ok("msg:unknown-sender", !validateMessage(base({ sender_agent: "price_inventor" })).valid, "accepted unknown agent");
  ok("msg:self-send", !validateMessage(base({ recipient_agent: "orchestrator" })).valid, "accepted self-send");
  ok("msg:unknown-type", !validateMessage(base({ message_type: "mind_meld" })).valid, "accepted unknown type");
  ok("msg:revision-no-reason", !validateMessage(base({ message_type: "revision_request", requested_action: "more", reason: "" })).valid, "accepted reasonless revision");
  ok("msg:revision-no-action", !validateMessage(base({ message_type: "revision_request", requested_action: "", reason: "because" })).valid, "accepted actionless revision");
  ok("msg:decision-no-reason", !validateMessage(base({ sender_agent: "decision", recipient_agent: "orchestrator", message_type: "decision", reason: "" })).valid, "accepted reasonless decision");
  ok("msg:bad-payload", !validateMessage(base({ payload: "just do it" })).valid, "accepted string payload");
  ok("msg:bad-tools", !validateMessage(base({ sender_agent: "review_quality", tool_calls: [{ tool: "send_email_to_vendor" }] })).valid, "accepted unpermitted tool");
  ok("msg:tool-no-name", !validateMessage(base({ tool_calls: [{ calls: 2 }] })).valid, "accepted nameless tool call");
  ok("msg:secret-reason", !validateMessage(base({ message_type: "decision", sender_agent: "decision", recipient_agent: "orchestrator", reason: "key tvly-abcdefgh1234 used" })).valid, "accepted secret in reason");
  ok("msg:secret-payload", !validateMessage(base({ payload: { k: "sk-ant-xyz1234567890" } })).valid, "accepted secret in payload");
  ok("msg:oversize", !validateMessage(base({ payload: { blob: "x".repeat(21000) } })).valid, "accepted oversize message");
  ok("msg:short-objective", !validateMessage(base({ objective: "go" })).valid, "accepted empty objective");
}

console.log(`\nCOORDINATION UNIT RESULTS: ${pass} PASS, ${fail} FAIL`);
if (fail) process.exit(1);
