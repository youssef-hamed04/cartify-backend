// Forecast + branch inventory workflow test (no LLM). Creates movements: use a TEST database seeded
// with `npm run seed` and `npm run seed:ai-demo`, with the AI service running.
// Usage: node tests/inventory.workflow.mjs
const BASE = process.env.API_URL || 'http://localhost:3001';
let pass = 0, fail = 0;
const ok = (name, cond, info = '') => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name, typeof info === 'string' ? info : JSON.stringify(info).slice(0, 300)); } };
const call = async (method, path, { token, body } = {}) => {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

const admin = (await call('POST', '/users/auth', { body: { email: 'admin@cartify.com', password: 'Admin@12345' } })).data.token;
const user = (await call('POST', '/users/auth', { body: { email: `inv.user.${Date.now()}@example.com` } })).data.token;

console.log('forecasting');
let r = await call('GET', '/forecasts/status', { token: admin });
ok('status: AI service reachable + data source found', r.data.aiService?.reachable && r.data.data?.source, r.data);
r = await call('POST', '/forecasts/run', { token: admin, body: {} });
ok('run forecast (7/30/90 days)', r.status === 201 && r.data.horizons.length === 3, r.data);
for (const h of r.data.horizons || []) {
  const base = h.candidates.find((c) => c.name === 'moving_average_28d');
  const best = h.candidates.find((c) => c.name === h.selectedModel);
  ok(`${h.horizonDays}d: selected model has the lowest test MAE (${h.selectedModel} ${best?.mae} vs baseline ${base?.mae})`, best && h.candidates.every((c) => c.mae >= best.mae));
}
r = await call('GET', '/forecasts/latest?horizonDays=30&limit=5', { token: admin });
ok('latest forecast rows with stock + replenishment', r.data.rows?.length === 5 && r.data.rows.every((x) => 'suggestedReplenishment' in x && 'shortageRisk' in x && x.low <= x.predictedDemand && x.predictedDemand <= x.high), r.data.rows?.[0]);
ok('synthetic data is labelled', r.data.run.isSynthetic === false || /Synthetic/.test(r.data.run.dataLabel));
const pid = r.data.rows[0].productId;
r = await call('GET', `/forecasts/products/${pid}?horizonDays=30`, { token: admin });
ok('product chart data (26 weekly buckets)', r.data.history?.length === 26 && r.data.total, r.data);
r = await call('GET', '/forecasts/latest?horizonDays=30&groupBy=product&trend=increasing&limit=50', { token: admin });
ok('trend filter + product grouping', r.data.rows.every((x) => x.trend === 'increasing' && x.locations >= 1));
r = await call('GET', '/forecasts/latest?horizonDays=45', { token: admin });
ok('invalid horizon rejected', r.status === 400);

console.log('inventory');
r = await call('GET', '/inventory/overview', { token: admin });
ok('overview', r.data.branches?.length > 0 && r.data.lowestInventory, r.data);
r = await call('POST', '/inventory/recommendations/generate', { token: admin, body: { horizonDays: 30 } });
ok('generate recommendations', r.status === 201 && r.data.created > 0, r.data);
r = await call('GET', '/inventory/recommendations?type=stock_transfer&limit=1', { token: admin });
const rec = r.data.recommendations?.[0];
ok('pending transfer recommendation with reasoning', rec && rec.reasoning.length > 40 && rec.suggestedAction.quantity > 0, r.data);
const stock = async () => {
  const d = (await call('GET', `/inventory/products/${rec.product.id}`, { token: admin })).data;
  const s = d.branches.find((b) => b.branchId === rec.from.id), t = d.branches.find((b) => b.branchId === rec.to.id);
  return { src: s.quantity, srcRes: s.reserved, dst: t.quantity };
};
const s0 = await stock();
r = await call('PATCH', `/inventory/recommendations/${rec.id}/approve`, { token: user });
ok('customer cannot approve', r.status === 403);
r = await call('PATCH', `/inventory/recommendations/${rec.id}/approve`, { token: admin, body: { note: 'test' } });
const mv = r.data.movement;
ok('approve creates an APPROVED movement', r.status === 200 && mv.status === 'approved', r.data);
const s1 = await stock();
ok('approval reserves stock but moves nothing', s1.srcRes === s0.srcRes + mv.quantity && s1.src === s0.src && s1.dst === s0.dst, { s0, s1 });
r = await call('PATCH', `/inventory/recommendations/${rec.id}/approve`, { token: admin });
ok('second approval rejected', r.status === 409);
r = await call('PATCH', `/inventory/movements/${mv._id}/complete`, { token: admin });
const s2 = await stock();
ok('complete moves the units', r.status === 200 && s2.src === s0.src - mv.quantity && s2.srcRes === s0.srcRes && s2.dst === s0.dst + mv.quantity, { s0, s2 });
r = await call('PATCH', `/inventory/movements/${mv._id}/complete`, { token: admin });
ok('completing twice rejected', r.status === 409);
r = await call('POST', '/inventory/movements', { token: admin, body: { productId: rec.product.id, sourceBranchId: rec.to.id, destinationBranchId: rec.from.id, quantity: 99999 } });
const big = r.data.movement;
r = await call('PATCH', `/inventory/movements/${big._id}/approve`, { token: admin });
ok('approval refused when the source lacks stock', r.status === 409, r.data);
r = await call('PATCH', `/inventory/movements/${big._id}/reject`, { token: admin, body: { note: 'too big' } });
ok('reject request', r.data.movement?.status === 'rejected');
r = await call('POST', '/inventory/movements', { token: admin, body: { productId: rec.product.id, sourceBranchId: rec.to.id, destinationBranchId: rec.from.id, quantity: 1 } });
const small = r.data.movement;
await call('PATCH', `/inventory/movements/${small._id}/approve`, { token: admin });
r = await call('PATCH', `/inventory/movements/${small._id}/cancel`, { token: admin });
const s3 = await stock();
ok('cancel releases the reservation', r.data.movement?.status === 'cancelled' && s3.srcRes === s2.srcRes && s3.dst === s2.dst, { s2, s3 });
r = await call('POST', '/inventory/movements', { token: admin, body: { productId: rec.product.id, sourceBranchId: rec.from.id, destinationBranchId: rec.from.id, quantity: 1 } });
ok('same-branch transfer rejected', r.status === 400);
r = await call('POST', '/inventory/movements', { token: admin, body: { productId: 'x', quantity: -1 } });
ok('invalid body rejected', r.status === 400 && r.data.errors?.length >= 3);
r = await call('PATCH', `/inventory/branches/${rec.from.id}/products/${rec.product.id}`, { token: admin, body: { quantity: s3.src + 5, reason: 'count' } });
ok('stock adjustment logged', r.status === 200 && (await call('GET', '/inventory/movements?type=adjustment&limit=1', { token: admin })).data.movements[0].delta === 5);
r = await call('GET', '/inventory/anomalies', { token: admin });
ok('anomaly detection', r.status === 200 && Array.isArray(r.data.anomalies));
r = await call('GET', '/inventory/report?horizonDays=30', { token: admin });
ok('inventory report', r.data.report?.branches?.length > 0);

console.log('authorization');
for (const path of ['/forecasts/latest', '/forecasts/status', '/inventory/overview', '/inventory/movements', '/branches', '/inventory/report']) {
  const [u, g] = await Promise.all([call('GET', path, { token: user }), call('GET', path)]);
  ok(`${path}: customer 403, guest 401`, u.status === 403 && g.status === 401, [u.status, g.status]);
}
r = await call('POST', '/forecasts/run', { token: user, body: {} });
ok('customer cannot run forecasts', r.status === 403);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
