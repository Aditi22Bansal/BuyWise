// BuyWise LLM provider unit tests. All LLM calls use injected mock fetch;
// no network, no credentials, never LIVE. Run: node tests/llm.unit.test.mjs
import { getLLMConfig, systemReasoningMode, chatJSON, validateAdvisory, buildDecisionPrompt, buildComparisonPrompt } from "../tools/_lib/llm.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${c ? "" : " — " + String(d).slice(0, 200)}`); c ? pass++ : fail++; };
const ENV_OFF = {};
const ENV_ON = { LLM_PROVIDER: "openai-compatible", LLM_API_URL: "https://llm.example/v1", LLM_API_KEY: "test-key-material", LLM_MODEL: "test-model" };
const mockOk = (obj) => async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(obj) } }] }) });

// Config / mode detection (no key material in config)
{
  const off = getLLMConfig(ENV_OFF);
  ok("llm:unconfigured", off.configured === false && off.provider === "none", JSON.stringify(off));
  ok("llm:mode-unavailable", systemReasoningMode(ENV_OFF) === "LLM_UNAVAILABLE", "wrong mode");
  const on = getLLMConfig(ENV_ON);
  ok("llm:configured", on.configured === true && on.provider === "openai-compatible" && on.model === "test-model", JSON.stringify({ ...on }));
  ok("llm:mode-reasoning", systemReasoningMode(ENV_ON) === "LLM_REASONING", "wrong mode");
  ok("llm:no-key-in-config", !JSON.stringify(on).includes("test-key-material"), "key material leaked in config");
  ok("llm:partial-rejected", getLLMConfig({ ...ENV_ON, LLM_API_KEY: "" }).configured === false, "accepted keyless config");
}
// Successful structured call
{
  const cfg = getLLMConfig(ENV_ON);
  let seenUrl = "", seenAuth = "";
  const fetchImpl = async (url, opts) => {
    seenUrl = url; seenAuth = opts.headers.Authorization;
    if (opts.body.includes("test-key-material")) throw new Error("key must travel only in header");
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"role":"r","task":"t"}' } }] }) };
  };
  const out = await chatJSON({ system: "s", user: "u", config: cfg, env: ENV_ON, fetchImpl });
  ok("llm:success", out.role === "r" && seenUrl === "https://llm.example/v1/chat/completions" && seenAuth === "Bearer test-key-material", "bad call shape");
}
// Failure modes (mocked): malformed, empty, http error, timeout, unconfigured
{
  const cfg = getLLMConfig(ENV_ON);
  const bad = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "not json {" } }] }) });
  let threw = "";
  try { await chatJSON({ system: "s", user: "u", config: cfg, env: ENV_ON, fetchImpl: bad }); } catch (e) { threw = e.message; }
  ok("llm:malformed", threw.includes("malformed"), threw);
  const empty = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "" } }] }) });
  threw = "";
  try { await chatJSON({ system: "s", user: "u", config: cfg, env: ENV_ON, fetchImpl: empty }); } catch (e) { threw = e.message; }
  ok("llm:empty", threw.includes("empty"), threw);
  const http500 = async () => ({ ok: false, status: 500, json: async () => ({}) });
  threw = "";
  try { await chatJSON({ system: "s", user: "u", config: cfg, env: ENV_ON, fetchImpl: http500 }); } catch (e) { threw = e.message; }
  ok("llm:http-error", threw.includes("http 500"), threw);
  const hanging = (url, opts) => new Promise((_, rej) => opts.signal.addEventListener("abort", () => rej(new Error("timeout"))));
  const t0 = Date.now();
  threw = "";
  try { await chatJSON({ system: "s", user: "u", config: cfg, env: ENV_ON, timeoutMs: 60, fetchImpl: hanging }); } catch (e) { threw = e.message; }
  ok("llm:timeout", threw.includes("failed") && Date.now() - t0 < 5000, threw);
  threw = "";
  try { await chatJSON({ system: "s", user: "u", config: getLLMConfig(ENV_OFF), env: ENV_OFF, fetchImpl: mockOk({}) }); } catch (e) { threw = e.message; }
  ok("llm:no-creds", threw.includes("unavailable"), threw);
  ok("llm:errors-redacted", !threw.includes("test-key") && !(await (async () => { try { await chatJSON({ system: "s", user: "u", config: cfg, env: ENV_ON, fetchImpl: async () => { throw new Error("boom sk-ant-secretkey123456"); } }); return ""; } catch (e) { return e.message; } })()).includes("secretkey"), "secret in error");
}
// Advisory contract validation
{
  const good = { role: "Decision advisor", task: "Evaluate evidence", evidence_considered: ["rank-1"], reasoning_summary: "Offers cover rank-1; mandatory specs unverified.", missing_info: ["ram spec"], uncertainties: ["contact channel"], proposed_action: "escalate_human", handoff_request: null, completion: "escalate" };
  ok("adv:valid", validateAdvisory(good, "decision").valid, "rejected valid");
  ok("adv:bad-action", !validateAdvisory({ ...good, proposed_action: "approve_purchase" }, "decision").valid, "accepted rogue action");
  ok("adv:wrong-kind", !validateAdvisory({ ...good, proposed_action: "accept_ranking" }, "decision").valid, "accepted cross-kind action");
  ok("adv:no-summary", !validateAdvisory({ ...good, reasoning_summary: "x" }).valid, "accepted thin summary");
  ok("adv:bad-handoff-agent", !validateAdvisory({ ...good, handoff_request: { agent: "price_inventor", action: "get prices", reason: "need them" } }).valid, "accepted unknown handoff agent");
  ok("adv:bad-handoff-reason", !validateAdvisory({ ...good, handoff_request: { agent: "vendor_research", action: "search", reason: "x" } }).valid, "accepted thin handoff reason");
  ok("adv:bad-completion", !validateAdvisory({ ...good, completion: "maybe" }).valid, "accepted bad completion");
  ok("adv:non-object", !validateAdvisory("do it", "decision").valid, "accepted string advisory");
  const cg = { ...good, proposed_action: "flag_conflicts" };
  ok("adv:comparison-kind", validateAdvisory(cg, "comparison").valid, "rejected valid comparison advisory");
}
// Prompt builders produce bounded prompts referencing only supplied evidence
{
  const p = buildDecisionPrompt({ requirement: "laptops", rankedTop: [{ rank: 1 }], blocking: ["x"], offersCount: 3, mode: "REAL" });
  ok("prompt:decision-shape", typeof p.system === "string" && typeof p.user === "string" && p.user.includes("laptops") && p.user.length < 4000, "bad prompt");
  const q = buildComparisonPrompt({ rankedCount: 5, conflicts: [], unofferedTop: [], criteriaUsed: ["source_quality"] });
  ok("prompt:comparison-shape", q.user.includes("source_quality"), "bad prompt");
}

console.log(`\nLLM UNIT RESULTS: ${pass} PASS, ${fail} FAIL`);
if (fail) process.exit(1);
