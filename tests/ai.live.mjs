// LIVE evaluation of both agents on the real local model (Ollama). No mocks: the configured model
// must choose and call the real Cartify tools. Use it to compare models on your hardware.
//   OLLAMA_MODEL=qwen3:4b-instruct npm start      (test database, AI service + Ollama running)
//   node tests/ai.live.mjs [--out results.json]
// Each scenario prints the tools called, checks, time and the start of the reply.
import fs from 'fs';

const BASE = process.env.API_URL || 'http://localhost:3001';
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : null;
const ARABIC = /[؀-ۿ]/;

class Client {
  constructor() { this.cookies = {}; this.token = null; }
  async req(method, path, body) {
    const h = { 'Content-Type': 'application/json' };
    const ck = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (ck) h.Cookie = ck;
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    const res = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15 * 60_000) });
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); this.cookies[kv.slice(0, i)] = kv.slice(i + 1); }
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }
}

const results = [];
async function scenario(name, client, path, message, conversationId, checks) {
  const t0 = Date.now();
  const r = await client.req('POST', path, { message, ...(conversationId ? { conversationId } : {}) });
  const seconds = Math.round((Date.now() - t0) / 1000);
  const reply = r.data.reply || {};
  const ctx = { r, reply, tools: r.data.toolCalls || [], text: reply.text || '', blocks: reply.blocks || [] };
  const failed = r.status !== 200 ? [`HTTP ${r.status}: ${r.data.err}`] : (await Promise.all(Object.entries(checks).map(async ([label, fn]) => ((await fn(ctx)) ? null : label)))).filter(Boolean);
  results.push({ name, seconds, ok: !failed.length, failed, tools: ctx.tools, reply: ctx.text.slice(0, 400), blocks: ctx.blocks.map((b) => b.type) });
  console.log(`\n${failed.length ? 'FAIL' : 'ok  '} ${name} (${seconds} s)\n     tools: ${ctx.tools.join(', ') || '—'} · blocks: ${ctx.blocks.map((b) => b.type).join(', ') || '—'}${failed.length ? `\n     failed: ${failed.join('; ')}` : ''}\n     reply: ${ctx.text.replace(/\s+/g, ' ').slice(0, 220)}`);
  return r.data.conversationId;
}

const products = (ctx) => ctx.blocks.filter((b) => b.type === 'products').flatMap((b) => b.products);
const status = (await new Client().req('GET', '/assistant/status')).data;
console.log(`Model: ${status.model} · available: ${status.enabled}`);
if (!status.enabled) process.exit(1);

// ── Shopping assistant (guest) ──────────────────────────────────────────────────────────────
const guest = new Client();
const c1 = await scenario('EN · search with a budget', guest, '/assistant/chat', 'I need wireless headphones under $200', null, {
  'searched the catalog': (c) => c.tools.includes('search_products'),
  'shows product cards': (c) => products(c).length > 0,
  'all within budget': (c) => products(c).every((p) => p.price <= 200),
});
await scenario('EN · add to cart needs confirmation', guest, '/assistant/chat', 'Add the first one to my cart please', c1, {
  'prepared add_to_cart': (c) => c.blocks.some((b) => b.type === 'confirm_action'),
  'cart unchanged before Confirm': async () => (await guest.req('GET', '/cart/quantity')).data.totalQuantity === 0,
});
await scenario('EN · compare two products', guest, '/assistant/chat', 'Compare the Ghost Audio Elite with the Soundcore R50i', null, {
  'comparison table': (c) => c.blocks.some((b) => b.type === 'comparison' && b.products.length >= 2),
});
const g2 = new Client();
await scenario('AR · search with a budget', g2, '/assistant/chat', 'أريد ساعة ذكية بسعر أقل من 600 دولار', null, {
  'searched the catalog': (c) => c.tools.includes('search_products'),
  'shows matching products': (c) => products(c).length > 0 && products(c).every((p) => p.price <= 600),
  'replies in Arabic': (c) => ARABIC.test(c.text),
});
await scenario('AR · cart contents', g2, '/assistant/chat', 'ما الموجود في سلة التسوق الخاصة بي؟', null, {
  'read the cart': (c) => c.tools.includes('get_cart'),
  'replies in Arabic': (c) => ARABIC.test(c.text),
});
await scenario('AR · order tracking (unknown order)', g2, '/assistant/chat', 'أين طلبي رقم ABC123؟', null, {
  'looked up own orders': (c) => c.tools.includes('track_order') || c.tools.includes('get_my_orders'),
  'replies in Arabic': (c) => ARABIC.test(c.text),
});

// ── Inventory agent (admin) ─────────────────────────────────────────────────────────────────
const admin = new Client();
admin.token = (await admin.req('POST', '/users/auth', { email: 'admin@cartify.com', password: 'Admin@12345' })).data.token;
const lowest = (await admin.req('GET', '/inventory/overview')).data.lowestInventory;
await scenario('EN · lowest inventory branch', admin, '/assistant/inventory/chat', 'Which branch has the lowest inventory?', null, {
  'used inventory data': (c) => c.tools.some((t) => ['get_inventory_overview', 'generate_inventory_report', 'get_all_branches'].includes(t)),
  [`names ${lowest}`]: (c) => c.text.toLowerCase().includes(String(lowest).toLowerCase().replace(' branch', '')),
});
await scenario('AR · products likely to run out', admin, '/assistant/inventory/chat', 'ما المنتجات التي من المحتمل أن تنفد قريبًا في فرع الجامعة؟', null, {
  'used low-stock data': (c) => c.tools.some((t) => ['identify_low_stock', 'get_branch_inventory', 'get_demand_forecast'].includes(t)),
  'replies in Arabic': (c) => ARABIC.test(c.text),
});
await scenario('EN · what to transfer', admin, '/assistant/inventory/chat', 'What should we transfer between branches this week?', null, {
  'used transfer suggestions': (c) => c.tools.includes('suggest_stock_transfer') || c.tools.includes('generate_inventory_report'),
});
await scenario('EN · compare branch sales', admin, '/assistant/inventory/chat', 'Compare sales between branches for the last 30 days', null, {
  'used branch sales': (c) => c.tools.includes('get_branch_sales') || c.tools.includes('generate_inventory_report'),
});
await scenario('EN · increasing demand', admin, '/assistant/inventory/chat', 'Which products have increasing demand?', null, {
  'used the forecast': (c) => c.tools.includes('get_demand_forecast') || c.tools.includes('generate_inventory_report'),
});

const passed = results.filter((r) => r.ok).length;
const secs = results.map((r) => r.seconds);
const summary = { model: status.model, passed, total: results.length, medianSeconds: secs.sort((a, b) => a - b)[Math.floor(secs.length / 2)], maxSeconds: Math.max(...secs), results };
console.log(`\n${status.model}: ${passed}/${results.length} scenarios passed · median ${summary.medianSeconds} s · max ${summary.maxSeconds} s`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
process.exit(passed === results.length ? 0 : 1);
