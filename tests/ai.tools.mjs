// Direct test of every agent tool handler against the running API (no LLM involved).
// Needs: a running backend on a TEST database seeded with `npm run seed` + `npm run seed:ai-demo`,
// the AI service running, and one forecast run (POST /forecasts/run). Usage: node tests/ai.tools.mjs
import { shoppingTools } from '../src/modules/assistant/shopping.tools.js';
import { inventoryTools } from '../src/modules/assistant/inventory.tools.js';
import { validateToolInput } from '../src/modules/assistant/toolSchema.js';

const BASE = process.env.API_URL || 'http://localhost:3001';
process.env.INTERNAL_API_URL ||= BASE; // tools call the API under test
let pass = 0, fail = 0;
const ok = (name, cond, info = '') => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name, info); } };
const post = async (path, body, headers = {}) => (await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })).json();
const tool = (list, name) => list.find((t) => t.name === name);
async function run(list, name, input, ctx) {
  const t = tool(list, name);
  const v = validateToolInput(t.input_schema, input);
  if (!v.ok) throw new Error('validation: ' + v.errors.join('; '));
  return t.handler(v.value, { ...ctx, blocks: [], cache: {} });
}

const guestSid = (await fetch(BASE + '/cart')).headers.get('x-session-id');
const guest = { api: { token: null, sessionId: guestSid, user: null }, conversation: { pendingActions: [] } };
const ut = (await post('/users/auth', { email: `tools.${Date.now()}@example.com` })).token;
const user = { api: { token: ut, sessionId: null, user: { id: 'x', role: 'user' } }, conversation: { pendingActions: [] } };
const at = (await post('/users/auth', { email: 'admin@cartify.com', password: 'Admin@12345' })).token;
const admin = { api: { token: at, sessionId: null, user: { id: 'a', role: 'admin' } }, conversation: { pendingActions: [] } };

console.log('shopping tools');
let r = await run(shoppingTools, 'get_catalog_overview', {}, guest);
ok('catalog overview', r.data.categories.length > 0 && r.data.brands.length > 0);
r = await run(shoppingTools, 'search_products', { keywords: ['headphone', 'audio', 'wireless'], maxPrice: 300, limit: 5 }, guest);
ok('search with budget', r.data.products.length > 0 && r.data.products.every((p) => p.price <= 300), JSON.stringify(r.data).slice(0, 200));
console.log('     ', r.data.products.map((p) => `${p.name} $${p.price}`).join(' | '));
const pids = r.data.products.map((p) => p.id);
r = await run(shoppingTools, 'search_products', { keywords: ['zzqqxx'] }, guest);
ok('search no match hint', r.data.totalMatches === 0 && r.data.hint);
r = await run(shoppingTools, 'search_products', { category: 'Electronics', sort: 'price_asc', limit: 3 }, guest);
ok('browse category sorted', r.data.products.length === 3 && r.data.products[0].price <= r.data.products[1].price);
r = await run(shoppingTools, 'get_product_details', { productId: pids[0] }, guest);
ok('product details', r.data.product.id === pids[0] && Array.isArray(r.data.latestReviews));
r = await run(shoppingTools, 'compare_products', { productIds: pids.slice(0, 3) }, guest);
ok('compare + block', r.data.products.length === 3 && r.block.type === 'comparison');
r = await run(shoppingTools, 'check_product_availability', { productId: pids[0], quantity: 2 }, guest);
ok('availability', typeof r.data.canOrder === 'boolean' && r.data.colors.length > 0);
const color = r.data.colors.find((c) => c.available > 2)?.color;
try { await run(shoppingTools, 'add_to_cart', { productId: pids[0], color: 'NoSuchColour' }, guest); ok('add_to_cart bad colour rejected', false); } catch (e) { ok('add_to_cart bad colour rejected', e.isToolError, e.message); }
r = await run(shoppingTools, 'add_to_cart', { productId: pids[0], color, quantity: 1 }, guest);
ok('add_to_cart creates pending action only', r.data.status === 'awaiting_customer_confirmation' && guest.conversation.pendingActions.length === 1 && r.block.type === 'confirm_action');
r = await run(shoppingTools, 'get_cart', {}, guest);
ok('cart still empty (nothing added without confirm)', r.data.totalQuantity === 0, JSON.stringify(r.data));
try { await run(shoppingTools, 'show_products', { productIds: ['000000000000000000000000'] }, guest); ok('show_products unknown id rejected', false); } catch (e) { ok('show_products unknown id rejected', e.isToolError); }
r = await run(shoppingTools, 'show_products', { productIds: pids.slice(0, 2), title: 'Picks' }, guest);
ok('show_products block', r.block.type === 'products' && r.block.products.length === 2 && r.block.products[0].image !== undefined);
ok('schema rejects bad id', !validateToolInput(tool(shoppingTools, 'show_products').input_schema, { productIds: ['abc'] }).ok);
ok('schema rejects unknown field', !validateToolInput(tool(shoppingTools, 'get_cart').input_schema, { userId: 'someone' }).ok);
ok('schema rejects quantity > 10', !validateToolInput(tool(shoppingTools, 'add_to_cart').input_schema, { productId: pids[0], quantity: 99 }).ok);

// orders: user places an order, then tracks it; another user cannot see it
await fetch(BASE + '/cart', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ut}` }, body: JSON.stringify({ productId: pids[0], color, quantity: 1 }) });
const me = await (await fetch(BASE + '/users/me', { headers: { Authorization: `Bearer ${ut}` } })).json();
const ord = await post('/orders', { email: me.user.email.replace('@example.com', '@example.com'), firstName: 'Tool', lastName: 'Tester', phone: '01012345678', address: '1 Test St', city: 'Mansoura', governorate: 'Dakahlia' }, { Authorization: `Bearer ${ut}` });
r = await run(shoppingTools, 'get_my_orders', {}, user);
ok('get_my_orders sees own order', r.data.orders.some((o) => o.orderNumber === ord.order?.randomId), JSON.stringify(ord).slice(0, 200));
r = await run(shoppingTools, 'track_order', { orderNumber: `#${ord.order.randomId.toLowerCase()}` }, user);
ok('track_order own order', r.data.found && r.data.history.length >= 1 && r.block.type === 'order');
r = await run(shoppingTools, 'track_order', { orderNumber: ord.order.randomId }, guest);
ok('track_order: guest cannot see user order', r.data.found === false);
r = await run(shoppingTools, 'get_my_orders', {}, guest);
ok('guest sees no orders', r.data.orders.length === 0 && r.data.note);
r = await run(shoppingTools, 'get_shopping_profile', {}, user);
ok('shopping profile', r.data.recentPurchases.length >= 1 && r.data.topCategories.length >= 1);

console.log('inventory tools (admin)');
const inv = (n, i = {}) => run(inventoryTools, n, i, admin);
r = await inv('get_all_branches'); ok('branches', r.data.branches.length === 4);
r = await inv('get_inventory_overview', { horizonDays: 30 }); ok('overview', r.data.branches.length === 4 && r.data.lowestInventoryBranch, JSON.stringify(r.data).slice(0, 200));
r = await inv('get_branch_inventory', { branch: 'University', status: 'low', limit: 3 }); ok('branch inventory by name', r.data.branch.name === 'University Branch' && r.data.items.length > 0);
r = await inv('get_product_stock_across_branches', { product: 'Smart Watch Series X' }); ok('product across branches by name', r.data.branches.length === 4);
r = await inv('get_branch_sales', { days: 30 }); ok('branch sales', r.data.branches.length >= 4 && r.data.isSynthetic === true);
r = await inv('get_demand_forecast', { horizonDays: 30, trend: 'increasing', groupBy: 'product', sort: 'growth', limit: 5 }); ok('forecast increasing', r.data.rows.length > 0 && r.data.rows.every((x) => x.trend === 'increasing') && r.data.model.name);
r = await inv('identify_low_stock', { branch: 'El-Mashaya Branch', limit: 5 }); ok('low stock', r.data.items.length > 0);
r = await inv('identify_excess_stock', { limit: 5 }); ok('excess', r.data.items.length > 0);
r = await inv('suggest_stock_transfer', { limit: 3 }); ok('suggest transfers', r.data.transfers.length > 0 && r.block.type === 'transfer_suggestions' && r.data.transfers[0].reasoning);
const t = r.block.transfers[0]; // full detail is in the UI block; the model gets a compact version
try { await inv('create_stock_transfer_request', { product: t.productId, fromBranch: t.from.branchId, toBranch: t.from.branchId, quantity: 1 }); ok('same-branch transfer rejected', false); } catch (e) { ok('same-branch transfer rejected', e.isToolError); }
try { await inv('create_stock_transfer_request', { product: t.productId, fromBranch: t.from.branchId, toBranch: t.to.branchId, quantity: 9999 }); ok('oversized transfer rejected', false); } catch (e) { ok('oversized transfer rejected', e.isToolError, e.message); }
r = await inv('create_stock_transfer_request', { product: t.productId, fromBranch: t.from.branchName, toBranch: t.to.branchName, quantity: t.quantity });
ok('transfer request is pending only', r.data.status === 'awaiting_admin_confirmation' && admin.conversation.pendingActions.length === 1);
r = await inv('get_stock_movement_history', { status: 'open' }); ok('movement history', typeof r.data.total === 'number');
r = await inv('get_recommendations', {}); ok('recommendations', typeof r.data.total === 'number');
r = await inv('detect_inventory_anomalies', {}); ok('anomalies', r.data.anomalies.length > 0);
r = await inv('generate_inventory_report', { horizonDays: 30 }); ok('report', r.data.branches.length === 4 && r.data.lowestInventoryBranch);
try { await inv('get_branch_inventory', { branch: 'Nowhere' }); ok('unknown branch rejected', false); } catch (e) { ok('unknown branch rejected', e.isToolError && /Branches:/.test(e.message)); }

console.log('authorization through the API');
for (const [label, ctx] of [['customer', user], ['guest', guest]]) {
  try { await run(inventoryTools, 'get_inventory_overview', {}, ctx); ok(`${label} blocked from inventory tools`, false); } catch (e) { ok(`${label} blocked from inventory tools`, e.isToolError && [401, 403].includes(e.status), `${e.status} ${e.message}`); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
