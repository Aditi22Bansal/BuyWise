// BuyWise Phase 2C approval unit tests. Fixtures synthetic, never LIVE/production.
// Run: node tests/approval.unit.test.mjs
import { readFileSync } from "node:fs";
import { validatePackage, validateActor, validateDecisionInput, closureTransition, isDuplicateApproval, isExpired } from "../tools/_lib/approval.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/phase2c_cases.json", import.meta.url), "utf8"));
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${c ? "" : " — " + String(d).slice(0, 200)}`); c ? pass++ : fail++; };

// Package completeness: sections present (values may honestly be unavailable)
{
  ok("package:complete", validatePackage(fx.approval_package_ok).complete, "rejected valid package");
  const thin = { ...fx.approval_package_ok };
  delete thin.quality_evidence;
  ok("package:missing-section", !validatePackage(thin).complete && validatePackage(thin).missing.includes("quality_evidence"), "missed gap");
}
// Actor identities: explicit only, placeholders rejected, nothing hardcoded by us
{
  ok("actor:real-ok", validateActor("Priya Sharma").ok, "rejected");
  ok("actor:short", !validateActor("X").ok, "accepted");
  for (const fake of ["manager", "test", "unknown", "N/A", "  "]) {
    ok(`actor:placeholder-${fake.trim() || "blank"}`, !validateActor(fake).ok, "accepted placeholder");
  }
}
// Decision input: only the three explicit outcomes, never absence/timeout
{
  const good = { approval_id: "a-1", procurement_id: fx.procurement_id, decision: "APPROVED", actor: "Priya Sharma", decided_at: "2026-10-08T14:00:00Z" };
  ok("decision:approved-valid", validateDecisionInput(good).valid, "rejected");
  for (const bad of [undefined, null, "", "APPROVE", "YES", "timeout", "viewed"]) {
    const r = validateDecisionInput({ ...good, decision: bad });
    ok(`decision:never-${String(bad)}`, !r.valid, "treated as approval");
  }
  ok("decision:no-timestamp", !validateDecisionInput({ ...good, decided_at: null }).valid, "accepted");
}
// Closure: only explicit outcomes close; changes never close
{
  const a = closureTransition("APPROVED");
  ok("closure:approved", a.close && a.status === "closed" && a.event === "approval_approved", JSON.stringify(a));
  const r = closureTransition("REJECTED");
  ok("closure:rejected", r.close && r.status === "closed", JSON.stringify(r));
  const c = closureTransition("CHANGES_REQUESTED");
  ok("closure:changes-no-close", !c.close && c.status === "changes_requested", JSON.stringify(c));
  ok("closure:unknown-no-close", closureTransition("PENDING").close === false, "auto-closed");
}
// Duplicates, expiry
{
  ok("approval:duplicate-open", isDuplicateApproval([{ procurement_id: "p1", status: "PENDING_APPROVAL" }], "p1"), "missed");
  ok("approval:distinct-ok", !isDuplicateApproval([{ procurement_id: "p1", status: "APPROVED" }], "p1"), "false positive");
  ok("approval:expired", isExpired({ expires_at: "2020-01-01T00:00:00Z" }), "missed expiry");
  ok("approval:not-expired", !isExpired({ expires_at: "2099-01-01T00:00:00Z" }), "false expiry");
  ok("approval:no-expiry-never", !isExpired({}), "false expiry");
}

console.log(`\nAPPROVAL UNIT RESULTS: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
