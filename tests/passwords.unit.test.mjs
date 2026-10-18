// BuyWise password unit tests: scrypt hashing, validation, no plaintext.
// Synthetic only. Run: node tests/passwords.unit.test.mjs
import { hashPassword, verifyPassword, validateUsername, validatePassword, validateRole } from "../tools/_lib/passwords.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${c ? "" : " — " + String(d).slice(0, 160)}`); c ? pass++ : fail++; };

{
  const h = await hashPassword("correct-horse-123");
  ok("pw:verify-ok", await verifyPassword("correct-horse-123", h), "rejected correct");
  ok("pw:verify-bad", !(await verifyPassword("wrong-pass-123", h)), "accepted wrong");
  ok("pw:no-plaintext", !h.includes("correct-horse-123"), "hash leaks password");
  ok("pw:salted", (await hashPassword("same-password-1")) !== (await hashPassword("same-password-1")), "deterministic hash");
  ok("pw:malformed", !(await verifyPassword("x", "not-a-hash")) && !(await verifyPassword("x", null)), "accepted malformed");
  let threw = false;
  try { await hashPassword("short"); } catch { threw = true; }
  ok("pw:min-length", threw, "accepted short password");
}
{
  ok("user:valid", validateUsername("aditi.ops").ok, "rejected valid");
  ok("user:short", !validateUsername("ab").ok, "accepted short");
  ok("user:chars", !validateUsername("a b!").ok, "accepted bad chars");
  ok("pw:valid", validatePassword("long-enough-1").ok, "rejected valid");
  ok("role:valid", validateRole("approver").ok, "rejected valid");
  ok("role:bad", !validateRole("superuser").ok, "accepted bad role");
}

console.log(`\nPASSWORDS UNIT RESULTS: ${pass} PASS, ${fail} FAIL`);
if (fail) process.exit(1);
