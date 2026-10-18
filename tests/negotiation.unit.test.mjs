// BuyWise Phase 2B negotiation unit tests. Fixtures synthetic, never LIVE/production.
// Run: node tests/negotiation.unit.test.mjs
import { readFileSync } from "node:fs";
import { validateEligibility, computeTarget, buildRequest, draftMessage, canSend, isDuplicate } from "../tools/_lib/negotiation.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/phase2b_cases.json", import.meta.url), "utf8"));
const V = () => JSON.parse(JSON.stringify(fx.negotiation_vendor));
const O = () => JSON.parse(JSON.stringify(fx.negotiation_offer));
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${c ? "" : " — " + String(d).slice(0, 200)}`); c ? pass++ : fail++; };

// Eligibility matrix
{
  const e = validateEligibility({ vendor: V(), offer: O(), procurement: fx.procurement });
  ok("negotiation:eligible-structure", e.eligible && !e.reasons.length, JSON.stringify(e.reasons));
  ok("negotiation:missing-vendor", !validateEligibility({ vendor: null, offer: O(), procurement: fx.procurement }).eligible, "accepted");
  ok("negotiation:missing-offer", !validateEligibility({ vendor: V(), offer: null, procurement: fx.procurement }).eligible, "accepted");
  const noprice = O(); noprice.net_price = "unavailable";
  ok("negotiation:missing-price", !validateEligibility({ vendor: V(), offer: noprice, procurement: fx.procurement }).eligible, "accepted");
  const noccy = O(); delete noccy.currency;
  ok("negotiation:missing-currency", !validateEligibility({ vendor: V(), offer: noccy, procurement: fx.procurement }).eligible, "accepted");
  const nocontact = V(); nocontact.contact_channel = { status: "UNAVAILABLE" };
  ok("negotiation:missing-contact", !validateEligibility({ vendor: nocontact, offer: O(), procurement: fx.procurement }).eligible, "accepted");
  const wrongccy = O(); wrongccy.currency = "USD";
  ok("negotiation:currency-mismatch", !validateEligibility({ vendor: V(), offer: wrongccy, procurement: fx.procurement }).eligible, "accepted");
}
// Targets: budget-derived, explicit discount, never assumed
{
  const t = computeTarget({ current_price: 85000, currency: "INR", budget: 80000, budgetCurrency: "INR" });
  ok("target:from-budget", t.target_price === 80000 && t.basis === "procurement_budget", JSON.stringify(t));
  const d = computeTarget({ current_price: 85000, currency: "INR", budget: 90000, budgetCurrency: "INR", allowed_discount_pct: 10 });
  ok("target:explicit-discount", d.target_price === 76500, JSON.stringify(d.target_price));
  const n = computeTarget({ current_price: 75000, currency: "INR", budget: 80000, budgetCurrency: "INR" });
  ok("target:none-when-no-basis", n.target_price === null, JSON.stringify(n.target_price));
  const a = computeTarget({ current_price: 85000, currency: "INR", budget: null, budgetCurrency: "INR" });
  ok("target:no-assumed-percent", a.target_price === null, "assumed a discount");
}
// buildRequest gating
{
  const r = buildRequest({ procurement_id: fx.procurement.procurement_id, product_id: "p-good", vendor: V(), offer: O(), target_price: 80000, target_basis: "procurement_budget" });
  ok("request:ready-for-review", r.status === "READY_FOR_HUMAN_REVIEW" && r.negotiation.do_not_send === true && r.negotiation.human_confirmation === false, JSON.stringify(r.status));
  ok("request:discount-math", r.negotiation.requested_discount_percent === 5.88, JSON.stringify(r.negotiation.requested_discount_percent));
  const nr = buildRequest({ procurement_id: fx.procurement.procurement_id, product_id: "p-good", vendor: null, offer: null, target_price: null });
  ok("request:not-ready-no-rows", nr.status === "NOT_READY" && !nr.negotiation, "created a row-less request?");
  const nt = buildRequest({ procurement_id: fx.procurement.procurement_id, product_id: "p-good", vendor: V(), offer: O(), target_price: null });
  ok("request:not-ready-no-target", nt.status === "NOT_READY", JSON.stringify(nt.status));
}
// Message facts-only: every claim must come from input
{
  const r = buildRequest({ procurement_id: fx.procurement.procurement_id, product_id: "p-good", vendor: V(), offer: O(), target_price: 80000, target_basis: "procurement_budget" });
  const m = draftMessage({ negotiation: r.negotiation, procurement: fx.procurement, product: fx.negotiation_product });
  const banned = ["competitor", "previous conversation", "discount approved", "policy", "history", "volume discount", "guarantee", "promise"];
  ok("message:no-invented-claims", !banned.some((w) => (m.subject + m.body).toLowerCase().includes(w)), "invented claim present");
  ok("message:facts-traceable", m.facts_used.length >= 3 && m.evidence_urls.length === 1, JSON.stringify(m.facts_used.length));
  ok("message:changes-listed", m.requested_changes[0].includes("85000") && m.requested_changes[0].includes("80000"), m.requested_changes[0]);
}
// Send gate + duplicates + events
{
  ok("send:false-without-confirmation", canSend({ human_confirmation: false, contact_channel: V().contact_channel }).send === false, "would send");
  ok("send:false-without-channel", canSend({ human_confirmation: true, contact_channel: { status: "UNAVAILABLE" } }).send === false, "would send");
  ok("duplicates:detected", isDuplicate([{ procurement_id: "p1", offer_id: "o1" }], "p1", "o1") === true, "missed");
  ok("duplicates:distinct-ok", isDuplicate([{ procurement_id: "p1", offer_id: "o1" }], "p1", "o2") === false, "false positive");
}

console.log(`\nNEGOTIATION UNIT RESULTS: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
