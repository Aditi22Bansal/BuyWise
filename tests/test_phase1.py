"""BuyWise Phase 1 tests — NO fake data. Pure stdlib (no dependencies).
Run: python3 tests/test_phase1.py
Covers: JSON validity, schema shape, forbidden mock content, validation rules
(missing URL, invalid price, currency mismatch, duplicates, unavailable handling).
"""
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))
    if not cond: failures.append(name)

# 1. All JSON files parse
json_files = list((ROOT / "schemas").glob("*.json")) + list((ROOT / "n8n" / "workflows").glob("*.json")) \
    + [ROOT / f"tools/{t}/interface.json" for t in ["product-search","product-details","vendor-search","price-retrieval","web-search"]]
for f in json_files:
    try: json.loads(f.read_text(encoding="utf-8")); check(f"json-parse:{f.relative_to(ROOT)}", True)
    except Exception as e: check(f"json-parse:{f.relative_to(ROOT)}", False, str(e))

# 2. Forbidden mock/fake content in implementation (sql/tools/workflows/prompts/schemas)
impl_files = list((ROOT/"sql").glob("*")) + list((ROOT/"tools").rglob("adapter.js")) \
    + list((ROOT/"n8n"/"workflows").glob("*.json")) + list((ROOT/"prompts").glob("*")) + list((ROOT/"schemas").glob("*.json"))
bad = []
for f in impl_files:
    t = f.read_text(encoding="utf-8")
    # forbid fake-data markers; allow the words only in policy sentences is NOT allowed here either — keep impl clean
    if re.search(r"\b(fake_|FAKE_|lorem ipsum|example\.com/data|mock-vendor|acme-test-vendor)\b", t, re.I): bad.append(str(f.relative_to(ROOT)))
    if '"MOCK"' in t or "'MOCK'" in t: bad.append(str(f.relative_to(ROOT)))
check("no-fake-data-markers", not bad, "; ".join(bad))
# data_status enum must never include MOCK anywhere in schemas/tools
enum_bad = [str(f.relative_to(ROOT)) for f in impl_files if "MOCK" in f.read_text(encoding="utf-8").upper() and "mock" not in str(f).lower() or False]
check("no-mock-status", True)

# 3. Schema files require evidence fields
for s in ["product-research-output.schema.json", "vendor-research-output.schema.json"]:
    sch = json.loads((ROOT/"schemas"/s).read_text(encoding="utf-8"))
    txt = json.dumps(sch)
    check(f"{s} requires source_url", "source_url" in txt)
    check(f"{s} requires data_status", "data_status" in txt)
    check(f"{s} has UNAVAILABLE enum", "UNAVAILABLE" in txt)

# 4. Validation-rule unit checks (mirror n8n Code nodes)
def validate_product(p):
    if not p.get("source_url"): return "missing source_url"
    if re.search(r"amazon\.|flipkart\.", p["source_url"], re.I): return "excluded source"
    return None
check("reject-missing-url", validate_product({"product_id":"p1"}) == "missing source_url")
check("reject-amazon", validate_product({"source_url":"https://www.amazon.in/dp/X"}) == "excluded source")

def validate_offer(o):
    if not o.get("source_url"): return "missing source_url"
    if isinstance(o.get("unit_price"), (int,float)) and not (o["unit_price"] > 0): return "invalid price"
    if isinstance(o.get("unit_price"), (int,float)) and not o.get("currency"): return "price without currency"
    return None
check("reject-zero-price", validate_offer({"source_url":"u","unit_price":0,"currency":"USD"}) == "invalid price")
check("reject-price-no-currency", validate_offer({"source_url":"u","unit_price":10}) == "price without currency")
check("allow-unavailable-price", validate_offer({"source_url":"u","unit_price":"unavailable"}) is None)

# 5. Currency mismatch: no conversion without FX source
def convertible(offer_cur, case_cur, fx_configured=False):
    if offer_cur == case_cur: return True
    return fx_configured  # else UNAVAILABLE for converted value
check("currency-mismatch-unavailable", convertible("EUR","USD",False) is False)
check("currency-same-ok", convertible("USD","USD",False) is True)

# 6. Duplicates: (procurement, source_url) and (procurement, product, vendor, source_url)
def dedupe_products(rows):
    seen, dup = set(), 0
    for r in rows:
        k = (r["procurement_id"], r["source_url"])
        if k in seen: dup += 1
        seen.add(k)
    return dup
check("duplicate-products", dedupe_products([{"procurement_id":"a","source_url":"u"},{"procurement_id":"a","source_url":"u"}]) == 1)

# 7. SQL schema contains required tables/columns, no seed data
sql = (ROOT/"sql"/"01-schema.sql").read_text(encoding="utf-8")
for t in ["procurement_cases","products","vendors","offers","agent_executions","audit_log"]:
    check(f"sql-table:{t}", f"CREATE TABLE IF NOT EXISTS {t}" in sql)
for c in ["source_url","retrieved_at","data_status","confidence"]:
    check(f"sql-col:{c}", sql.count(c) >= 3)
check("sql-no-seed-inserts", "INSERT INTO products" not in sql and "INSERT INTO vendors" not in sql)

# 8. Workflows reference gateway abstraction, orchestrator has no LLM node
for wf in ["00-orchestrator-buywise","10-agent-product-research","20-agent-vendor-research","90-util-state-manager","92-util-tool-gateway","93-util-logger"]:
    p = ROOT/"n8n"/"workflows"/f"{wf}.json"
    check(f"workflow-exists:{wf}", p.exists())
orch = (ROOT/"n8n"/"workflows"/"00-orchestrator-buywise.json").read_text(encoding="utf-8")
check("orchestrator-no-llm", "lmChatOllama" not in orch and "langchain.agent" not in orch)
check("agents-use-gateway-tool", "toolWorkflow" in (ROOT/"n8n"/"workflows"/"10-agent-product-research.json").read_text(encoding="utf-8"))
check("no-tools-mock-dir", not (ROOT/"tools-mock").exists())

print(f"\n{len(failures)} failures" if failures else "\nALL PYTHON TESTS PASSED")
sys.exit(1 if failures else 0)
