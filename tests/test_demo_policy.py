"""BuyWise DEMO MODE policy tests — stdlib only, no credentials.
Run: python3 tests/test_demo_policy.py
Covers: demo labeling, REAL-mode safety, no-send, n8n demo wiring, migration 06.
"""
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
fails = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))
    if not cond: fails.append(name)

# --- 1. demo.js lib: labels + guards, no fakes ---
t = (ROOT / "tools/_lib/demo.js").read_text(encoding="utf-8")
check("demo:labels", "DEMO_HUMAN_ENTERED" in t and "LOCAL_DEMO_INPUT" in t)
check("demo:default-real", "REAL" in t)
doc = re.sub(r"no fake\w*|never \w* fake", "", t, flags=re.I)
check("demo:no-fake", not re.search(r"\bfake\b", doc, re.I))

# --- 2. Migration 06: additive, demo tables/columns/states ---
mig = (ROOT / "sql/06-demo-mode.sql").read_text(encoding="utf-8")
check("migration:demo-table", "CREATE TABLE IF NOT EXISTS demo_responses" in mig)
for c in ["demo_negotiating", "demo_response_received", "DEMO_READY_FOR_RESPONSE", "DEMO_RESPONSE_RECEIVED",
          "demo_mode_selected", "demo_negotiation_created", "demo_response_received", "demo_response_attached"]:
    check(f"migration:demo-token-{c}", c in mig)
check("migration:mode-default-real", "DEFAULT 'REAL'" in mig)
check("migration:no-destroy", "DROP TABLE" not in mig and "DELETE FROM" not in mig)

# --- 3. 75 form: no prepopulation, explicit labels ---
w75 = (ROOT / "n8n/workflows/75-demo-response.json").read_text(encoding="utf-8")
try:
    json.loads(w75); check("demo-form:json-valid", True)
except Exception as e: check("demo-form:json-valid", False, str(e))
check("demo-form:labels", "DEMO_HUMAN_ENTERED" in w75 and "NO MESSAGE SENT TO VENDOR" in w75)
check("demo-form:no-prefill", "defaultValue" not in w75)

# --- 4. 80-agent demo branch: REAL path intact, demo gated ---
w80 = (ROOT / "n8n/workflows/80-agent-reevaluation.json").read_text(encoding="utf-8")
check("reeval:demo-branch", "mode === 'DEMO'" in w80 or 'mode === "DEMO"' in w80)
check("reeval:real-rejects-demo", "demo response in REAL mode" in w80)
check("reeval:engine-still-twice", w80.count('"workflowId": "60-util-scoring-engine"') == 2)

# --- 5. Orchestrator demo path: explicit entry, no-send, converges to audit ---
orch = (ROOT / "n8n/workflows/00-orchestrator-buywise.json").read_text(encoding="utf-8")
for n in ["Demo Negotiation Webhook", "Build Demo Negotiation", "Op Set Demo Mode",
          "Op Persist Demo Negotiation", "Op Demo Negotiating", "Mark Demo Negotiating",
          "Op Fetch Demo Snapshot", "Op Create Approval"]:
    check(f"orchestrator:node-{n}", n in orch)
check("orchestrator:demo-explicit", "explicit mode=DEMO" in orch or "explicit DEMO" in orch)
check("orchestrator:real-untouched", "Call Reevaluation" in orch and "Reevaluated?" in orch)

# --- 6. State manager demo ops ---
sm = (ROOT / "n8n/workflows/90-util-state-manager.json").read_text(encoding="utf-8")
for op in ["insert_demo_responses", "set_case_mode"]:
    check(f"state-manager:op-{op}", op in sm)
check("state-manager:demo-statuses", "DEMO_READY_FOR_RESPONSE" in sm)
check("state-manager:demo-no-send", sm.count("do_not_send") >= 1)

# --- 7. Secret scan EXCLUDING .env ---
suspect = []
for f in list(ROOT.rglob("*.js")) + list(ROOT.rglob("*.json")) + list(ROOT.rglob("*.md")) + list(ROOT.rglob("*.sql")) + list(ROOT.rglob("*.py")):
    if ".git" in str(f) or "node_modules" in str(f): continue
    if f.name == ".env": continue
    try: tt = f.read_text(encoding="utf-8")
    except Exception: continue
    if re.search(r"\btvly-[A-Za-z0-9_-]{8,}\b", tt) and "INVALID-KEY-FOR-FAILURE-TEST" not in tt:
        suspect.append(str(f.relative_to(ROOT)))
check("secrets:clean-excl-env", not suspect, "; ".join(suspect[:5]))

print(f"\n{len(fails)} failures" if fails else "\nALL DEMO POLICY TESTS PASSED")
sys.exit(1 if fails else 0)
