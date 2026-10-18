"""BuyWise provider-upgrade policy tests — stdlib only, no credentials.
Run: python3 tests/test_provider_policy.py
Covers: SerpAPI adapter files, eBay inactivation, gateway wiring, compose/env,
prompt strategy, secret scan excluding .env.
"""
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
fails = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))
    if not cond: fails.append(name)

# --- 1. New files parse/exist ---
for f in ["tests/fixtures/serpapi_cases.json"]:
    try:
        d = json.loads((ROOT / f).read_text(encoding="utf-8"))
        check(f"json:{f}", True)
        check("fixture:labeled", "NOT PRODUCTION DATA" in json.dumps(d))
    except Exception as e: check(f"json:{f}", False, str(e))
for f in ["tools/product-search/serpapi-shopping.js", "tools/_lib/commercial.js"]:
    check(f"exists:{f}", (ROOT / f).exists())

# --- 2. SerpAPI adapter: env-only key, error mapping, no mocks ---
src = (ROOT / "tools/product-search/serpapi-shopping.js").read_text(encoding="utf-8")
check("serpapi:key-from-env", 'requireEnv("SERPAPI_API_KEY"' in src)
check("serpapi:http-mapping", "401" in src and "429" in src)
check("serpapi:no-mock", not re.search(r"\b(fake|mock|lorem)\b", re.sub(r"no fake\w*", "", src, flags=re.I), re.I))
check("serpapi:no-fx", not re.search(r"exchangerate|frankfurter|currencylayer|\*\s*83", src, re.I))

# --- 3. eBay inactive by default, retained not deleted ---
for f in ["tools/product-search/adapter.js", "tools/vendor-search/adapter.js",
          "tools/price-retrieval/adapter.js", "tools/product-details/adapter.js"]:
    t = (ROOT / f).read_text(encoding="utf-8")
    check(f"{f}:ebay-gated", "EBAY_ENABLED" in t)
check("ebay:code-retained", "ebayToken" in (ROOT / "tools/product-search/adapter.js").read_text(encoding="utf-8"))

# --- 4. Gateway: SerpAPI wired, eBay disconnected + marked ---
gw = (ROOT / "n8n/workflows/92-util-tool-gateway.json").read_text(encoding="utf-8")
try:
    g = json.loads(gw); check("gateway:json-valid", True)
    names = [n["name"] for n in g["nodes"]]
    check("gateway:serpapi-node", "SerpAPI Shopping" in names)
    check("gateway:ebay-inactive-label", any("INACTIVE" in n for n in names))
    outs = [x["node"] for branch in g["connections"]["Switch by Tool"]["main"] for x in branch]
    check("gateway:branches-use-serpapi", outs.count("SerpAPI Shopping") == 3, str(outs))
    check("gateway:ebay-disconnected", "eBay OAuth Token [INACTIVE]" not in outs and "eBay Browse Search [INACTIVE]" not in outs, str(outs))
except Exception as e: check("gateway:json-valid", False, str(e))

# --- 5. Compose + env example ---
comp = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
check("compose:serpapi-passthrough", "SERPAPI_API_KEY" in comp)
check("compose:ebay-flag", "EBAY_ENABLED" in comp)
envx = (ROOT / ".env.example").read_text(encoding="utf-8")
check("env:serpapi-placeholder", "SERPAPI_API_KEY=" in envx)
check("env:ebay-not-required-note", "NOT REQUIRED" in envx)

# --- 6. Prompts reflect strategy ---
for p in ["prompts/product-research.system.md", "prompts/vendor-research.system.md"]:
    t = (ROOT / p).read_text(encoding="utf-8")
    check(f"{p}:serpapi", "SerpAPI" in t)
    check(f"{p}:ebay-inactive", "NOT REQUIRED" in t or "inactive" in t)

# --- 7. Secret scan EXCLUDING .env ---
suspect = []
for f in list(ROOT.rglob("*.js")) + list(ROOT.rglob("*.json")) + list(ROOT.rglob("*.md")) + list(ROOT.rglob("*.sql")) + list(ROOT.rglob("*.py")):
    if ".git" in str(f) or "node_modules" in str(f): continue
    if f.name == ".env": continue
    try: t = f.read_text(encoding="utf-8")
    except Exception: continue
    if re.search(r"\btvly-[A-Za-z0-9_-]{8,}\b", t) and "INVALID-KEY-FOR-FAILURE-TEST" not in t:
        suspect.append(str(f.relative_to(ROOT)))
    if re.search(r"api_key['\"]?\s*[:=]\s*['\"][A-Za-z0-9]{20,}['\"]", t):
        suspect.append(str(f.relative_to(ROOT)) + ":literal key?")
check("secrets:clean-excl-env", not suspect, "; ".join(suspect[:5]))

print(f"\n{len(fails)} failures" if fails else "\nALL PROVIDER POLICY TESTS PASSED")
sys.exit(1 if fails else 0)
