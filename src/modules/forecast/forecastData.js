// Builds the daily sales history the forecasting model trains on, from one of two sources:
//   • orders          — real Cartify orders (online store; branch orders when order.branchId is set),
//                       with stockout days taken from daily inventory snapshots where they exist.
//   • synthetic_demo  — the clearly labelled demonstration dataset from `npm run seed:ai-demo`.
// FORECAST_DATA_SOURCE=auto (default) uses real orders as soon as there is enough history.
import orderModel from '../../../db/models/order.model.js';
import productModel from '../../../db/models/product.model.js';
import branchModel from '../../../db/models/branch.model.js';
import branchInventoryModel from '../../../db/models/branchInventory.model.js';
import syntheticSaleModel from '../../../db/models/syntheticSale.model.js';
import inventorySnapshotModel from '../../../db/models/inventorySnapshot.model.js';

export const DAY_MS = 86_400_000;
export const MIN_ORDER_HISTORY_DAYS = 56;   // distinct days with sales
export const MIN_ORDER_SPAN_DAYS = 120;     // first order at least this long ago
const DEMAND_STATUSES = { $nin: ['cancelled'] }; // refunded orders still were demand

export const utcDay = (d = new Date()) => { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return x; };
export const isoDay = (d) => utcDay(d).toISOString().slice(0, 10);
const finalPrice = (p) => +(p.price * (1 - (p.discount || 0) / 100 + (p.raise || 0) / 100)).toFixed(2);
const lookbackDays = () => Math.min(Math.max(parseInt(process.env.FORECAST_LOOKBACK_DAYS, 10) || 730, 120), 1095);

export async function detectDataSource() {
  const pref = (process.env.FORECAST_DATA_SOURCE || 'auto').trim();
  const since = new Date(Date.now() - lookbackDays() * DAY_MS);
  const [orders] = await orderModel.aggregate([
    { $match: { createdAt: { $gte: since }, status: DEMAND_STATUSES } },
    { $unwind: '$products' },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, units: { $sum: '$products.quantity' } } },
    { $group: { _id: null, days: { $sum: 1 }, units: { $sum: '$units' }, first: { $min: '$_id' } } },
  ]);
  const orderStats = { days: orders?.days || 0, units: orders?.units || 0, firstDay: orders?.first || null };
  const spanDays = orderStats.firstDay ? Math.floor((Date.now() - new Date(orderStats.firstDay)) / DAY_MS) : 0;
  const ordersEnough = orderStats.days >= MIN_ORDER_HISTORY_DAYS && spanDays >= MIN_ORDER_SPAN_DAYS;
  const syntheticRows = await syntheticSaleModel.estimatedDocumentCount();

  let source = null;
  let reason;
  if (pref === 'orders') { source = 'orders'; reason = 'FORECAST_DATA_SOURCE=orders'; }
  else if (pref === 'synthetic_demo') { source = syntheticRows ? 'synthetic_demo' : null; reason = 'FORECAST_DATA_SOURCE=synthetic_demo'; }
  else if (ordersEnough) { source = 'orders'; reason = 'Enough real order history'; }
  else if (syntheticRows) {
    source = 'synthetic_demo';
    reason = `Only ${orderStats.days} days of real order history (needs ${MIN_ORDER_HISTORY_DAYS} days over at least ${MIN_ORDER_SPAN_DAYS} days), so the synthetic demo dataset is used`;
  } else {
    reason = `Only ${orderStats.days} days of real order history (needs ${MIN_ORDER_HISTORY_DAYS} days over at least ${MIN_ORDER_SPAN_DAYS} days) and no demo dataset. Run \`npm run seed:ai-demo\` to try forecasting with synthetic data.`;
  }
  return { source, preference: pref, reason, orders: { ...orderStats, spanDays, enough: ordersEnough }, synthetic: { rows: syntheticRows } };
}

// ── Series builders ────────────────────────────────────────────────────────────────────────────
// Each series: { key, productId, branchId, category, start, sales[], inStock[], price[], discount[] },
// one value per day from `start` to `asOf` (both inclusive).

async function syntheticSeries({ withLatent = false } = {}) {
  const last = await syntheticSaleModel.findOne().sort({ date: -1 }).select('date').lean();
  if (!last) return { asOf: null, series: [] };
  const asOf = utcDay(last.date);
  const rows = await syntheticSaleModel.find().sort({ productId: 1, branchId: 1, date: 1 })
    .select('productId branchId date unitsSold unitPrice discount inStock latentDemand').lean();
  const products = new Map((await productModel.find({ _id: { $in: [...new Set(rows.map((r) => String(r.productId)))] } }).select('category').lean()).map((p) => [String(p._id), p]));
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.productId}:${r.branchId || 'online'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const series = [];
  for (const [key, list] of groups) {
    const product = products.get(String(list[0].productId));
    if (!product) continue; // product deleted since the demo data was generated
    const start = utcDay(list[0].date);
    const n = Math.round((asOf - start) / DAY_MS) + 1;
    const sales = Array(n).fill(0), inStock = Array(n).fill(1), price = Array(n).fill(list[0].unitPrice), discount = Array(n).fill(0);
    const latent = withLatent ? Array(n).fill(0) : null;
    for (const r of list) {
      const i = Math.round((utcDay(r.date) - start) / DAY_MS);
      if (i < 0 || i >= n) continue;
      sales[i] = r.unitsSold; inStock[i] = r.inStock ? 1 : 0; price[i] = r.unitPrice; discount[i] = r.discount || 0;
      if (latent) latent[i] = r.latentDemand ?? r.unitsSold;
    }
    series.push({ key, productId: String(list[0].productId), branchId: list[0].branchId ? String(list[0].branchId) : null, category: product.category, start: isoDay(start), sales, inStock, price, discount, ...(latent ? { latentDemand: latent } : {}) });
  }
  return { asOf, series };
}

async function orderSeries() {
  const asOf = utcDay(new Date(Date.now() - DAY_MS)); // last complete day
  const from = new Date(asOf.getTime() - (lookbackDays() - 1) * DAY_MS);
  const until = new Date(asOf.getTime() + DAY_MS);
  const [products, daily, branchRows, snapshots] = await Promise.all([
    productModel.find({ hide: false }).select('category price discount raise createdAt').lean(),
    orderModel.aggregate([
      { $match: { createdAt: { $gte: from, $lt: until }, status: DEMAND_STATUSES } },
      { $unwind: '$products' },
      { $group: { _id: { p: '$products.productId', b: { $ifNull: ['$branchId', null] }, d: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } } }, units: { $sum: '$products.quantity' }, price: { $avg: '$products.unitPrice' } } },
    ]),
    branchInventoryModel.find().select('branchId productId').lean(),
    inventorySnapshotModel.find({ date: { $gte: from, $lt: until } }).select('date branchId productId onHand reserved').lean(),
  ]);
  const productMap = new Map(products.map((p) => [String(p._id), p]));
  const keys = new Set(products.map((p) => `${p._id}:online`));
  for (const r of branchRows) if (productMap.has(String(r.productId))) keys.add(`${r.productId}:${r.branchId}`);
  for (const r of daily) if (productMap.has(String(r._id.p))) keys.add(`${r._id.p}:${r._id.b || 'online'}`);

  const salesByKey = new Map();
  for (const r of daily) {
    const key = `${r._id.p}:${r._id.b || 'online'}`;
    if (!salesByKey.has(key)) salesByKey.set(key, new Map());
    salesByKey.get(key).set(r._id.d, r);
  }
  const outOfStock = new Set(); // "key|day" where available stock was 0
  for (const s of snapshots) if ((s.onHand || 0) - (s.reserved || 0) <= 0) outOfStock.add(`${s.productId}:${s.branchId || 'online'}|${isoDay(s.date)}`);

  const series = [];
  for (const key of keys) {
    const [productId, branch] = key.split(':');
    const p = productMap.get(productId);
    const start = new Date(Math.max(from.getTime(), utcDay(p.createdAt).getTime()));
    const n = Math.round((asOf - start) / DAY_MS) + 1;
    if (n < 1) continue;
    const current = finalPrice(p);
    const sales = Array(n).fill(0), inStock = Array(n).fill(1), price = Array(n).fill(current), discount = Array(n).fill(p.discount || 0);
    const byDay = salesByKey.get(key);
    for (let i = 0; i < n; i++) {
      const day = isoDay(new Date(start.getTime() + i * DAY_MS));
      const hit = byDay?.get(day);
      if (hit) { sales[i] = hit.units; price[i] = +hit.price.toFixed(2); }
      if (outOfStock.has(`${key}|${day}`)) inStock[i] = 0;
    }
    series.push({ key, productId, branchId: branch === 'online' ? null : branch, category: p.category, start: isoDay(start), sales, inStock, price, discount });
  }
  return { asOf, series, snapshotDays: new Set(snapshots.map((s) => isoDay(s.date))).size };
}

export async function loadSeries(source, opts = {}) {
  const out = source === 'synthetic_demo' ? await syntheticSeries(opts) : await orderSeries();
  return { source, ...out };
}

// ── Weekly history for one product (charts) ──────────────────────────────────────────────────
export async function weeklyHistory(source, productId, { branchId = 'all', weeks = 26, asOf } = {}) {
  const end = utcDay(asOf || new Date(Date.now() - DAY_MS));
  const from = new Date(end.getTime() - (weeks * 7 - 1) * DAY_MS);
  const buckets = [...Array(weeks)].map((_, i) => ({ weekStart: isoDay(new Date(from.getTime() + i * 7 * DAY_MS)), units: 0, stockoutDays: 0 }));
  const bucketOf = (d) => Math.floor((utcDay(d) - from) / (7 * DAY_MS));
  const branchFilter = branchId === 'all' ? {} : { branchId: branchId === 'online' ? null : branchId };
  if (source === 'synthetic_demo') {
    const rows = await syntheticSaleModel.find({ productId, date: { $gte: from, $lte: end }, ...branchFilter }).select('date unitsSold inStock').lean();
    for (const r of rows) { const b = buckets[bucketOf(r.date)]; if (!b) continue; b.units += r.unitsSold; if (!r.inStock) b.stockoutDays += 1; }
  } else {
    const match = { createdAt: { $gte: from, $lt: new Date(end.getTime() + DAY_MS) }, status: DEMAND_STATUSES, 'products.productId': productId };
    if (branchId !== 'all') match.branchId = branchId === 'online' ? null : branchId;
    const orders = await orderModel.find(match).select('createdAt products.productId products.quantity').lean();
    for (const o of orders) { const b = buckets[bucketOf(o.createdAt)]; if (!b) continue; for (const it of o.products) if (String(it.productId) === String(productId)) b.units += it.quantity; }
    const snaps = await inventorySnapshotModel.find({ productId, date: { $gte: from, $lte: end }, ...branchFilter }).select('date onHand reserved').lean();
    for (const s of snaps) if ((s.onHand || 0) - (s.reserved || 0) <= 0) { const b = buckets[bucketOf(s.date)]; if (b) b.stockoutDays += 1; }
  }
  return buckets;
}

export const branchNameMap = async () => new Map((await branchModel.find().select('name').lean()).map((b) => [String(b._id), b.name]));
