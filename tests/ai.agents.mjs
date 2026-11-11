// End-to-end test of the agent endpoints against a scripted stand-in for Ollama (fast, deterministic).
// tests/mockOllama.mjs checks each request's shape and replies with scripted tool calls, so the loop,
// tool validation, confirmations and authorization are exercised. The real model: tests/ai.live.mjs.
//   IGNORE_NUDGE=1 node tests/mockOllama.mjs &
//   OLLAMA_URL=http://127.0.0.1:11999 OLLAMA_MODEL=qwen3:4b-instruct ASSISTANT_RATE_LIMIT_PER_MIN=100 npm start   (test DB!)
//   node tests/ai.agents.mjs
const BASE = process.env.API_URL || 'http://localhost:3001', MOCK = process.env.MOCK_URL || 'http://127.0.0.1:11999';
let pass = 0, fail = 0;
const ok = (name, cond, info = '') => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name, typeof info === 'string' ? info : JSON.stringify(info).slice(0, 300)); } };

class C {
  constructor() { this.cookies = {}; this.bearer = null; }
  async req(method, path, body) {
    const h = { 'Content-Type': 'application/json' };
    const ck = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (ck) h.Cookie = ck;
    if (this.bearer) h.Authorization = `Bearer ${this.bearer}`;
    const res = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); this.cookies[kv.slice(0, i)] = kv.slice(i + 1); }
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }
}
const calls = async () => (await fetch(MOCK + '/__calls')).json();
await fetch(MOCK + '/__reset');

console.log('shopping assistant (guest, cookie session)');
const g = new C();
let r = await g.req('GET', '/assistant/status');
ok('status enabled', r.data.enabled === true && r.data.agents.inventory === false, r.data);
r = await g.req('POST', '/assistant/chat', { message: 'I need wireless headphones under $200' });
ok('chat 200', r.status === 200, r.data);
const conv = r.data.conversationId;
ok('reply text', /headphones/i.test(r.data.reply?.text || ''), r.data.reply);
ok('product cards block from tools', r.data.reply.blocks?.[0]?.type === 'products' && r.data.reply.blocks[0].products.length === 2 && r.data.reply.blocks[0].products.every((p) => p.price <= 200), r.data.reply.blocks);
ok('tool calls reported', JSON.stringify(r.data.toolCalls) === JSON.stringify(['search_products', 'show_products']), r.data.toolCalls);
let c = await calls();
ok('3 model calls, all valid', c.length === 3 && c.every((x) => x.errors.length === 0), c.map((x) => x.errors));
ok('local model request: thinking off, context size, keep-alive', c[0].think === false && c[0].numCtx >= 2048 && !!c[0].keepAlive, c[0]);
ok('no credentials sent to the model server', c.every((x) => !x.authHeader));
ok('shopping agent does not get inventory tools', !c[0].tools.some((t) => /stock|branch|inventory/.test(t)), c[0].tools);

r = await g.req('POST', '/assistant/chat', { message: 'Great, add the first one', conversationId: conv });
ok('second turn continues conversation', r.status === 200 && r.data.conversationId === conv, r.data);
const action = r.data.reply.blocks.find((b) => b.type === 'confirm_action');
ok('confirm card returned', action && action.kind === 'add_to_cart' && r.data.pendingActions.length === 1, r.data.reply.blocks);
r = await g.req('GET', '/cart/quantity');
ok('cart unchanged before confirm', r.data.totalQuantity === 0, r.data);
c = await calls();
ok('history replayed on turn 2 (messages grew)', c[c.length - 1].messages > c[2].messages, c.map((x) => x.messages));

const other = new C();
r = await other.req('POST', `/assistant/actions/${action.actionId}/confirm`, { conversationId: conv });
ok('another visitor cannot confirm the action', r.status === 404, r);
r = await other.req('GET', `/assistant/conversations/${conv}`);
ok('another visitor cannot read the conversation', r.status === 404);

r = await g.req('POST', `/assistant/actions/${action.actionId}/confirm`, { conversationId: conv });
ok('confirm executes via cart API', r.status === 200 && r.data.status === 'confirmed' && r.data.result.cart.totalQuantity === 1, r.data);
r = await g.req('GET', '/cart/quantity');
ok('cart now has the item', r.data.totalQuantity === 1);
r = await g.req('POST', `/assistant/actions/${action.actionId}/confirm`, { conversationId: conv });
ok('double confirm rejected', r.status === 409, r);
r = await g.req('GET', `/assistant/conversations/${conv}`);
ok('transcript has user/assistant/system entries', r.status === 200 && r.data.transcript.length === 5 && r.data.transcript[4].role === 'system', r.data.transcript?.map((t) => t.role));

r = await g.req('POST', '/assistant/chat', { message: 'show my cart and orders', conversationId: conv });
ok('parallel tool calls', r.status === 200 && r.data.toolCalls.length === 2 && r.data.reply.blocks.some((b) => b.type === 'cart'), r.data);
c = await calls();
ok('confirmation outcome visible to the model', JSON.stringify(c).length > 0 && c.every((x) => x.errors.length === 0), c.map((x) => x.errors));

r = await g.req('POST', '/assistant/chat', { message: 'bad args please', conversationId: conv });
ok('invalid tool args are rejected server-side and reported to the model', r.status === 200 && /Invalid arguments/.test(r.data.reply.text), r.data.reply);

r = await g.req('POST', '/assistant/chat', { message: 'loop forever' });
ok('tool loop is capped', r.status === 200 && /could not finish/i.test(r.data.reply.text), r.data);
r = await g.req('POST', '/assistant/chat', { message: 'silent-reply' });
ok('empty model reply handled', r.status === 200 && r.data.reply.text.length > 0, r.data);
r = await g.req('POST', '/assistant/chat', { message: 'unknown tool please' });
ok('unknown tool rejected, model told the valid tools', r.status === 200 && /Unknown tool/.test(r.data.reply.text), r.data.reply);
r = await g.req('POST', '/assistant/chat', { message: 'name them please' });
ok('products named in the reply are shown as catalog cards', r.status === 200 && r.data.reply.blocks[0]?.type === 'products' && r.data.reply.blocks[0].products.length === 2 && r.data.reply.blocks[0].fullProducts?.length === 2, r.data.reply);
r = await g.req('POST', '/assistant/chat', { message: 'x'.repeat(2001) });
ok('message length validated', r.status === 400);
r = await g.req('POST', '/assistant/chat', { message: 'hi', conversationId: '000000000000000000000000' });
ok('unknown conversation 404', r.status === 404);

for (const [status, expect, label] of [['404', 503, 'model not downloaded'], ['500', 502, 'model server error'], ['close', 503, 'model server down']]) {
  await fetch(`${MOCK}/__fail?status=${status}`);
  r = await g.req('POST', '/assistant/chat', { message: 'hello' });
  ok(`${label} → ${expect} with a clean message`, r.status === expect && !/pulling|ECONN|socket/i.test(r.data.err || ''), r);
}

console.log('inventory agent');
const u = new C();
await u.req('POST', '/users/auth', { email: `agent.user.${Date.now()}@example.com` });
r = await u.req('POST', '/assistant/inventory/chat', { message: 'Which branch has the lowest inventory?' });
ok('customer cannot use the inventory agent', r.status === 403);
const a = new C();
await a.req('POST', '/users/auth', { email: 'admin@cartify.com', password: 'Admin@12345' });
await fetch(MOCK + '/__reset');
r = await a.req('POST', '/assistant/inventory/chat', { message: 'Which branch has the lowest inventory?' });
ok('admin inventory answer from tool data', r.status === 200 && /\*\*.+Branch\*\*/.test(r.data.reply.text), r.data);
c = await calls();
ok('inventory agent has inventory tools only', c[0].tools.includes('suggest_stock_transfer') && !c[0].tools.includes('add_to_cart'), c[0].tools);
const ic = r.data.conversationId;
r = await a.req('POST', '/assistant/inventory/chat', { message: 'What should we transfer this week?', conversationId: ic });
const tAction = r.data.reply?.blocks?.find((b) => b.type === 'confirm_action');
ok('transfer suggestions + confirm card', r.status === 200 && r.data.reply.blocks.some((b) => b.type === 'transfer_suggestions') && tAction?.kind === 'create_stock_transfer_request', r.data);
const before = (await a.req('GET', '/inventory/movements?status=requested')).data.total;
r = await u.req('POST', `/assistant/inventory/actions/${tAction.actionId}/confirm`, { conversationId: ic });
ok('customer cannot confirm admin action', r.status === 403);
r = await a.req('POST', `/assistant/inventory/actions/${tAction.actionId}/confirm`, { conversationId: ic });
ok('admin confirm creates a REQUESTED movement (not executed)', r.status === 200 && r.data.result.movement.status === 'requested', r.data);
const after = (await a.req('GET', '/inventory/movements?status=requested')).data;
ok('movement recorded as via inventory_agent', after.total === before + 1 && after.movements[0].requestedVia === 'inventory_agent', after.movements?.[0]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
