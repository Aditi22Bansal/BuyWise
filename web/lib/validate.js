// BuyWise web validation helpers (pure, unit-tested). Mirrors schemas/*.schema.json
// and the n8n Code-node guards. Missing/invalid -> collected errors, never invented data.
// Warnings flag requests that are valid but thin (no budget, no mandatory specs,
// preference/mandatory overlap) so the requester can clarify before research.
export function validateIntake(b = {}) {
  const errors = [];
  const warnings = [];
  if (!b.requirement || String(b.requirement).length < 5) errors.push('requirement required (min 5 chars)');
  if (!b.currency || !/^[A-Z]{3}$/.test(String(b.currency))) errors.push('currency required as ISO 4217 (e.g. INR)');
  if (b.quantity != null && !(Number.isInteger(b.quantity) && b.quantity > 0)) errors.push('quantity must be a positive integer');
  if (b.budget != null && !(typeof b.budget === 'number' && b.budget > 0)) errors.push('budget must be a positive number');
  if (b.mode !== undefined && b.mode !== 'REAL' && b.mode !== 'DEMO') errors.push('mode must be REAL or DEMO');
  if (b.mode === 'DEMO' && !(b.demo_reason && String(b.demo_reason).trim())) errors.push('DEMO mode requires an explicit reason');
  if (b.mandatory_specs !== undefined) {
    if (typeof b.mandatory_specs !== 'object' || Array.isArray(b.mandatory_specs)) {
      errors.push('mandatory_specs must be an object');
    } else {
      for (const [k, rule] of Object.entries(b.mandatory_specs)) {
        if (typeof k !== 'string' || !k.trim()) { errors.push('mandatory_specs keys must be non-empty strings'); break; }
        // Legacy flat form ({ ram_gb_min: 16 }) is accepted and normalized
        // downstream; object form ({ ram_gb: { min: 16 } }) is validated strictly.
        if (rule !== null && typeof rule !== 'object' && typeof rule !== 'number' && typeof rule !== 'string') {
          errors.push(`mandatory_specs.${k} must be a scalar or an object rule`); break;
        }
        if (rule && typeof rule === 'object' && !Array.isArray(rule)) {
          for (const rk of Object.keys(rule)) {
            if (!['min', 'max', 'equals'].includes(rk)) { errors.push(`mandatory_specs.${k} has unknown rule '${rk}' (allowed: min, max, equals)`); break; }
          }
          if (rule.min !== undefined && typeof rule.min !== 'number') errors.push(`mandatory_specs.${k}.min must be a number`);
          if (rule.max !== undefined && typeof rule.max !== 'number') errors.push(`mandatory_specs.${k}.max must be a number`);
          if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max) errors.push(`mandatory_specs.${k} is contradictory (min > max)`);
        }
      }
    }
  }
  if (b.preferred_specs !== undefined && (typeof b.preferred_specs !== 'object' || Array.isArray(b.preferred_specs))) {
    errors.push('preferred_specs must be an object');
  }
  if (errors.length === 0) {
    if (b.budget == null) warnings.push('no budget: value-for-money gates cannot run');
    if (!b.mandatory_specs || Object.keys(b.mandatory_specs).length === 0) warnings.push('no mandatory specs: eligibility cannot fail anything');
    if (b.mandatory_specs && b.preferred_specs) {
      const overlap = Object.keys(b.mandatory_specs).filter((k) => k in b.preferred_specs);
      if (overlap.length) warnings.push(`in both mandatory and preferred: ${overlap.join(', ')} (mandatory wins)`);
    }
    if (b.quantity != null && b.budget != null && b.budget / b.quantity <= 0) warnings.push('budget/quantity ratio is not positive');
  }
  return { valid: errors.length === 0, errors, warnings };
}

export function isUuid(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
