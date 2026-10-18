// Unit tests for intake validation (incl. mode rules).
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateIntake, isUuid } from '../lib/validate.js';

test('accepts a minimal valid REAL request', () => {
  const r = validateIntake({ requirement: 'five laptops please', currency: 'INR' });
  assert.equal(r.valid, true);
});
test('rejects short requirement, bad currency, bad numbers', () => {
  assert.equal(validateIntake({ requirement: 'abc', currency: 'INR' }).valid, false);
  assert.equal(validateIntake({ requirement: 'valid requirement text', currency: 'usd' }).valid, false);
  assert.equal(validateIntake({ requirement: 'valid requirement text', currency: 'INR', quantity: -2 }).valid, false);
  assert.equal(validateIntake({ requirement: 'valid requirement text', currency: 'INR', budget: 0 }).valid, false);
});
test('rejects unknown mode; DEMO requires an explicit reason', () => {
  assert.equal(validateIntake({ requirement: 'valid requirement text', currency: 'INR', mode: 'SILENT' }).valid, false);
  assert.equal(validateIntake({ requirement: 'valid requirement text', currency: 'INR', mode: 'DEMO' }).valid, false);
  assert.equal(validateIntake({ requirement: 'valid requirement text', currency: 'INR', mode: 'DEMO', demo_reason: '  ' }).valid, false);
  assert.equal(validateIntake({ requirement: 'valid requirement text', currency: 'INR', mode: 'DEMO', demo_reason: 'class demo' }).valid, true);
  assert.equal(validateIntake({ requirement: 'valid requirement text', currency: 'INR', mode: 'REAL' }).valid, true);
});
test('rejects non-object mandatory_specs', () => {
  assert.equal(validateIntake({ requirement: 'valid requirement text', currency: 'INR', mandatory_specs: [1] }).valid, false);
});
test('validates mandatory rule shapes; flat scalars accepted (legacy form)', () => {
  assert.equal(validateIntake({ requirement: 'valid requirement text', currency: 'INR', mandatory_specs: { ram_gb_min: 16 } }).valid, true);
  assert.equal(validateIntake({ requirement: 'valid requirement text', currency: 'INR', mandatory_specs: { ram_gb: { min: 16 } } }).valid, true);
  const badOp = validateIntake({ requirement: 'valid requirement text', currency: 'INR', mandatory_specs: { ram_gb: { around: 16 } } });
  assert.equal(badOp.valid, false);
  const badMin = validateIntake({ requirement: 'valid requirement text', currency: 'INR', mandatory_specs: { ram_gb: { min: 'lots' } } });
  assert.equal(badMin.valid, false);
  const contra = validateIntake({ requirement: 'valid requirement text', currency: 'INR', mandatory_specs: { ram_gb: { min: 32, max: 8 } } });
  assert.equal(contra.valid, false);
});
test('emits clarification warnings, never invents data', () => {
  const w = validateIntake({ requirement: 'valid requirement text here', currency: 'INR' });
  assert.equal(w.valid, true);
  assert.ok(w.warnings.some((x) => /no budget/.test(x)), JSON.stringify(w.warnings));
  assert.ok(w.warnings.some((x) => /no mandatory specs/.test(x)), JSON.stringify(w.warnings));
  const ov = validateIntake({ requirement: 'valid requirement text here', currency: 'INR', budget: 100, mandatory_specs: { ram_gb_min: 8 }, preferred_specs: { ram_gb_min: 16 } });
  assert.ok(ov.warnings.some((x) => /mandatory wins/.test(x)), JSON.stringify(ov.warnings));
});
test('isUuid validates shape only', () => {
  assert.equal(isUuid('43b753a9-f992-4198-819f-5644db4df0ea'), true);
  assert.equal(isUuid('not-a-uuid'), false);
  assert.equal(isUuid(null), false);
});
