// Assistant API used the way the mobile app calls it (cartify-mobile/src/api/client.ts): no cookies,
// guest via X-Session-Id, signed-in user via Bearer. Same setup as tests/ai.agents.mjs (mock LLM).
const B = process.env.API_URL || 'http://localhost:3001';
const call = async (path, { method = 'GET', body, sid, token } = {}) => {
  const h = { Accept: 'application/json' };
  if (body) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`; else if (sid) h['X-Session-Id'] = sid;
  const r = await fetch(B + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, credentials: 'omit' });
  return { status: r.status, sid: r.headers.get('x-session-id'), data: await r.json().catch(() => ({})) };
};
let ok = 0, bad = 0; const t = (n, c, i) => (c ? (ok++, console.log('  ok  ', n)) : (bad++, console.log('  FAIL', n, JSON.stringify(i).slice(0, 200))));
const first = await call('/assistant/status'); const sid = first.sid;
t('guest gets X-Session-Id', !!sid, first);
let r = await call('/assistant/chat', { method: 'POST', body: { message: 'I need wireless headphones under $200' }, sid });
t('guest chat via header session', r.status === 200 && r.data.reply.blocks[0].fullProducts?.length === 2 && r.data.reply.blocks[0].fullProducts[0].variants, r.data);
const conv = r.data.conversationId;
r = await call(`/assistant/conversations/${conv}`, { sid });
t('reopen transcript with same session', r.status === 200 && r.data.transcript.length === 2, r.data);
r = await call(`/assistant/conversations/${conv}`, { sid: crypto.randomUUID() });
t('other session cannot read it', r.status === 404, r.data);
r = await call('/assistant/chat', { method: 'POST', body: { message: 'Great, add the first one', conversationId: conv }, sid });
const a = r.data.reply.blocks.find((b) => b.type === 'confirm_action');
r = await call(`/assistant/actions/${a.actionId}/confirm`, { method: 'POST', body: { conversationId: conv }, sid });
t('guest confirm adds to the header-session cart', r.status === 200, r.data);
r = await call('/cart', { sid });
t('cart (mobile) has the item', r.data.totalQuantity === 1, r.data.totalQuantity);
const login = await call('/users/auth', { method: 'POST', body: { email: `mobile.${Date.now()}@example.com` } });
r = await call('/assistant/chat', { method: 'POST', body: { message: 'show my cart and orders' }, token: login.data.token });
t('signed-in chat via Bearer', r.status === 200 && r.data.toolCalls.includes('get_cart'), r.data);
r = await call(`/assistant/conversations/${conv}`, { token: login.data.token });
t('user cannot open a guest conversation', r.status === 404);
console.log(`${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
