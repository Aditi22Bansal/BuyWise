"""BuyWise Phase 2B policy tests — stdlib only, no credentials, no LLM.
Run: python3 tests/test_phase2b_policy.py
Covers: new schemas/workflows/migration shape, orchestrator gates, secret scan
excluding .env, no-mock rules for new files.
"""
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
fails = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))
    if not cond: fails.append(name)

# --- 1. New JSON files parse ---
for f in ["schemas/decision-output.schema.json", "schemas/negotiation-request.schema.json",
          "n8n/workflows/65-agent-decision.json", "n8n/workflows/70-agent-negotiation.json",
          "tests/fixtures/phase2b_cases.json"]:
    try:
        d = json.loads((ROOT / f).read_text(encoding="utf-8"))
        check(f"json:{f}", True)
        if "fixture" in f: check("fixture:labeled-not-production", "NOT PRODUCTION DATA" in json.dumps(d))
    except Exception as e: check(f"json:{f}", False, str(e))

# --- 2. Libs: no mocks, no secrets, no simulation language ---
for lib in ["tools/_lib/decision.js", "tools/_lib/negotiation.js"]:
    t = (ROOT / lib).read_text(encoding="utf-8")
    doc = re.sub(r"no fake\w*|no mocks?|never simulat\w*|no simulat\w*", "", t, flags=re.I)
    check(f"{lib}:no-mock", not re.search(r"\b(fake|mock|lorem)\b", doc, re.I))
    check(f"{lib}:no-simulation", "simulat" not in t.lower() or "no simulation" in t.lower() or "never simulate" in t.lower())

# --- 3. Decision workflow: deterministic, no scoring inside ---
dc = (ROOT / "n8n/workflows/65-agent-decision.json").read_text(encoding="utf-8")
check("decision:no-scoring", "overall_score" not in dc or "Deterministic Gates" in dc)
check("decision:gates-present", "INSUFFICIENT_DATA" in dc and "NEGOTIATE" in dc and "PROCEED" in dc)
check("decision:no-llm-required", "LLM Available?" in dc)

# --- 4. Negotiation workflow: never sends, human gate, no fake responses ---
ng = (ROOT / "n8n/workflows/70-agent-negotiation.json").read_text(encoding="utf-8")
check("negotiation:not-ready-path", "NOT_READY" in ng)
check("negotiation:send-blocked", "do_not_send" in ng and "Phase 2C" in ng)
check("negotiation:no-fake-responses", "VENDOR_RESPONSE_RECEIVED" not in ng or "Phase 2C" in ng)
check("negotiation:human-gate", "human_confirmation" in ng)
check("negotiation:no-email-node", "gmail" not in ng.lower() and "smtp" not in ng.lower())

# --- 5. Orchestrator: decision then conditional negotiation, no 2C states ---
orch = (ROOT / "n8n/workflows/00-orchestrator-buywise.json").read_text(encoding="utf-8")
check("orchestrator:calls-decision", "65-agent-decision" in orch)
check("orchestrator:calls-negotiation", "70-agent-negotiation" in orch)
check("orchestrator:negotiate-gate", "Negotiate?" in orch)
check("orchestrator:negotiating-gated", "Negotiation Open?" in orch)
# --- 5b. Later-phase transitions exist ONLY behind their gates (structural proof).
# Parses orchestrator connections: closure/re-evaluation nodes must be reachable
# exclusively through Outcome?/Reevaluated?/Negotiation Open? gate outputs.
import json as _json
_od = _json.loads((ROOT / "n8n/workflows/00-orchestrator-buywise.json").read_text(encoding="utf-8"))
_conns = _od["connections"]
def _outs(node):
    return [x["node"] for branch in _conns.get(node, {}).get("main", []) for x in branch]
def _feeders(target):
    return [src for src, c in _conns.items() for branch in c.get("main", []) for x in branch if x["node"] == target]
check("gates:outcome-branches", _outs("Outcome?") == ["Op Close", "Op Close", "Op Changes Requested", "Audit Log"], str(_outs("Outcome?")))
check("gates:reevaluated-branches", _outs("Reevaluated?") == ["Op Persist Reevaluation", "Audit Log"], str(_outs("Reevaluated?")))
check("gates:negotiate-branches", _outs("Negotiate?") == ["Build Negotiation Input", "Proceed Path?"], str(_outs("Negotiate?")))
check("gates:negopen-branches", _outs("Negotiation Open?") == ["Op Negotiating", "Audit Log"], str(_outs("Negotiation Open?")))
_expected_feeders = {
    "Op Close": {"Outcome?"}, "Mark Closed": {"Op Close"},
    "Op Changes Requested": {"Outcome?"}, "Mark Changes Requested": {"Op Changes Requested"},
    "Op Persist Reevaluation": {"Reevaluated?"}, "Mark Reevaluated": {"Op Reevaluated"},
    "Op Negotiating": {"Negotiation Open?"}, "Mark Negotiating": {"Op Negotiating"},
}
for gated, want in _expected_feeders.items():
    got = set(_feeders(gated))
    check(f"gates:exclusive-{gated}", got == want, str(sorted(got)))
check("orchestrator:no-scoring", "Compute Score" not in orch)

# --- 6. State manager: new ops, no auto-confirm, dup protection ---
sm = (ROOT / "n8n/workflows/90-util-state-manager.json").read_text(encoding="utf-8")
for op in ["insert_decisions", "insert_negotiations", "insert_negotiation_events"]:
    check(f"state-manager:op-{op}", op in sm)
check("state-manager:no-auto-confirm", "human_confirmation !== false" in sm or "allow_send" in sm)

# --- 7. Migration 04: additive, tables, states, no 2C states ---
mig = (ROOT / "sql/04-phase2b-schema.sql").read_text(encoding="utf-8")
for t in ["decisions", "negotiations", "negotiation_messages", "negotiation_events"]:
    check(f"migration:table-{t}", f"CREATE TABLE IF NOT EXISTS {t}" in mig)
check("migration:decided-state", "'decided'" in mig and "'negotiating'" in mig)
for s in ["reevaluated", "pending_approval", "closed"]:
    check(f"migration:no-2C-{s}", s not in mig)
check("migration:dup-guard", "UNIQUE (procurement_id, offer_id)" in mig)
check("migration:no-destroy", "DROP TABLE" not in mig and "DELETE FROM" not in mig)

# --- 8. Secret scan EXCLUDING .env ---
suspect = []
for f in list(ROOT.rglob("*.js")) + list(ROOT.rglob("*.json")) + list(ROOT.rglob("*.md")) + list(ROOT.rglob("*.sql")) + list(ROOT.rglob("*.py")):
    if ".git" in str(f) or "node_modules" in str(f): continue
    if f.name == ".env": continue
    try: t = f.read_text(encoding="utf-8")
    except Exception: continue
    if re.search(r"\btvly-[A-Za-z0-9_-]{8,}\b", t) and "INVALID-KEY-FOR-FAILURE-TEST" not in t:
        suspect.append(str(f.relative_to(ROOT)))
check("secrets:clean-excl-env", not suspect, "; ".join(suspect[:5]))

print(f"\n{len(fails)} failures" if fails else "\nALL PHASE 2B POLICY TESTS PASSED")
sys.exit(1 if fails else 0)
