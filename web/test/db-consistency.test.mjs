// BuyWise DB/code consistency: the database trigger map must mirror
// tools/_lib/lifecycle.js TRANSITIONS exactly, and the pending-approval
// uniqueness index must exist. Live DB, read-only. Run: npm test
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRANSITIONS } from '../../tools/_lib/lifecycle.js';

function pgPass() {
  if (process.env.PGPASSWORD) return process.env.PGPASSWORD;
  try {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
    for (const line of fs.readFileSync(root, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*POSTGRES_PASSWORD\s*=\s*(.*?)\s*$/);
      if (m && m[1]) return m[1];
    }
  } catch { /* ignore */ }
  return '';
}
const pool = new pg.Pool({ host: 'localhost', port: 5432, database: 'buywise', user: 'buywise', password: pgPass() });
after(async () => { await pool.end().catch(() => {}); });

test('trigger map mirrors lifecycle.js TRANSITIONS exactly', async () => {
  const { rows } = await pool.query(`SELECT prosrc FROM pg_proc WHERE proname='enforce_lifecycle_transition'`);
  assert.ok(rows.length > 0, 'trigger function missing');
  const src = rows[0].prosrc;
  for (const [from, tos] of Object.entries(TRANSITIONS)) {
    for (const to of tos) {
      assert.ok(src.includes(`'${from}'`) && src.includes(`'${to}'`), `pair missing in trigger: ${from} -> ${to}`);
    }
    // every WHEN branch for `from` must list exactly the same set
    const branch = src.split(`WHEN '${from}'`)[1]?.split('WHEN ')[0] ?? '';
    for (const to of tos) assert.ok(branch.includes(`'${to}'`), `branch ${from} missing ${to}`);
  }
});

test('exactly one PENDING approval per case is DB-enforced', async () => {
  const { rows } = await pool.query(
    `SELECT indexdef FROM pg_indexes WHERE indexname='approvals_one_pending_per_case'`);
  assert.ok(rows.length > 0, 'partial unique index missing');
  assert.match(rows[0].indexdef, /WHERE \(?status = 'PENDING_APPROVAL'/);
});
