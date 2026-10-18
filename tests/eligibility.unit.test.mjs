// BuyWise eligibility unit tests: mandatory PASS/FAIL/UNKNOWN + grouping.
// Synthetic fixtures only. Run: node tests/eligibility.unit.test.mjs
import { normalizeMandatory, assessEligibility, groupCandidates } from "../tools/_lib/eligibility.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${c ? "" : " — " + String(d).slice(0, 200)}`); c ? pass++ : fail++; };

{
  const m = normalizeMandatory({ ram_gb_min: 16, storage_gb_min: 512, color: "black", warranty_max: 36 });
  ok("elig:normalize", m.ram_gb?.min === 16 && m.storage_gb?.min === 512 && m.color?.equals === "black" && m.warranty?.max === 36, JSON.stringify(m));
  ok("elig:normalize-string", normalizeMandatory('{"ram_gb_min":8}').ram_gb?.min === 8, "string input");
  ok("elig:normalize-empty", Object.keys(normalizeMandatory({})).length === 0, "empty input");
}
{
  const products = {
    "p-pass": { specifications: { ram_gb: 16, storage_gb: 512 } },
    "p-fail": { product_id: "p-fail", specifications: { ram_gb: 8, storage_gb: 512 } },
    "p-unknown": { product_id: "p-unknown", specifications: {} },
    "p-missing": { product_id: "p-missing", specifications: { ram_gb: "unavailable" } },
  };
  const rows = assessEligibility({ productsById: products, mandatory: { ram_gb: { min: 16 }, storage_gb: { min: 512 } }, preferences: { color: "black" } });
  const get = (pid, req) => rows.find((r) => r.product_id === pid && r.requirement === req);
  ok("elig:pass", get("p-pass", "ram_gb")?.verdict === "PASS" && get("p-pass", "storage_gb")?.verdict === "PASS", "pass misjudged");
  ok("elig:fail", get("p-fail", "ram_gb")?.verdict === "FAIL" && get("p-fail", "storage_gb")?.verdict === "PASS", "fail misjudged");
  ok("elig:unknown-empty", get("p-unknown", "ram_gb")?.verdict === "UNKNOWN", "empty specs must be UNKNOWN");
  ok("elig:unknown-marker", get("p-missing", "ram_gb")?.verdict === "UNKNOWN", "'unavailable' must be UNKNOWN");
  ok("elig:unknown-never-pass", !rows.some((r) => r.verdict !== "FAIL" && r.verdict !== "PASS" && r.verdict !== "UNKNOWN"), "bad verdict value");
  ok("elig:evidence-kept", get("p-fail", "ram_gb")?.evidence?.spec_value === 8, "evidence lost");
  const pref = rows.find((r) => r.product_id === "p-pass" && r.requirement === "color");
  ok("elig:preference-info", pref?.verdict === "UNKNOWN" && pref?.evidence?.mandatory === false, "preference must not gate");
}
{
  const g = groupCandidates({
    productIds: ["p-pass", "p-fail", "p-unknown", "p-norows"],
    eligibility: [
      { product_id: "p-pass", requirement: "ram_gb", verdict: "PASS", evidence: { mandatory: true } },
      { product_id: "p-fail", requirement: "ram_gb", verdict: "FAIL", evidence: { mandatory: true } },
      { product_id: "p-unknown", requirement: "ram_gb", verdict: "UNKNOWN", evidence: { mandatory: true } },
    ],
    mandatory: { ram_gb: { min: 16 } },
  });
  ok("elig:groups", JSON.stringify(g.eligible) === '["p-pass"]' && JSON.stringify(g.rejected) === '["p-fail"]'
    && JSON.stringify(g.unresolved) === JSON.stringify(["p-unknown", "p-norows"]), JSON.stringify(g));
  const g2 = groupCandidates({ productIds: ["a", "b"], eligibility: [], mandatory: {} });
  ok("elig:no-mandatory-eligible", JSON.stringify(g2.eligible) === '["a","b"]', "no mandatory = eligible");
}

console.log(`\nELIGIBILITY UNIT RESULTS: ${pass} PASS, ${fail} FAIL`);
if (fail) process.exit(1);
