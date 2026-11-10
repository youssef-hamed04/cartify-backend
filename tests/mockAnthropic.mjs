// TEST DOUBLE — local stand-in for POST /v1/messages, used only by tests/ai.agents.mjs to test the
// agent loop without an API key. It is never used by the application itself.
// It validates the request shape like the real API (roles, tool_use/tool_result pairing) and
// replies with scripted tool calls chosen from the latest user text.
import http from 'http';

const PORT = 9999;
let calls = [];
let failNext = null; // { status, body } to simulate provider errors

const lastUserText = (messages) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const texts = (Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]).filter((b) => b.type === 'text' && !b.text.startsWith('<turn_context>') && !(process.env.IGNORE_NUDGE && b.text.startsWith('Tool budget')));
    if (texts.length) return texts.map((t) => t.text).join(' ');
  }
  return '';
};
const toolResultsSinceLastText = (messages) => {
  const out = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')) out.unshift(...m.content.filter((b) => b.type === 'tool_result'));
    else if (m.role === 'user') break;
  }
  return out;
};

function validate(body) {
  const errs = [];
  if (!body.model) errs.push('model missing');
  if (!body.max_tokens) errs.push('max_tokens missing');
  if (!Array.isArray(body.messages) || !body.messages.length) errs.push('messages missing');
  if (body.messages?.[0]?.role !== 'user') errs.push('first message must be user');
  for (let i = 0; i < (body.messages || []).length; i++) {
    const m = body.messages[i];
    if (!['user', 'assistant'].includes(m.role)) errs.push(`bad role ${m.role}`);
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const ids = m.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
      if (ids.length) {
        const next = body.messages[i + 1];
        const got = (next?.role === 'user' && Array.isArray(next.content) ? next.content : []).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id);
        for (const id of ids) if (!got.includes(id)) errs.push(`tool_use ${id} has no tool_result in the next message`);
      }
    }
  }
  for (const t of body.tools || []) if (!t.name || !t.input_schema || !t.description) errs.push(`tool ${t.name} incomplete`);
  return errs;
}

let n = 0;
const toolUse = (name, input) => ({ type: 'tool_use', id: `toolu_${++n}`, name, input });
const reply = (content, stop_reason) => ({ id: `msg_${++n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_details: null, usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } });
const parse = (r) => { try { return JSON.parse(r.content); } catch { return null; } };

function script(body) {
  const text = lastUserText(body.messages).toLowerCase();
  const results = toolResultsSinceLastText(body.messages);
  const last = results[results.length - 1];
  const data = last ? parse(last) : null;
  if (text.includes('refuse-me')) return reply([], 'refusal');
  // ── shopping
  if (text.includes('headphones')) {
    if (!results.length) return reply([{ type: 'text', text: 'Let me search.' }, toolUse('search_products', { keywords: ['headphone', 'wireless'], maxPrice: 200, limit: 4 })], 'tool_use');
    if (results.length === 1) return reply([toolUse('show_products', { productIds: data.products.slice(0, 2).map((p) => p.id), title: 'Headphones under $200' })], 'tool_use');
    return reply([{ type: 'text', text: 'Here are two wireless headphones under $200 from the catalog.' }], 'end_turn');
  }
  if (text.includes('compare')) {
    if (!results.length) return reply([toolUse('search_products', { keywords: ['headphone'], limit: 3 })], 'tool_use');
    if (results.length === 1) return reply([toolUse('compare_products', { productIds: data.products.slice(0, 2).map((p) => p.id) })], 'tool_use');
    return reply([{ type: 'text', text: 'The **first** one is cheaper; the **second** is rated higher.' }], 'end_turn');
  }
  if (text.includes('add the first')) {
    if (!results.length) {
      // find the first shown product id in history
      const hist = JSON.stringify(body.messages);
      const id = hist.match(/show_products[^}]*?"productIds":\["([a-f0-9]{24})"/)?.[1];
      return reply([toolUse('get_product_details', { productId: id })], 'tool_use');
    }
    if (results.length === 1) return reply([toolUse('add_to_cart', { productId: data.product.id, color: data.product.colors.find((c) => c.available > 0).color, quantity: 1 })], 'tool_use');
    return reply([{ type: 'text', text: 'I prepared it — press Confirm to add it to your cart.' }], 'end_turn');
  }
  if (text.includes('bad args')) {
    if (!results.length) return reply([toolUse('add_to_cart', { productId: 'not-an-id', quantity: 99, hack: true })], 'tool_use');
    return reply([{ type: 'text', text: `The tool said: ${last.content.slice(0, 80)}` }], 'end_turn');
  }
  if (text.includes('my cart')) {
    if (!results.length) return reply([toolUse('get_cart', {}), toolUse('get_my_orders', {})], 'tool_use'); // parallel calls
    return reply([{ type: 'text', text: 'That is your cart and your orders.' }], 'end_turn');
  }
  // ── inventory
  if (text.includes('lowest inventory')) {
    if (!results.length) return reply([toolUse('get_inventory_overview', { horizonDays: 30 })], 'tool_use');
    return reply([{ type: 'text', text: `**${data.lowestInventoryBranch}** has the lowest inventory.` }], 'end_turn');
  }
  if (text.includes('transfer')) {
    if (!results.length) return reply([toolUse('suggest_stock_transfer', { limit: 2 })], 'tool_use');
    if (results.length === 1) { const t = data.transfers[0]; return reply([toolUse('create_stock_transfer_request', { product: t.productId, fromBranch: t.from.branchName, toBranch: t.to.branchName, quantity: t.quantity, reason: 'Agent test' })], 'tool_use'); }
    return reply([{ type: 'text', text: 'Transfer request prepared; confirm it on the card.' }], 'end_turn');
  }
  if (text.includes('loop forever')) return reply([toolUse('get_cart', {})], 'tool_use');
  return reply([{ type: 'text', text: 'Hello from the mock.' }], 'end_turn');
}

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.url === '/__calls') { res.end(JSON.stringify(calls)); return; }
    if (req.url === '/__reset') { calls = []; res.end('{}'); return; }
    if (req.url.startsWith('/__fail')) { const s = Number(new URL(req.url, 'http://x').searchParams.get('status')); failNext = { status: s, left: 3 }; res.end('{}'); return; }
    const body = JSON.parse(raw || '{}');
    const errs = validate(body);
    calls.push({ url: req.url, beta: req.headers['anthropic-beta'] || null, apiKey: req.headers['x-api-key'] ? 'present' : 'missing', authHeaders: Object.keys(req.headers).filter((h) => /key|auth/i.test(h)), model: body.model, fallbacks: body.fallbacks, cache_control: body.cache_control, output_config: body.output_config, tools: (body.tools || []).map((t) => t.name), messages: body.messages.length, errors: errs });
    if (failNext) { const s = failNext.status; if (--failNext.left <= 0) failNext = null; res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: s === 429 ? 'rate_limit_error' : s === 401 ? 'authentication_error' : 'api_error', message: 'mock failure' } })); return; }
    if (errs.length) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: errs.join('; ') } })); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(script(body)));
  });
}).listen(PORT, '127.0.0.1', () => console.log(`mock Messages API on ${PORT}`));
