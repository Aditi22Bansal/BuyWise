"""BuyWise Phase 1.5 offline tests — work WITHOUT credentials (stdlib only).
Run: python3 tests/test_phase15_offline.py
Covers: invalid prices (null/negative/NaN/non-numeric), LIVE-without-evidence
rejection, SQL literal escaping, currency preservation, duplicate-offer keys,
repo secret scan (no real key values committed).
"""
import json, math, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
fails = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))
    if not cond: fails.append(name)

# --- 1. Price validation (mirrors state-manager insert_offers guard) ---
def price_ok(unit_price, currency):
    if isinstance(unit_price, bool): return False
    if isinstance(unit_price, (int, float)):
        if isinstance(unit_price, float) and (math.isnan(unit_price) or math.isinf(unit_price)): return False
        return unit_price > 0 and bool(currency)
    return unit_price == "unavailable"  # only legal non-numeric value

check("price:null-rejected", not price_ok(None, "USD"))
check("price:negative-rejected", not price_ok(-5, "USD"))
check("price:zero-rejected", not price_ok(0, "USD"))
check("price:NaN-rejected", not price_ok(float("nan"), "USD"))
check("price:Inf-rejected", not price_ok(float("inf"), "USD"))
check("price:string-number-rejected", not price_ok("799", "USD"))
check("price:bool-rejected", not price_ok(True, "USD"))
check("price:no-currency-rejected", not price_ok(799, None))
check("price:valid-accepted", price_ok(799.99, "USD"))
check("price:unavailable-accepted", price_ok("unavailable", None))

# --- 2. LIVE records require full evidence ---
PLACEHOLDER_HOSTS = ("example.com", "example.org", "example.net", "test.invalid", "localhost")
def live_ok(rec):
    if rec.get("data_status") != "LIVE": return True
    url = rec.get("source_url", "")
    if not re.match(r"^https://", url): return False
    if any(h in url.lower() for h in PLACEHOLDER_HOSTS): return False
    return all(rec.get(k) not in (None, "", "unavailable") or k == "data"
               for k in ("source", "source_url", "retrieved_at"))

check("live:missing-url-rejected", not live_ok({"data_status": "LIVE", "source": "x", "retrieved_at": "t"}))
check("live:missing-source-rejected", not live_ok({"data_status": "LIVE", "source_url": "https://a.b", "retrieved_at": "t"}))
check("live:http-url-rejected", not live_ok({"data_status": "LIVE", "source": "x", "source_url": "http://a.b", "retrieved_at": "t"}))
check("live:example-url-rejected", not live_ok({"data_status": "LIVE", "source": "x", "source_url": "https://example.com/product", "retrieved_at": "t"}))
check("live:valid-accepted", live_ok({"data_status": "LIVE", "source": "ebay_browse_api", "source_url": "https://www.ebay.com/itm/123", "retrieved_at": "2026-10-08T00:00:00Z"}))
check("live:partial-not-subject", live_ok({"data_status": "PARTIAL"}))

# --- 3. SQL literal escaping (test harness persistence helper) ---
def sql_lit(s):
    return "'" + str(s).replace("'", "''") + "'"
check("sql:quote-escaped", sql_lit("O'Brien") == "'O''Brien'")
check("sql:injection-neutralized", "';" not in sql_lit("x'; DROP TABLE offers;--").replace("''", ""))

# --- 4. Currency preserved, never converted without FX ---
def converted_value(price, from_cur, to_cur, fx_configured=False):
    if from_cur == to_cur: return price
    return "unavailable" if not fx_configured else round(price * 83.0, 2)
check("fx:usd-inr-stays-unavailable", converted_value(100, "USD", "INR") == "unavailable")
check("fx:same-currency-passthrough", converted_value(100, "USD", "USD") == 100)

# --- 5. Duplicate-offer key = (procurement, product, vendor, source_url) ---
def offer_key(o): return (o["procurement_id"], o["product_id"], o["vendor_id"], o["source_url"])
a = {"procurement_id": "p", "product_id": "x", "vendor_id": "v1", "source_url": "https://s/1"}
b = dict(a); c = dict(a, vendor_id="v2")
check("offers:exact-dup-detected", offer_key(a) == offer_key(b))
check("offers:diff-vendor-not-dup", offer_key(a) != offer_key(c))

# --- 6. Repo secret scan: no real key VALUES in tracked content ---
suspect = []
keyed = re.compile(r"(TAVILY_API_KEY|EBAY_APP_ID|EBAY_CERT_ID|SERPAPI_API_KEY|YELP_API_KEY)[ \t]*=[ \t]*['\"]?([^ \t\r\n'\"}=]+)['\"]?")
token = re.compile(r"\b(tvly-[A-Za-z0-9]{8,}|re_[A-Za-z0-9]{8,}|sk-ant-[A-Za-z0-9-]{8,})\b")
for f in list(ROOT.rglob("*.js")) + list(ROOT.rglob("*.json")) + list(ROOT.rglob("*.md")) + list(ROOT.rglob("*.sql")) + list(ROOT.rglob("*.py")) + [ROOT / ".env.example"]:
    if ".git" in str(f) or "node_modules" in str(f): continue
    if f.name == ".env": continue  # REQUIRED: never read .env during scans (rotated key)
    try: t = f.read_text(encoding="utf-8")
    except Exception: continue
    for m in keyed.finditer(t):
        val = m.group(2).strip()
        if val and val not in ("", "configured", "absent") and not val.startswith("<") and not val.startswith("${"):
            # .env.example must keep placeholders EMPTY
            suspect.append(f"{f.relative_to(ROOT)}: {m.group(1)} has non-placeholder value")
    for m in token.finditer(t):
        if "INVALID-KEY-FOR-FAILURE-TEST" not in m.group(0): suspect.append(f"{f.relative_to(ROOT)}: embedded token-like value")
check("secrets:none-committed", not suspect, "; ".join(suspect[:5]))

print(f"\n{len(fails)} failures" if fails else "\nALL PHASE 1.5 OFFLINE TESTS PASSED")
sys.exit(1 if fails else 0)
