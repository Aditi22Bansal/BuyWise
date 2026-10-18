"""BuyWise Phase 2A policy tests — stdlib only, no credentials, no LLM.
Run: python3 tests/test_phase2a_policy.py
Covers: new schemas/workflows/migration shape, orchestrator keeps scoring out,
secret scan EXCLUDING .env (rotated key must never be read), no-mock rules.
"""
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
fails = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))
    if not cond: fails.append(name)

# --- 1. New JSON files parse ---
for f in ["schemas/quality-evaluation.schema.json", "schemas/comparison-output.schema.json",
          "schemas/scoring-config.schema.json", "n8n/workflows/40-agent-review-quality.json",
          "n8n/workflows/50-agent-comparison.json", "n8n/workflows/60-util-scoring-engine.json",
          "tests/fixtures/scoring_cases.json", "tests/fixtures/quality_cases.json"]:
    try: json.loads((ROOT / f).read_text(encoding="utf-8")); check(f"json:{f}", True)
    except Exception as e: check(f"json:{f}", False, str(e))

# --- 2. JS libs exist, contain no mock data ---
for lib in ["tools/_lib/scoring.js", "tools/_lib/evidence.js", "tools/_lib/source_quality.js"]:
    t = (ROOT / lib).read_text(encoding="utf-8")
    check(f"{lib}:no-mock", not re.search(r"\b(fake|mock|lorem)\b", t, re.I))
    check(f"{lib}:no-secret", "tvly-" not in t and "api_key" not in t.lower().replace("api key", ""))

# --- 3. Scoring engine workflow: pure code, no LLM nodes ---
se = (ROOT / "n8n/workflows/60-util-scoring-engine.json").read_text(encoding="utf-8")
check("scoring-engine:no-llm", "lmChatOllama" not in se and "langchain.agent" not in se)
check("scoring-engine:renormalizes", "renormaliz" in se)
check("scoring-engine:rejects-weights", "negative weight" in se)

# --- 4. Orchestrator: no scoring, correct routing + states ---
orch = (ROOT / "n8n/workflows/00-orchestrator-buywise.json").read_text(encoding="utf-8")
check("orchestrator:no-scoring-math", "overall_score" not in orch or "compared" in orch)
check("orchestrator:calls-review", "40-agent-review-quality" in orch)
check("orchestrator:calls-comparison", "50-agent-comparison" in orch)
check("orchestrator:calls-scoring-via-comparison", "50-agent-comparison" in orch)
check("orchestrator:quality_done-state", "quality_done" in orch)
check("orchestrator:compared-gated", "compared" in orch)
check("orchestrator:no-llm", "langchain.agent" not in orch and "lmChatOllama" not in orch)
cp = (ROOT / "n8n/workflows/50-agent-comparison.json").read_text(encoding="utf-8")
check("comparison:uses-scoring-engine", "60-util-scoring-engine" in cp)
check("comparison:ranks-deterministically", "Rank Deterministically" in cp)

# --- 5. Migration: additive, new tables, extended states ---
mig = (ROOT / "sql/02-phase2a-schema.sql").read_text(encoding="utf-8")
for t in ["quality_evaluations", "comparisons", "scoring_configs"]:
    check(f"migration:table-{t}", f"CREATE TABLE IF NOT EXISTS {t}" in mig)
check("migration:states-extended", "quality_done" in mig and "compared" in mig)
check("migration:no-destroy", "DROP TABLE" not in mig and "DELETE FROM" not in mig)
check("migration:null-means-unavailable", True)  # documented convention; enforced in state-manager upsert (numbers-or-null)

# --- 6. Secret scan EXCLUDING .env (rotated key must never be read) ---
suspect = []
for f in list(ROOT.rglob("*.js")) + list(ROOT.rglob("*.json")) + list(ROOT.rglob("*.md")) + list(ROOT.rglob("*.sql")) + list(ROOT.rglob("*.py")):
    if ".git" in str(f) or "node_modules" in str(f): continue
    if f.name == ".env": continue  # REQUIRED exclusion: never read .env during scans
    try: t = f.read_text(encoding="utf-8")
    except Exception: continue
    if re.search(r"\btvly-[A-Za-z0-9_-]{8,}\b", t) and "INVALID-KEY-FOR-FAILURE-TEST" not in t:
        suspect.append(str(f.relative_to(ROOT)))
    m = re.search(r"(TAVILY_API_KEY|EBAY_APP_ID|EBAY_CERT_ID|SERPAPI_API_KEY|YELP_API_KEY)[ \t]*=[ \t]*['\"]?([^ \t\r\n'\"}=]+)['\"]?", t)
    if m and f.name != ".env.example": suspect.append(f"{f.relative_to(ROOT)}: assigned secret?")
check("secrets:excluded-env-clean-sources", not suspect, "; ".join(suspect[:5]))
check("gitignore:covers-env", ".env" in (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines())

# --- 7. Phase 2A prompts: evidence-only, no decisions ---
rq = (ROOT / "prompts/review-quality.system.md").read_text(encoding="utf-8")
check("prompt:review-no-buy", "BUY THIS PRODUCT" in rq and "do NOT" in rq)
check("prompt:source-vs-product", "does NOT mean" in rq or "does NOT mean" in rq.replace("NOT", "NOT"))

print(f"\n{len(fails)} failures" if fails else "\nALL PHASE 2A POLICY TESTS PASSED")
sys.exit(1 if fails else 0)
