// BuyWise commercial procurement run: fresh case through the upgraded pipeline.
// Product Research (Tavily + SerpAPI) -> Vendor Research (SerpAPI sellers + Tavily
// enrich, eBay inactive) -> Review & Quality -> Comparison -> Scoring -> Decision.
// Offer/vendor rows ONLY on validated commercial evidence (tools/_lib/commercial.js).
// No SerpAPI key -> SerpAPI UNAVAILABLE, Tavily-only candidates, honest stop.
// Never prints secrets. Run: node tests/commercial_run.mjs (PGPASSWORD in process env)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { productSearch } from "../tools/product-search/adapter.js";
import { vendorSearch } from "../tools/vendor-search/adapter.js";
import { webSearch } from "../tools/web-search/adapter.js";
import { validateOfferEvidence, validateVendorEvidence, productIdentity, merchantKey } from "../tools/_lib/commercial.js";
import { classifySource } from "../tools/_lib/source_quality.js";
import { specCompleteness, extractSpecs, extractContactEmail, contactHostMatches } from "../tools/_lib/evidence.js";
import { productDetails } from "../tools/product-details/adapter.js";
import { score, rankRows, DEFAULT_WEIGHTS } from "../tools/_lib/scoring.js";
import { decide } from "../tools/_lib/decision.js";

for (const line of readFileSync("D:\\flexi\\.env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && m[2]) process.env[m[1]] ??= m[2];
}
const sha = (o) => createHash("sha256").update(JSON.stringify(o)).digest("hex");
const sqlLit = (v) => (v === null || v === undefined ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'");
const sqlJson = (o) => sqlLit(JSON.stringify(o));
function psql(sql) { execFileSync("docker", ["exec", "-i", "buywise-postgres", "psql", "-U", "buywise", "-d", "buywise", "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], { encoding: "utf8" }); }

const SPEC_FIELDS = ["processor", "ram", "storage", "operating_system", "display", "battery", "graphics"];
const UNIT_BUDGET = 80000; // per-unit budget (case holds 400000 total for qty 5); unit offers evaluated against unit budget.
const REQ = {
  requirement: "5 business laptops for software development teams. Total budget INR 400000 (80000 per unit). Minimum 16 GB RAM, minimum 512 GB SSD. Warranty required.",
  quantity: 5, budget: 400000, currency: "INR",
  mandatory_specs: { ram_gb_min: 16, storage_gb_min: 512 },
  preferred_specs: { warranty: "required", os: ["Windows", "Linux"] },
};
const procurement_id = randomUUID(), trace_id = randomUUID();
const t0 = Date.now();
const stats = { serpapi_live: 0, tavily_live: 0, products: 0, rejected_no_url: 0, offers: 0, offer_rejected: 0, vendors: 0, vendor_rejected: 0, ratings_attributed: 0 };

// 1. Intake
psql(`INSERT INTO procurement_cases (procurement_id,status,requirement,quantity,budget,currency,mandatory_specs,preferred_specs,created_by) VALUES (${sqlLit(procurement_id)},'created',${sqlLit(REQ.requirement)},${REQ.quantity},${REQ.budget},${sqlLit(REQ.currency)},${sqlJson(REQ.mandatory_specs)},${sqlJson(REQ.preferred_specs)},'commercial-run')`);
psql(`INSERT INTO agent_executions (procurement_id,trace_id,agent_name,status,input_hash) VALUES (${sqlLit(procurement_id)},${sqlLit(trace_id)},'orchestrator','started',${sqlLit(sha(REQ))})`);

// 2. Product Research via gateway (SerpAPI primary-structured + Tavily web)
const gw = await productSearch({ query: "business laptop 16GB RAM 512GB SSD buy India", limit: 10 });
const serp = gw.filter((e) => e.source === "serpapi_shopping" && e.data_status !== "UNAVAILABLE");
const tav = gw.filter((e) => e.source === "tavily_search" && e.data_status !== "UNAVAILABLE");
stats.serpapi_live = serp.length; stats.tavily_live = tav.length;

// 3. Products: dedupe by stable identity; SerpAPI items keep commercial evidence.
const seen = new Set(); const products = [];
for (const e of [...serp, ...tav]) {
  if (!e.source_url) { stats.rejected_no_url++; continue; }
  const d = e.data || {};
  const ident = e.source === "serpapi_shopping"
    ? productIdentity({ product_url: d.product_url, serpapi_product_id: d.model, brand: null, model: d.model })
    : productIdentity({ product_url: e.source_url });
  const key = ident.key || e.source_url;
  if (seen.has(`${e.source}:${key}`)) continue;
  seen.add(`${e.source}:${key}`);
  products.push({
    // ID scoped to this procurement: identical source URLs recur across runs.
    product_id: `p-${e.source === "serpapi_shopping" ? "serp" : "tav"}-${createHash("sha1").update(procurement_id + key).digest("hex").slice(0, 12)}`,
    name: String(d.product_name || d.title || "unavailable").slice(0, 300), brand: "unavailable",
    specifications: {}, source: e.source, source_url: e.source_url, retrieved_at: e.retrieved_at,
    data_status: e.data_status, confidence: e.confidence ?? 0.6,
    raw: e.source === "serpapi_shopping" ? { ...d, serpapi_product_id: e._serpapi?.product_id ?? d.model ?? null } : { title: d.title ?? null },
  });
}
// 3b. Spec verification (bounded): same-subject spec pages via Tavily -> Extract ->
// strict single-value patterns. Anything else stays unavailable. Never inferred.
const specStats = { verified_ram: 0, verified_storage: 0, verified_warranty: 0, ambiguous: 0 };
for (const p of products.filter((x) => x.source === "serpapi_shopping").slice(0, 10)) {
  try {
    const sres = await webSearch({ query: `${p.name.slice(0, 70)} specifications RAM SSD`, max_results: 4 });
    const cands = sres.filter((x) => x.data_status !== "UNAVAILABLE" && x.source_url);
    if (!cands.length) continue;
    const det = await productDetails({ url: cands[0].source_url });
    if (det.data_status === "UNAVAILABLE" || !det.data?.extracted_text) continue;
    const sp = extractSpecs(det.data.extracted_text);
    const evBase = { url: cands[0].source_url, retrieved_at: det.retrieved_at };
    p.spec_ev = { ev: evBase, ram: sp.ram_gb, storage: sp.storage_gb, warranty: sp.warranty_months, rejected: sp._rejected };
    if (sp.ram_gb) specStats.verified_ram++; else if (sp._rejected.some((r) => r.startsWith("ram-"))) specStats.ambiguous++;
    if (sp.storage_gb) specStats.verified_storage++; else if (sp._rejected.some((r) => r.startsWith("storage-"))) specStats.ambiguous++;
    if (sp.warranty_months) specStats.verified_warranty++;
    p.raw.spec_evidence = { ...evBase, ram: sp.ram_gb, storage: sp.storage_gb, warranty: sp.warranty_months, rejected: sp._rejected };
  } catch { /* spec evidence best-effort; missing stays missing */ }
}
for (const p of products) {
  const se = p.spec_ev || {};
  p.specifications = {
    processor: "unavailable",
    ram: se.ram ? se.ram.value : "unavailable",
    ram_gb: se.ram ? se.ram.value : "unavailable",
    storage: se.storage ? se.storage.value : "unavailable",
    storage_gb: se.storage ? se.storage.value : "unavailable",
    operating_system: "unavailable", display: "unavailable", battery: "unavailable", graphics: "unavailable",
  };
  psql(`INSERT INTO products (product_id,procurement_id,name,brand,specifications,source,source_url,retrieved_at,data_status,confidence,raw_response) VALUES (${sqlLit(p.product_id)},${sqlLit(procurement_id)},${sqlLit(p.name)},'unavailable',${sqlJson(p.specifications)},${sqlLit(p.source)},${sqlLit(p.source_url)},${sqlLit(p.retrieved_at)},${sqlLit(p.data_status)},${p.confidence},${sqlJson(p.raw)}) ON CONFLICT (procurement_id,source_url) DO NOTHING`);
}
stats.products = products.length;
psql(`UPDATE procurement_cases SET status='product_done' WHERE procurement_id=${sqlLit(procurement_id)}`);

// 4. Vendor Research: listing-level offers first, then per-merchant sellers (bounded);
// Tavily enrich for official/policy evidence. Offers ONLY on full evidence.
const vendors = new Map(); const offers = [];
function addOffer(p, d, source_url, retrieved_at, data_status, confidence) {
  const ov = validateOfferEvidence({ product_name: d.product_name, product_url: d.product_url !== "unavailable" ? d.product_url : p.source_url, merchant_name: d.merchant_name, merchant_url: source_url, price: d.price, currency: d.currency, source_url });
  if (!ov.accepted) { stats.offer_rejected++; return; }
  const vv = validateVendorEvidence({ vendor_name: d.merchant_name, merchant_url: source_url, provider: "serpapi_shopping" });
  if (!vv.accepted) { stats.vendor_rejected++; return; }
  const mk = merchantKey({ merchant_name: d.merchant_name, merchant_url: source_url });
  if (!vendors.has(mk)) {
    vendors.set(mk, { vendor_id: `v-serp-${createHash("sha1").update(procurement_id + mk).digest("hex").slice(0, 12)}`, vendor_name: d.merchant_name, vendor_url: source_url, source: "serpapi_shopping", source_url, retrieved_at, data_status, confidence: confidence ?? 0.7, raw: { delivery: d.delivery ?? "unavailable" } });
  }
  const v = vendors.get(mk);
  if (offers.some((o) => o.product_id === p.product_id && o.vendor_id === v.vendor_id && o.source_url === source_url)) return;
  offers.push({ offer_id: `o-${p.product_id.slice(2, 8)}-${v.vendor_id.slice(2, 8)}-${offers.length}`, product_id: p.product_id, vendor_id: v.vendor_id, unit_price: d.price, currency: d.currency, discount_pct: "unavailable", net_price: d.price, delivery_days: typeof d.delivery === "string" ? d.delivery.slice(0, 120) : "unavailable", warranty_months: "unavailable", payment_terms: "unavailable", availability: "unavailable", source: "serpapi_shopping", source_url, retrieved_at, data_status, confidence: confidence ?? 0.7, raw: {} });
}
const serpProducts = products.filter((x) => x.source === "serpapi_shopping");
// (a) each listing's own merchant/price evidence is an offer candidate
for (const p of serpProducts) {
  const d = (serp.find((e) => e.source_url === p.source_url) || {}).data || {};
  addOffer(p, { ...d, product_url: d.product_url && d.product_url !== "unavailable" ? d.product_url : p.source_url }, p.source_url, p.retrieved_at, p.data_status, p.confidence);
}
// (b) per-merchant sellers for distinct products (bounded to protect API quota)
for (const p of serpProducts.slice(0, 8)) {
  const pid = p.raw?.serpapi_product_id && p.raw.serpapi_product_id !== "unavailable" ? p.raw.serpapi_product_id : null;
  const res = await vendorSearch({ query: p.name.slice(0, 80), limit: 8, serpapi_product_id: pid, productCtx: { product_url: p.source_url, product_name: p.name } });
  for (const e of res.filter((x) => x.source === "serpapi_shopping" && x.data_status !== "UNAVAILABLE")) {
    const d = e.data || {};
    // Attribution: attach only same-product evidence (matching SerpAPI cluster id).
    // Google redirect URLs share one base, so URL comparison is meaningless here.
    const sameProduct = !!(pid && d.serpapi_product_id && d.serpapi_product_id !== "unavailable" && d.serpapi_product_id === pid);
    if (!sameProduct) { stats.offer_rejected++; continue; }
    addOffer(p, d, e.source_url, e.retrieved_at, e.data_status, e.confidence);
  }
}
// Tavily enrich (max 5 merchants): official site + policy pages as evidence; contact stays unavailable.
for (const v of [...vendors.values()].slice(0, 5)) {
  try {
    const res = await webSearch({ query: `${v.vendor_name} official website warranty shipping policy`, max_results: 4 });
    const own = res.filter((x) => x.data_status !== "UNAVAILABLE" && x.source_url).slice(0, 3);
    if (own.length) v.raw.enrichment_urls = own.map((x) => x.source_url);
  } catch { /* enrichment best-effort */ }
}
for (const v of vendors.values()) {
  psql(`INSERT INTO vendors (vendor_id,procurement_id,vendor_name,vendor_url,source,source_url,retrieved_at,data_status,confidence,raw_response) VALUES (${sqlLit(v.vendor_id)},${sqlLit(procurement_id)},${sqlLit(v.vendor_name)},${sqlLit(v.vendor_url)},${sqlLit(v.source)},${sqlLit(v.source_url)},${sqlLit(v.retrieved_at)},${sqlLit(v.data_status)},${v.confidence},${sqlJson(v.raw)}) ON CONFLICT (vendor_id) DO NOTHING`);
}
// 4b. Contact investigation (bounded): real contact pages only, strict email pattern,
// blocklisted role addresses excluded. No match -> channel stays unavailable. Never guessed.
const contactStats = { investigated: 0, verified: 0 };
const channels = {};
for (const v of [...vendors.values()].slice(0, 6)) {
  contactStats.investigated++;
  try {
    const res = await webSearch({ query: `${v.vendor_name} contact email`, max_results: 4 });
    const contactPage = res.find((x) => x.data_status !== "UNAVAILABLE" && /contact/i.test(x.source_url || ""));
    if (!contactPage) continue;
    const det = await productDetails({ url: contactPage.source_url });
    if (det.data_status === "UNAVAILABLE" || !det.data?.extracted_text) continue;
    const hit = extractContactEmail(det.data.extracted_text);
    if (!hit) continue;
    // Same-party guard: third-party directories are evidence, not the vendor's channel.
    if (!contactHostMatches(v.vendor_name, contactPage.source_url)) {
      v.raw.contact_rejected = { email: hit.email, source_url: contactPage.source_url, reason: "third-party host mismatch (not vendor's own domain)", retrieved_at: det.retrieved_at };
      psql(`UPDATE vendors SET raw_response=${sqlJson(v.raw)} WHERE vendor_id=${sqlLit(v.vendor_id)}`);
      continue;
    }
    v.raw.contact_evidence = { email: hit.email, basis: hit.basis, source_url: contactPage.source_url, retrieved_at: det.retrieved_at };
    channels[v.vendor_id] = { type: "email", address: hit.email, source_url: contactPage.source_url, status: "LIVE" };
    contactStats.verified++;
    psql(`UPDATE vendors SET raw_response=${sqlJson(v.raw)} WHERE vendor_id=${sqlLit(v.vendor_id)}`);
  } catch { /* contact stays unavailable */ }
}
Object.assign(stats, { contact_investigated: contactStats.investigated, contact_verified: contactStats.verified });
for (const o of offers) {
  const pw = products.find((pp) => pp.product_id === o.product_id)?.spec_ev?.warranty?.value ?? null;
  if (pw) { o.warranty_months = String(pw); o.raw.warranty_evidence = products.find((pp) => pp.product_id === o.product_id)?.spec_ev?.ev; }
  psql(`INSERT INTO offers (offer_id,procurement_id,product_id,vendor_id,unit_price,currency,discount_pct,net_price,delivery_days,warranty_months,payment_terms,availability,source,source_url,retrieved_at,data_status,confidence,raw_response) VALUES (${sqlLit(o.offer_id)},${sqlLit(procurement_id)},${sqlLit(o.product_id)},${sqlLit(o.vendor_id)},${o.unit_price},${sqlLit(o.currency)},NULL,${o.net_price},${sqlLit(o.delivery_days)},${sqlLit(o.warranty_months)},'unavailable','unavailable',${sqlLit(o.source)},${sqlLit(o.source_url)},${sqlLit(o.retrieved_at)},${sqlLit(o.data_status)},${o.confidence},${sqlJson(o.raw)}) ON CONFLICT (procurement_id,product_id,vendor_id,source_url) DO NOTHING`);
}
stats.vendors = vendors.size; stats.offers = offers.length;
psql(`UPDATE procurement_cases SET status='vendor_done' WHERE procurement_id=${sqlLit(procurement_id)}`);
psql(`INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES (${sqlLit(procurement_id)},${sqlLit(trace_id)},'vendor_research','vendor_offers_persisted',${sqlJson(stats)})`);

// 5. Review & Quality (deterministic; SerpAPI listing ratings attributed same-subject only)
const evals = products.map((p) => {
  const sq = classifySource(p.source_url);
  const sc = specCompleteness(p.specifications, SPEC_FIELDS);
  const listing = serp.find((e) => e.source_url === p.source_url)?.data || null;
  const rating = listing && typeof listing.rating === "number" ? listing.rating : null;
  const count = listing && Number.isInteger(listing.review_count) ? listing.review_count : null;
  if (rating !== null) stats.ratings_attributed++;
  return { procurement_id, product_id: p.product_id, source_quality: sq.tier, source_quality_score: sq.score, specification_completeness: sc.completeness, spec_fields_total: sc.total, spec_fields_verified: sc.verified, review_rating: rating ?? "unavailable", review_scale: rating !== null ? 5 : null, review_count: count ?? "unavailable", review_evidence: rating !== null ? "serpapi listing rating (same-subject)" : "unavailable", quality_evidence: [{ kind: "source_classification", tier: sq.tier }], quality_confidence: sq.score >= 0.8 ? 0.8 : sq.score, source_urls: [p.source_url], retrieved_at: new Date().toISOString(), data_status: "PARTIAL" };
});
for (const e of evals) {
  psql(`INSERT INTO quality_evaluations (procurement_id,product_id,source_quality,source_quality_score,specification_completeness,spec_fields_total,spec_fields_verified,review_rating,review_scale,review_count,review_evidence,quality_evidence,quality_confidence,source_urls,retrieved_at,data_status) VALUES (${sqlLit(e.procurement_id)},${sqlLit(e.product_id)},${sqlLit(e.source_quality)},${e.source_quality_score},${e.specification_completeness},${e.spec_fields_total},${e.spec_fields_verified},${typeof e.review_rating === "number" ? e.review_rating : "NULL"},${typeof e.review_scale === "number" ? e.review_scale : "NULL"},${Number.isInteger(e.review_count) ? e.review_count : "NULL"},${sqlLit(e.review_evidence)},${sqlJson(e.quality_evidence)},${e.quality_confidence},${sqlJson(e.source_urls)},${sqlLit(e.retrieved_at)},'PARTIAL') ON CONFLICT (procurement_id,product_id) DO NOTHING`);
}
psql(`INSERT INTO scoring_configs (procurement_id,weights,spec_fields,notes) VALUES (${sqlLit(procurement_id)},'${JSON.stringify(DEFAULT_WEIGHTS)}','${JSON.stringify(SPEC_FIELDS)}','commercial run defaults') ON CONFLICT (procurement_id) DO NOTHING`);
psql(`UPDATE procurement_cases SET status='quality_done' WHERE procurement_id=${sqlLit(procurement_id)}`);

// 6. Comparison + decision (engine reuse; missing excluded; no FX)
const byId = Object.fromEntries(evals.map((e) => [e.product_id, e]));
const offersByProduct = Object.fromEntries(products.map((p) => [p.product_id, offers.filter((o) => o.product_id === p.product_id).map((o) => ({ ...o, unit_price: Number(o.unit_price), net_price: Number(o.net_price) }))]));
const rows = products.map((p) => {
  const ev = byId[p.product_id];
  const sameCcy = (offersByProduct[p.product_id] || []).filter((o) => o.currency === REQ.currency);
  const best = sameCcy.length ? Math.min(...sameCcy.map((o) => o.net_price)) : null;
  const rev = typeof ev.review_rating === "number" ? ev.review_rating / 5 : null;
  const comps = { price: null, quality: rev, reviews: rev, delivery: null, warranty: null, vendor_reliability: null, payment_terms: null, budget_compliance: best !== null ? (best <= UNIT_BUDGET ? 1 : 0) : null, source_quality: ev.source_quality_score, specification_completeness: ev.specification_completeness };
  const s = score(comps, DEFAULT_WEIGHTS);
  return { product_id: p.product_id, overall_score: s.overall_score, criteria_scores: s.breakdown, criteria_used: s.criteria_used, criteria_missing: s.criteria_missing, effective_weight_total: s.effective_weight_total, budget_compliance: comps.budget_compliance === null ? "unavailable" : String(comps.budget_compliance), source_quality: ev.source_quality_score, specification_completeness: ev.specification_completeness, strengths: [], limitations: comps.budget_compliance === null ? ["Price comparison unavailable"] : [], evidence_urls: ev.source_urls, confidence: p.confidence };
});
const ranked = rankRows(rows);
for (const r of ranked) {
  psql(`INSERT INTO comparisons (procurement_id,product_id,rank,overall_score,criteria_scores,criteria_used,criteria_missing,effective_weight_total,budget_compliance,source_quality,specification_completeness,strengths,limitations,evidence_urls) VALUES (${sqlLit(procurement_id)},${sqlLit(r.product_id)},${r.rank},${typeof r.overall_score === "number" ? r.overall_score : "NULL"},${sqlJson(r.criteria_scores)},${sqlJson(r.criteria_used)},${sqlJson(r.criteria_missing)},${r.effective_weight_total},${sqlLit(r.budget_compliance)},${r.source_quality},${r.specification_completeness},'[]',${sqlJson(r.limitations)},${sqlJson(r.evidence_urls)}) ON CONFLICT (procurement_id,product_id) DO NOTHING`);
}
psql(`UPDATE procurement_cases SET status='compared' WHERE procurement_id=${sqlLit(procurement_id)}`);
const d = decide({
  procurement: { procurement_id, currency: REQ.currency, budget: UNIT_BUDGET, quantity: REQ.quantity },
  ranked: ranked.map((r) => ({ ...r, comparison_id: null })),
  offersByProduct,
  vendorsById: Object.fromEntries([...vendors.values()].map((v) => [v.vendor_id, { ...v, contact_channel: channels[v.vendor_id] ?? null }])),
  productsById: Object.fromEntries(products.map((p) => [p.product_id, { ...p, specifications: {} }])),
  mandatory: { ram_gb: { min: 16 }, storage_gb: { min: 512 } },
});
psql(`INSERT INTO decisions (procurement_id,product_id,comparison_id,decision,decision_reason,blocking_reasons,criteria_used,criteria_missing,evidence_urls) VALUES (${sqlLit(procurement_id)},${sqlLit(d.product_id)},NULL,${sqlLit(d.decision)},${sqlLit(d.decision_reason)},${sqlJson(d.blocking_reasons)},${sqlJson(d.criteria_used)},${sqlJson(d.criteria_missing)},${sqlJson(d.evidence_urls)}) ON CONFLICT (procurement_id) DO NOTHING`);
psql(`UPDATE procurement_cases SET status='decided' WHERE procurement_id=${sqlLit(procurement_id)}`);
psql(`UPDATE agent_executions SET status='succeeded',output_hash=${sqlLit(sha({ decision: d.decision, offers: offers.length }))},completed_at=now(),latency_ms=${Date.now() - t0} WHERE trace_id=${sqlLit(trace_id)} AND agent_name='orchestrator'`);
psql(`INSERT INTO audit_log (procurement_id,trace_id,agent_name,event,detail) VALUES (${sqlLit(procurement_id)},${sqlLit(trace_id)},'decision','decision_persisted',${sqlJson({ decision: d.decision, blocking: d.blocking_reasons })})`);

console.log(JSON.stringify({ procurement_id, final_state: "decided", decision: d.decision, latency_ms: Date.now() - t0, ...stats, top3: ranked.slice(0, 3).map((r) => ({ rank: r.rank, product_id: r.product_id, score: r.overall_score, used: r.criteria_used })) }));
