// Secret-hygiene tests: no keys, tokens, or env values in web sources or API output.
// .env itself is never read by these tests (presence-only policy everywhere else).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const SECRET_PATTERNS = [
  /tvly-[A-Za-z0-9_-]{8,}/,
  /re_[A-Za-z0-9]{16,}/,
  /sk-(live|ant)-[A-Za-z0-9]+/,
  /Bearer [A-Za-z0-9._~-]{8,}/,
  /Basic [A-Za-z0-9+/=]{12,}/,
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(m?js|html|css|json|md)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('no secret-shaped values in web sources', () => {
  const bad = [];
  for (const f of walk(root)) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      // the guard's own detection patterns are allow-listed by construction
      if (line.includes('refusing to emit secret-shaped value') || line.includes('A-Za-z0-9')) return;
      for (const rx of SECRET_PATTERNS) {
        const m = line.match(rx);
        if (m) bad.push(`${f}:${i + 1}: ${m[0].slice(0, 24)}`);
      }
    });
  }
  assert.deepEqual(bad, []);
});

test('frontend never references server env or key names with values', async () => {
  const pub = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.ok(!pub.includes('TAVILY_API_KEY=') && !pub.includes('SERPAPI_API_KEY='));
  assert.ok(!pub.includes('process.env'));
});

test('safeJson guard exists in server', () => {
  const srv = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.ok(srv.includes('refusing to emit secret-shaped value'));
});
