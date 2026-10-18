// Live SerpAPI price check (temp). Key loaded from .env, never printed.
import fs from 'node:fs';

const cfg = {};
for (const line of fs.readFileSync('D:\\flexi\\.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && m[2]) process.env[m[1]] ??= m[2];
}
console.log('key present:', !!process.env.SERPAPI_API_KEY);
const m = await import('../tools/product-search/serpapi-shopping.js');
const r = await m.serpapiShoppingSearch({ query: 'business laptop 16GB RAM 512GB SSD', limit: 5 });
console.log('envelopes:', r.length);
for (const e of r.slice(0, 5)) {
  console.log(e.data_status, '| price:', JSON.stringify(e.data?.price), '| ccy:', JSON.stringify(e.data?.currency), '| merchant:', JSON.stringify(e.data?.merchant_name), '| err:', e.error);
}
