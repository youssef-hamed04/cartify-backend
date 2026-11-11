// TEST DOUBLE — a local stand-in for Ollama's HTTP API (GET /api/tags, POST /api/chat), used only by
// tests/ai.agents.mjs so the agent loop, tool validation, confirmations and permissions can be tested
// quickly and deterministically. It is never used by the application. The real model is tested by
// tests/ai.live.mjs.
//   IGNORE_NUDGE=1 MOCK_MODEL=qwen3:4b-instruct node tests/mockOllama.mjs
import http from 'http';

const PORT = Number(process.env.MOCK_PORT || 11999);
const MODEL = process.env.MOCK_MODEL || 'qwen3:4b-instruct';
let calls = [];
let failNext = null;

// The customer's text of the latest real turn ("<turn_context>date…</turn_context>\n<text>")
const lastUserText = (messages) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const c = String(m.content);
    if (c.startsWith('<turn_context>date:')) return c.slice(c.indexOf('</turn_context>') + 15).trim();
    if (c.startsWith('<turn_context>Tool budget') && !process.env.IGNORE_NUDGE) return 'NUDGE';
  }
  return '';
};
const toolResultsSinceLastTurn = (messages) => {
  const out = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'tool') out.unshift(m);
    else if (m.role === 'user' && String(m.content).startsWith('<turn_context>date:')) break;
  }
  return out;
};

function validate(body) {
  const errs = [];
  if (body.model !== MODEL) errs.push(`unexpected model ${body.model}`);
  if (body.stream !== false) errs.push('stream must be false');
  if (!body.options?.num_ctx) errs.push('num_ctx missing');
  const msgs = body.messages || [];
  if (msgs[0]?.role !== 'system') errs.push('first message must be the system prompt');
  msgs.forEach((m, i) => {
    if (!['system', 'user', 'assistant', 'tool'].includes(m.role)) errs.push(`bad role ${m.role}`);
    if (typeof m.content !== 'string') errs.push(`message ${i} content must be a string`);
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const next = msgs.slice(i + 1, i + 1 + m.tool_calls.length);
      if (next.length !== m.tool_calls.length || next.some((t) => t.role !== 'tool')) errs.push(`tool calls at ${i} are not followed by their tool results`);
      m.tool_calls.forEach((c, k) => { if (next[k]?.tool_name !== c.function.name) errs.push(`tool result ${i + 1 + k} has the wrong tool_name`); });
    }
  });
  for (const t of body.tools || []) if (t.type !== 'function' || !t.function?.name || !t.function?.parameters || !t.function?.description) errs.push(`tool ${t.function?.name} malformed`);
  return errs;
}

const reply = (content, toolCalls) => ({
  model: MODEL, created_at: new Date().toISOString(), done: true, done_reason: 'stop',
  message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls.map(([name, args]) => ({ function: { name, arguments: args } })) } : {}) },
  prompt_eval_count: 900, eval_count: 40,
});
const parse = (m) => { try { return JSON.parse(m.content); } catch { return null; } };

function script(body) {
  const text = lastUserText(body.messages).toLowerCase();
  const results = toolResultsSinceLastTurn(body.messages);
  const data = results.length ? parse(results[results.length - 1]) : null;
  if (text === 'nudge') return reply('Here is what I found so far.');
  if (text.includes('silent-reply')) return reply('');
  // ── shopping
  if (text.includes('compare')) {
    if (!results.length) return reply('', [['search_products', { keywords: ['headphone'], limit: 3 }]]);
    if (results.length === 1) return reply('', [['compare_products', { productIds: data.products.slice(0, 2).map((p) => p.id) }]]);
    return reply('The **first** one is cheaper; the **second** is rated higher.');
  }
  if (text.includes('headphones')) {
    if (!results.length) return reply('', [['search_products', { keywords: ['headphone', 'wireless'], maxPrice: 200, limit: 4 }]]);
    if (results.length === 1) return reply('', [['show_products', { productIds: data.products.slice(0, 2).map((p) => p.id), title: 'Headphones under $200' }]]);
    return reply('Here are two wireless headphones under $200 from the catalog.');
  }
  if (text.includes('name them')) { // reply names products without calling show_products
    if (!results.length) return reply('', [['search_products', { keywords: ['headphone'], maxPrice: 200, limit: 3 }]]);
    return reply(`I recommend **${data.products[0].name}** and **${data.products[1].name}**.`);
  }
  if (text.includes('add the first')) {
    if (!results.length) {
      const hist = JSON.stringify(body.messages);
      const id = hist.match(/"show_products","arguments":\{"productIds":\["([a-f0-9]{24})"/)?.[1];
      return reply('', [['get_product_details', { productId: id }]]);
    }
    if (results.length === 1) return reply('', [['add_to_cart', { productId: data.product.id, color: data.product.colors.find((c) => c.available > 0).color, quantity: 1 }]]);
    return reply('I prepared it — press Confirm to add it to your cart.');
  }
  if (text.includes('bad args')) {
    if (!results.length) return reply('', [['add_to_cart', { productId: 'not-an-id', quantity: 99, hack: true }]]);
    return reply(`The tool said: ${results[0].content.slice(0, 80)}`);
  }
  if (text.includes('my cart')) {
    if (!results.length) return reply('', [['get_cart', {}], ['get_my_orders', {}]]); // parallel calls
    return reply('That is your cart and your orders.');
  }
  if (text.includes('unknown tool')) {
    if (!results.length) return reply('', [['delete_all_orders', {}]]);
    return reply(`Tool error: ${results[0].content.slice(0, 60)}`);
  }
  // ── inventory
  if (text.includes('lowest inventory')) {
    if (!results.length) return reply('', [['get_inventory_overview', { horizonDays: 30 }]]);
    return reply(`**${data.lowestInventoryBranch}** has the lowest inventory.`);
  }
  if (text.includes('transfer')) {
    if (!results.length) return reply('', [['suggest_stock_transfer', { limit: 2 }]]);
    if (results.length === 1) { const t = data.transfers[0]; return reply('', [['create_stock_transfer_request', { product: t.productId, fromBranch: t.from, toBranch: t.to, quantity: t.quantity, reason: 'Agent test' }]]); }
    return reply('Transfer request prepared; confirm it on the card.');
  }
  if (text.includes('loop forever')) return reply('', [['get_cart', {}]]);
  return reply('Hello from the test double.');
}

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/__calls') return send(200, calls);
    if (req.url === '/__reset') { calls = []; return send(200, {}); }
    if (req.url.startsWith('/__fail')) { failNext = { status: new URL(req.url, 'http://x').searchParams.get('status') }; return send(200, {}); }
    if (req.url === '/api/tags') return send(200, { models: [{ name: MODEL }] });
    if (req.url !== '/api/chat') return send(404, { error: 'not found' });
    const body = JSON.parse(raw || '{}');
    const errors = validate(body);
    calls.push({ model: body.model, think: body.think, numCtx: body.options?.num_ctx, keepAlive: body.keep_alive, tools: (body.tools || []).map((t) => t.function.name), messages: body.messages.length, authHeader: !!req.headers.authorization, errors });
    if (failNext) {
      const s = failNext.status; failNext = null;
      if (s === 'close') { req.socket.destroy(); return; }
      return send(Number(s), { error: `model "${body.model}" not found, try pulling it first` });
    }
    if (body.options?.num_predict === 1) return send(200, reply('')); // warm-up
    if (errors.length) return send(400, { error: errors.join('; ') });
    return send(200, script(body));
  });
}).listen(PORT, '127.0.0.1', () => console.log(`Ollama test double on ${PORT} (model ${MODEL})`));
