"""BuyWise Phase 2C policy tests — stdlib only, no credentials, no LLM.
Run: python3 tests/test_phase2c_policy.py
Covers: new schemas/workflows/migration, orchestrator 2C routing without auto-pilot,
no purchasing nodes, secret scan excluding .env.
"""
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
fails = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))
    if not cond: fails.append(name)

# --- 1. New JSON files parse ---
for f in ["schemas/reevaluation-output.schema.json", "schemas/approval-package.schema.json",
          "n8n/workflows/80-agent-reevaluation.json", "n8n/workflows/90-agent-approval.json",
          "tests/fixtures/phase2c_cases.json"]:
    try:
        d = json.loads((ROOT / f).read_text(encoding="utf-8"))
        check(f"json:{f}", True)
        if "fixture" in f: check("fixture:labeled-not-production", "NOT PRODUCTION DATA" in json.dumps(d))
    except Exception as e: check(f"json:{f}", False, str(e))

# --- 2. Libs: no fakes, scoring reused not duplicated ---
re_lib = (ROOT / "tools/_lib/reevaluation.js").read_text(encoding="utf-8")
doc = re.sub(r"no fake\w*|never \w* fake", "", re_lib, flags=re.I)
check("reeval:no-fake", not re.search(r"\bfake\b", doc, re.I))
check("reeval:reuses-engine", 'from "./scoring.js"' in re_lib and "score(" in re_lib)
check("reeval:no-own-math", "overall_score" not in re_lib or "before.overall_score" in re_lib)
ap_lib = (ROOT / "tools/_lib/approval.js").read_text(encoding="utf-8")
ap_doc = re.sub(r"[Nn]o [^.\n]+", "", ap_lib)
check("approval:no-purchasing", not re.search(r"purchase order|[^_]payment[^_]|checkout|place order|buy now", ap_doc, re.I))
check("approval:actor-not-hardcoded", "PLACEHOLDER_ACTORS" in ap_lib and not re.search(r"""[:=]\s*["'](?:manager|admin|priya|test user)["']""", ap_lib, re.I))

# --- 3. 80-agent: engine reused twice, gates, no LLM ---
w80 = (ROOT / "n8n/workflows/80-agent-reevaluation.json").read_text(encoding="utf-8")
check("reeval:calls-engine-twice", w80.count('"workflowId": "60-util-scoring-engine"') == 2)
check("reeval:waiting-path", "WAITING_FOR_VENDOR" in w80 and "NOT_ELIGIBLE" in w80)
check("reeval:no-llm", "lmChatOllama" not in w80 and "langchain.agent" not in w80)
check("reeval:rejects-malformed", "rejected" in w80.lower())

# --- 4. 90-agent: HITL wait, strict validation, no auto-approve ---
w90 = (ROOT / "n8n/workflows/90-agent-approval.json").read_text(encoding="utf-8")
check("approval:hitl-wait", '"n8n-nodes-base.wait"' in w90)
check("approval:default-pending", "PENDING_APPROVAL" in w90)
check("approval:strict-outcomes", "CHANGES_REQUESTED" in w90)
check("approval:no-auto", "never approval" in w90.lower())
check("approval:no-llm", "lmChatOllama" not in w90 and "langchain.agent" not in w90)
check("approval:no-purchasing-nodes", not re.search(r"gmail|smtp|stripe|paypal|checkout", w90, re.I))

# --- 5. Orchestrator: 2C routing, gated closure, snapshot reads ---
orch = (ROOT / "n8n/workflows/00-orchestrator-buywise.json").read_text(encoding="utf-8")
for n in ["Call Reevaluation", "Call Approval (waits for human)", "Vendor Response Webhook", "Fetch Snapshot", "Outcome?"]:
    check(f"orchestrator:node-{n}", n in orch)
check("orchestrator:reevaluated-gated", "Reevaluated?" in orch)
check("orchestrator:changes-path", "Mark Changes Requested" in orch)
check("orchestrator:auto-close-flagged", "auto_close_on_proceed" in orch)
orch_doc = re.sub(r"[Nn]o [^.\n]+", "", orch)
check("orchestrator:no-auto-purchase", not re.search(r"purchase order|[^_]payment[^_]|checkout|place order|buy now", orch_doc, re.I))

# --- 6. State manager: 2C ops + snapshot ---
sm = (ROOT / "n8n/workflows/90-util-state-manager.json").read_text(encoding="utf-8")
for op in ["insert_reevaluations", "insert_approvals", "update_approval", "insert_approval_events", "fetch_snapshot"]:
    check(f"state-manager:op-{op}", op in sm)

# --- 7. Migration 05 ---
mig = (ROOT / "sql/05-phase2c-schema.sql").read_text(encoding="utf-8")
for t in ["reevaluations", "approvals", "approval_events"]:
    check(f"migration:table-{t}", f"CREATE TABLE IF NOT EXISTS {t}" in mig)
for s in ["'reevaluated'", "'pending_approval'", "'changes_requested'", "'closed'"]:
    check(f"migration:state-{s}", s in mig)
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

print(f"\n{len(fails)} failures" if fails else "\nALL PHASE 2C POLICY TESTS PASSED")
sys.exit(1 if fails else 0)
