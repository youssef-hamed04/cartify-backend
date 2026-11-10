// Regression test for the EXISTING Cartify endpoints (auth, catalog, cart, wishlist, orders, returns).
// It was run before and after the AI features were added. It creates users/orders: use a TEST database.
// Usage: node tests/api.regression.mjs [baseUrl]
const BASE = process.argv[2] || 'http://localhost:3001';
let pass = 0, fail = 0;
const results = [];

class Client {
  constructor(name) { this.name = name; this.cookies = {}; this.bearer = null; this.sid = null; }
  async req(method, path, body, { expect } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.Cookie = cookie;
    if (this.bearer) headers.Authorization = `Bearer ${this.bearer}`;
    if (this.sid) headers['X-Session-Id'] = this.sid;
    const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (v === '' || /Expires=Thu, 01 Jan 1970/i.test(c)) delete this.cookies[k]; else this.cookies[k] = v;
    }
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data, headers: res.headers };
  }
}

function check(name, cond, info = '') {
  if (cond) { pass++; results.push(`  ok   ${name}`); }
  else { fail++; results.push(`  FAIL ${name} ${info}`); }
}

const guest = new Client('guest');
const user = new Client('user');
const other = new Client('other');
const admin = new Client('admin');
const mobile = new Client('mobile');

// ── Catalog
let r = await guest.req('GET', '/products?limit=5');
check('GET /products', r.status === 200 && r.data.products?.length === 5 && r.data.total > 0, r.status);
const products = (await guest.req('GET', '/products?limit=100')).data.products;
const p1 = products.find((p) => p.variants?.some((v) => v.stock - v.reserved > 3));
const p2 = products.find((p) => p._id !== p1._id && p.variants?.some((v) => v.stock - v.reserved > 3));
r = await guest.req('GET', '/products?search=' + encodeURIComponent(p1.name.split(' ')[0]));
check('GET /products?search', r.status === 200 && r.data.products.length > 0);
r = await guest.req('GET', `/products/${p1._id}`);
check('GET /products/:id', r.status === 200 && r.data.product?._id === p1._id);
r = await guest.req('GET', `/products/slug/${p1.slug}`);
check('GET /products/slug/:slug', r.status === 200);
r = await guest.req('GET', '/products/categories');
check('GET /products/categories', r.status === 200 && r.data.categories?.length > 0);
r = await guest.req('GET', '/categories');
check('GET /categories', r.status === 200);
r = await guest.req('GET', '/products/000000000000000000000000');
check('GET /products/:id 404', r.status === 404);
r = await guest.req('GET', '/lockers');
check('GET /lockers', r.status === 200 && Array.isArray(r.data.lockers));
r = await guest.req('GET', '/orders/shipping-rates');
check('GET /orders/shipping-rates', r.status === 200);

// ── Guest cart (cookie session)
const v1 = p1.variants.find((v) => v.stock - v.reserved > 3);
r = await guest.req('POST', '/cart', { productId: p1._id, color: v1.color, quantity: 1 });
check('guest POST /cart', r.status === 200 && r.data.totalQuantity === 1, JSON.stringify(r.data).slice(0, 200));
r = await guest.req('PATCH', '/cart/add-quantity', { productId: p1._id, color: v1.color });
check('guest PATCH add-quantity', r.status === 200 && r.data.totalQuantity === 2);
r = await guest.req('PATCH', '/cart/reduce-quantity', { productId: p1._id, color: v1.color });
check('guest PATCH reduce-quantity', r.status === 200 && r.data.totalQuantity === 1);
r = await guest.req('GET', '/cart/quantity');
check('guest GET /cart/quantity', r.status === 200 && r.data.totalQuantity === 1);
r = await guest.req('PATCH', '/cart/remove-item', { productId: p1._id, color: v1.color });
check('guest remove-item', r.status === 200 && r.data.totalQuantity === 0);
r = await guest.req('POST', '/cart', { productId: 'bad', color: 'x' });
check('POST /cart validation 400', r.status === 400);

// ── Mobile-style guest (X-Session-Id header)
r = await mobile.req('GET', '/cart');
mobile.sid = r.headers.get('x-session-id');
check('mobile guest session header issued', !!mobile.sid);
mobile.cookies = {};
r = await mobile.req('POST', '/cart', { productId: p1._id, color: v1.color, quantity: 1 });
check('mobile guest POST /cart via X-Session-Id', r.status === 200 && r.data.totalQuantity === 1);
await mobile.req('PATCH', '/cart/empty');

// ── Wishlist
r = await guest.req('POST', '/wishlist/toggle', { productId: p1._id });
check('wishlist toggle add', r.status === 200 && r.data.added === true, JSON.stringify(r.data).slice(0, 120));
r = await guest.req('POST', '/wishlist/toggle', { productId: p1._id });
check('wishlist toggle remove', r.status === 200 && r.data.added === false);

// ── Auth
const stamp = Date.now();
r = await user.req('POST', '/users/auth', { email: `reg.user.${stamp}@example.com` });
check('POST /users/auth (customer)', (r.status === 200 || r.status === 201) && !!r.data.token);
r = await user.req('GET', '/users/me');
check('GET /users/me', r.status === 200 && r.data.user?.email === `reg.user.${stamp}@example.com`);
r = await other.req('POST', '/users/auth', { email: `reg.other.${stamp}@example.com` });
other.bearer = r.data.token; other.cookies = {};
r = await other.req('GET', '/users/me');
check('Bearer auth (mobile style)', r.status === 200);
r = await admin.req('POST', '/users/auth', { email: 'admin@cartify.com', password: 'wrong' });
check('admin wrong password 401', r.status === 401);
r = await admin.req('POST', '/users/auth', { email: 'admin@cartify.com', password: 'Admin@12345' });
check('admin login', r.status === 200 && r.data.user?.role === 'admin');
r = await user.req('GET', '/users');
check('non-admin GET /users 403', r.status === 403);
r = await admin.req('GET', '/users?limit=1');
check('admin GET /users', r.status === 200);

// ── Order flow (logged-in user)
r = await user.req('POST', '/cart', { productId: p2._id, color: p2.variants.find((v) => v.stock - v.reserved > 3).color, quantity: 2 });
check('user POST /cart', r.status === 200 && r.data.totalQuantity === 2);
const stockBefore = (await guest.req('GET', `/products/${p2._id}`)).data.product.variants;
r = await user.req('POST', '/orders', {
  email: `reg.user.${stamp}@example.com`, firstName: 'Reg', lastName: 'Tester', phone: '01012345678',
  address: '12 Test Street', city: 'Mansoura', governorate: 'Dakahlia', paymentMethod: 'cash',
});
check('POST /orders', r.status === 201 && r.data.order?.randomId, JSON.stringify(r.data).slice(0, 200));
const order = r.data.order;
const stockAfter = (await guest.req('GET', `/products/${p2._id}`)).data.product.variants;
const sumStock = (vs) => vs.reduce((a, v) => a + v.stock, 0);
check('order decrements stock', sumStock(stockBefore) - sumStock(stockAfter) === 2);
r = await user.req('GET', '/orders/my');
check('GET /orders/my', r.status === 200 && r.data.orders?.some((o) => o._id === order._id));
r = await user.req('GET', `/orders/${order._id}`);
check('GET /orders/:id owner', r.status === 200);
r = await other.req('GET', `/orders/${order._id}`);
check('GET /orders/:id other user 403', r.status === 403);
r = await guest.req('GET', `/orders/${order._id}`);
check('GET /orders/:id guest 403', r.status === 403);
r = await admin.req('GET', '/orders?limit=5');
check('admin GET /orders', r.status === 200 && r.data.total >= 1);
r = await user.req('GET', '/orders?limit=5');
check('non-admin GET /orders 403', r.status === 403);
r = await admin.req('PATCH', `/orders/${order._id}`, { status: 'confirmed' });
check('admin PATCH /orders/:id status', r.status === 200 && r.data.order.status === 'confirmed');

// ── Returns
r = await user.req('POST', '/returns', { orderId: order._id, reason: 'changed_mind', items: [{ productId: order.products[0].productId._id || order.products[0].productId, name: order.products[0].name, color: order.products[0].color, quantity: 1 }] });
check('POST /returns', (r.status === 201 || r.status === 200) && r.data.returnRequest, JSON.stringify(r.data).slice(0, 200));
r = await other.req('POST', '/returns', { orderId: order._id, reason: 'changed_mind', items: [{ productId: p2._id, name: 'x', color: 'x', quantity: 1 }] });
check('POST /returns other user 403', r.status === 403);
r = await user.req('GET', '/returns/my');
check('GET /returns/my', r.status === 200 && r.data.returns?.length >= 1);
r = await admin.req('GET', '/returns?limit=5');
check('admin GET /returns', r.status === 200);

// ── Cancel restores stock
r = await admin.req('PATCH', `/orders/${order._id}/cancel`);
check('admin cancel order', r.status === 200 && r.data.order.status === 'cancelled');
const stockRestored = (await guest.req('GET', `/products/${p2._id}`)).data.product.variants;
check('cancel restores stock', sumStock(stockRestored) === sumStock(stockBefore));

// ── Logout
r = await user.req('POST', '/users/logout');
check('POST /users/logout', r.status === 200);
r = await user.req('GET', '/users/me');
check('after logout /users/me 401', r.status === 401);

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
