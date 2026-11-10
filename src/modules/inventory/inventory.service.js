// Branch & inventory intelligence: stock levels, shortages, surplus, transfer/replenishment
// suggestions and the stock-movement workflow. The REST endpoints and the inventory agent both call
// these functions, so the AI never has its own copy of the business rules.
//
// Stock only changes through explicit admin actions: approving a movement reserves stock at the
// source, completing it moves the units. Recommendations are proposals and change nothing.
import mongoose from 'mongoose';
import productModel from '../../../db/models/product.model.js';
import branchModel from '../../../db/models/branch.model.js';
import branchInventoryModel from '../../../db/models/branchInventory.model.js';
import stockMovementModel from '../../../db/models/stockMovement.model.js';
import aiRecommendationModel from '../../../db/models/aiRecommendation.model.js';
import syntheticSaleModel from '../../../db/models/syntheticSale.model.js';
import orderModel from '../../../db/models/order.model.js';
import { AppError } from '../../utils/error.js';
import { nextSequence } from '../../utils/counter.js';
import { policySettings } from './stockPolicy.js';
import { getForecastView, latestRun, loadStockContext } from '../forecast/forecast.service.js';
import { detectDataSource, DAY_MS, utcDay } from '../forecast/forecastData.js';

const RISK_RANK = { high: 3, medium: 2, low: 1, none: 0 };
const oid = (v, name = 'id') => {
  if (!mongoose.isValidObjectId(v)) throw new AppError(`Invalid ${name}`, 400);
  return new mongoose.Types.ObjectId(String(v));
};
const round = (n, d = 1) => (n == null ? null : +Number(n).toFixed(d));
const productImage = (p) => p?.variants?.[0]?.images?.[0]?.url || '';

function haversineKm(a, b) {
  if (!a?.lat || !b?.lat) return null;
  const R = 6371, toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return +(2 * R * Math.asin(Math.sqrt(h))).toFixed(1);
}

async function getBranchOrThrow(id) {
  const branch = await branchModel.findById(oid(id, 'branchId')).lean();
  if (!branch) throw new AppError('Branch not found', 404);
  return branch;
}

// Forecast rows for branches (online store excluded unless asked), with current stock.
async function branchForecastRows(horizonDays, { includeOnline = false } = {}) {
  const view = await getForecastView({ horizonDays, limit: 500 });
  const rows = includeOnline ? view.rows : view.rows.filter((r) => r.branchId);
  return { view, rows };
}

// ── Overview ──────────────────────────────────────────────────────────────────────────────────
export async function getOverview({ horizonDays = 30 } = {}) {
  const settings = policySettings();
  const [ctx, { view, rows }, branches, pendingRecs, openMovements] = await Promise.all([
    loadStockContext(), branchForecastRows(horizonDays, { includeOnline: true }), branchModel.find().sort({ name: 1 }).lean(),
    aiRecommendationModel.countDocuments({ status: 'pending' }),
    stockMovementModel.countDocuments({ status: { $in: ['requested', 'approved'] } }),
  ]);
  const byBranch = (id) => rows.filter((r) => (id ? r.branchId === String(id) : r.branchId === null));
  const summarise = (list) => ({
    predictedDemand: round(list.reduce((a, r) => a + r.predictedDemand, 0)),
    highRisk: list.filter((r) => r.shortageRisk === 'high').length,
    mediumRisk: list.filter((r) => r.shortageRisk === 'medium').length,
    surplusItems: list.filter((r) => r.surplusUnits >= settings.minTransferQty).length,
    excessItems: list.filter((r) => r.excessUnits > 0).length,
    increasing: list.filter((r) => r.trend === 'increasing').length,
    replenishmentUnits: list.reduce((a, r) => a + r.suggestedReplenishment, 0),
  });
  const out = branches.map((b) => {
    let units = 0, reserved = 0, skus = 0, zero = 0, lowNoForecast = 0;
    for (const [key, s] of ctx.stock) {
      if (!key.endsWith(`:${b._id}`)) continue;
      skus += 1; units += s.onHand; reserved += s.reserved;
      const available = s.onHand - s.reserved;
      if (available <= 0) zero += 1;
      if (available <= (s.safetyOverride ?? settings.lowStockUnits)) lowNoForecast += 1;
    }
    const f = byBranch(b._id);
    return {
      id: String(b._id), code: b.code, name: b.name, city: b.city, address: b.address, status: b.status, location: b.location, isDemo: b.isDemo,
      skus, units, reserved, available: units - reserved, outOfStock: zero,
      lowStock: f.length ? f.filter((r) => ['high', 'medium'].includes(r.shortageRisk)).length : lowNoForecast,
      forecast: f.length ? summarise(f) : null,
    };
  });
  const online = byBranch(null);
  const onlineUnits = [...ctx.products.values()].filter((p) => !p.hide).reduce((a, p) => a + (p.variants || []).reduce((x, v) => x + (v.stock || 0) - (v.reserved || 0), 0), 0);
  return {
    forecast: view.run, horizonDays: Number(horizonDays), settings,
    branches: out,
    online: { name: 'Online store', available: onlineUnits, forecast: online.length ? summarise(online) : null },
    lowestInventory: [...out].filter((b) => b.status === 'active').sort((a, b) => a.available - b.available)[0]?.name || null,
    pendingRecommendations: pendingRecs, openMovements,
  };
}

// ── Branch inventory ──────────────────────────────────────────────────────────────────────────
export async function getBranchInventory(branchId, { horizonDays = 30, status = 'all', search, sort = 'risk', page = 1, limit = 50 } = {}) {
  const branch = await getBranchOrThrow(branchId);
  const settings = policySettings();
  const [inv, { view, rows }] = await Promise.all([
    branchInventoryModel.find({ branchId: branch._id }).populate('productId', 'name category brand variants.images hide').lean(),
    branchForecastRows(horizonDays),
  ]);
  const fMap = new Map(rows.filter((r) => r.branchId === String(branch._id)).map((r) => [r.productId, r]));
  let items = inv.filter((r) => r.productId).map((r) => {
    const f = fMap.get(String(r.productId._id));
    const available = Math.max(0, r.quantity - r.reserved);
    return {
      productId: String(r.productId._id), productName: r.productId.name, category: r.productId.category, brand: r.productId.brand, image: productImage(r.productId),
      quantity: r.quantity, reserved: r.reserved, available, lastUpdated: r.updatedAt, safetyStockOverride: r.safetyStock,
      forecast: f ? {
        predictedDemand: f.predictedDemand, low: f.low, high: f.high, trend: f.trend, trendPct: f.trendPct, inbound: f.inbound, safetyStock: f.safetyStock,
        suggestedReplenishment: f.suggestedReplenishment, surplusUnits: f.surplusUnits, excessUnits: f.excessUnits, daysOfCover: f.daysOfCover, shortageRisk: f.shortageRisk,
      } : null,
      lowStock: f ? ['high', 'medium'].includes(f.shortageRisk) : available <= (r.safetyStock ?? settings.lowStockUnits),
    };
  });
  if (search) { const q = String(search).toLowerCase(); items = items.filter((i) => `${i.productName} ${i.category} ${i.brand}`.toLowerCase().includes(q)); }
  if (status === 'low') items = items.filter((i) => i.lowStock);
  else if (status === 'excess') items = items.filter((i) => (i.forecast?.surplusUnits || 0) >= settings.minTransferQty);
  else if (status === 'out') items = items.filter((i) => i.available <= 0);
  const sorters = {
    risk: (a, b) => RISK_RANK[b.forecast?.shortageRisk || 'none'] - RISK_RANK[a.forecast?.shortageRisk || 'none'] || a.available - b.available,
    available: (a, b) => a.available - b.available,
    surplus: (a, b) => (b.forecast?.surplusUnits || 0) - (a.forecast?.surplusUnits || 0),
    name: (a, b) => a.productName.localeCompare(b.productName),
  };
  items.sort(sorters[sort] || sorters.risk);
  const l = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200), p = Math.max(parseInt(page, 10) || 1, 1);
  return {
    branch: { id: String(branch._id), name: branch.name, code: branch.code, status: branch.status, address: branch.address },
    forecast: view.run, horizonDays: Number(horizonDays), total: items.length, page: p, limit: l, totalPages: Math.ceil(items.length / l),
    items: items.slice((p - 1) * l, p * l),
  };
}

export async function setInventory(branchId, productId, { quantity, safetyStock, reason }, user) {
  const branch = await getBranchOrThrow(branchId);
  const pid = oid(productId, 'productId');
  if (!(await productModel.exists({ _id: pid }))) throw new AppError('Product not found', 404);
  const current = await branchInventoryModel.findOne({ branchId: branch._id, productId: pid });
  const update = {};
  let delta = null;
  if (quantity !== undefined) {
    const q = Number(quantity);
    if (!Number.isInteger(q) || q < 0) throw new AppError('quantity must be a whole number ≥ 0', 400);
    if (current && q < current.reserved) throw new AppError(`quantity cannot be below the ${current.reserved} units reserved for approved transfers`, 400);
    delta = q - (current?.quantity || 0);
    update.quantity = q;
  }
  if (safetyStock !== undefined) update.safetyStock = safetyStock === null || safetyStock === '' ? null : Math.max(0, parseInt(safetyStock, 10) || 0);
  const row = await branchInventoryModel.findOneAndUpdate({ branchId: branch._id, productId: pid }, { $set: update }, { new: true, upsert: true, setDefaultsOnInsert: true });
  if (delta) {
    await stockMovementModel.create({
      movementNumber: await nextSequence('stockMovement'), type: 'adjustment', productId: pid, destinationBranchId: branch._id,
      quantity: Math.abs(delta), delta, status: 'completed', reason: reason || 'Manual stock adjustment', requestedBy: user?._id, requestedVia: 'dashboard',
      completedBy: user?._id, completedAt: new Date(), statusHistory: [{ status: 'completed', by: user?._id, note: reason || 'Manual stock adjustment' }],
    });
  }
  console.log(`[inventory] ${user?.email} set ${branch.code}/${pid} ${JSON.stringify(update)}${delta ? ` (Δ${delta})` : ''}`);
  return row;
}

// ── Product across branches ───────────────────────────────────────────────────────────────────
export async function getProductAcrossBranches(productId, { horizonDays = 30 } = {}) {
  const pid = oid(productId, 'productId');
  const product = await productModel.findById(pid).select('name category brand price discount raise variants').lean();
  if (!product) throw new AppError('Product not found', 404);
  const [branches, inv, { view, rows }, movements] = await Promise.all([
    branchModel.find().lean(),
    branchInventoryModel.find({ productId: pid }).lean(),
    branchForecastRows(horizonDays, { includeOnline: true }),
    stockMovementModel.find({ productId: pid, status: { $in: ['requested', 'approved'] } }).sort({ createdAt: -1 }).limit(20).lean(),
  ]);
  const fRows = rows.filter((r) => r.productId === String(pid));
  const locations = branches.map((b) => {
    const r = inv.find((x) => String(x.branchId) === String(b._id));
    const f = fRows.find((x) => x.branchId === String(b._id));
    return {
      branchId: String(b._id), branchName: b.name, status: b.status, quantity: r?.quantity || 0, reserved: r?.reserved || 0,
      available: Math.max(0, (r?.quantity || 0) - (r?.reserved || 0)), lastUpdated: r?.updatedAt || null,
      forecast: f ? { predictedDemand: f.predictedDemand, safetyStock: f.safetyStock, inbound: f.inbound, shortage: f.suggestedReplenishment, surplus: f.surplusUnits, daysOfCover: f.daysOfCover, shortageRisk: f.shortageRisk, trend: f.trend } : null,
    };
  });
  const onlineRow = fRows.find((x) => x.branchId === null);
  return {
    product: { id: String(product._id), name: product.name, category: product.category, brand: product.brand },
    forecast: view.run, horizonDays: Number(horizonDays),
    online: {
      available: (product.variants || []).reduce((a, v) => a + (v.stock || 0) - (v.reserved || 0), 0),
      variants: (product.variants || []).map((v) => ({ color: v.color, stock: v.stock, reserved: v.reserved })),
      forecast: onlineRow ? { predictedDemand: onlineRow.predictedDemand, shortageRisk: onlineRow.shortageRisk } : null,
    },
    branches: locations,
    totalBranchAvailable: locations.reduce((a, l) => a + l.available, 0),
    openMovements: movements.map((m) => ({ id: String(m._id), number: m.movementNumber, type: m.type, status: m.status, quantity: m.quantity, from: m.sourceBranchId, to: m.destinationBranchId })),
  };
}

// ── Branch sales ──────────────────────────────────────────────────────────────────────────────
export async function getBranchSales({ branchId, days = 30 } = {}) {
  const d = Math.min(Math.max(parseInt(days, 10) || 30, 7), 365);
  const run = await latestRun();
  const source = run?.dataSource || (await detectDataSource()).source || 'orders';
  const branches = await branchModel.find().select('name code').lean();
  const names = new Map(branches.map((b) => [String(b._id), b.name]));
  let end;
  let current = [], previous = [], top = [];
  const match = branchId && branchId !== 'all' ? { branchId: branchId === 'online' ? null : oid(branchId, 'branchId') } : {};
  if (source === 'synthetic_demo') {
    const last = await syntheticSaleModel.findOne().sort({ date: -1 }).select('date').lean();
    end = utcDay(last?.date || new Date());
    const from = new Date(end.getTime() - (d - 1) * DAY_MS), prevFrom = new Date(from.getTime() - d * DAY_MS);
    const agg = (lo, hi) => syntheticSaleModel.aggregate([
      { $match: { date: { $gte: lo, $lt: hi }, ...match } },
      { $group: { _id: '$branchId', units: { $sum: '$unitsSold' }, revenue: { $sum: { $multiply: ['$unitsSold', '$unitPrice'] } }, stockoutDays: { $sum: { $cond: ['$inStock', 0, 1] } } } },
    ]);
    [current, previous, top] = await Promise.all([
      agg(from, new Date(end.getTime() + DAY_MS)), agg(prevFrom, from),
      syntheticSaleModel.aggregate([
        { $match: { date: { $gte: from, $lte: end }, ...match } },
        { $group: { _id: { b: '$branchId', p: '$productId' }, units: { $sum: '$unitsSold' } } },
        { $sort: { units: -1 } }, { $limit: 200 },
      ]),
    ]);
  } else {
    end = utcDay(new Date(Date.now() - DAY_MS));
    const from = new Date(end.getTime() - (d - 1) * DAY_MS), prevFrom = new Date(from.getTime() - d * DAY_MS);
    const pipe = (lo, hi) => [
      { $match: { createdAt: { $gte: lo, $lt: hi }, status: { $ne: 'cancelled' }, ...(match.branchId !== undefined ? { branchId: match.branchId } : {}) } },
      { $unwind: '$products' },
    ];
    const agg = (lo, hi) => orderModel.aggregate([...pipe(lo, hi), { $group: { _id: { $ifNull: ['$branchId', null] }, units: { $sum: '$products.quantity' }, revenue: { $sum: { $multiply: ['$products.quantity', '$products.unitPrice'] } } } }]);
    [current, previous, top] = await Promise.all([
      agg(from, new Date(end.getTime() + DAY_MS)), agg(prevFrom, from),
      orderModel.aggregate([...pipe(from, new Date(end.getTime() + DAY_MS)), { $group: { _id: { b: { $ifNull: ['$branchId', null] }, p: '$products.productId' }, units: { $sum: '$products.quantity' } } }, { $sort: { units: -1 } }, { $limit: 200 }]),
    ]);
  }
  const productNames = new Map((await productModel.find({ _id: { $in: top.map((t) => t._id.p) } }).select('name').lean()).map((p) => [String(p._id), p.name]));
  const rows = current.map((c) => {
    const prev = previous.find((p) => String(p._id) === String(c._id));
    return {
      branchId: c._id ? String(c._id) : null, branchName: c._id ? names.get(String(c._id)) || 'Unknown branch' : 'Online store',
      units: c.units, revenue: round(c.revenue, 2), stockoutDays: c.stockoutDays ?? null,
      previousUnits: prev?.units ?? 0, changePct: prev?.units ? round((c.units - prev.units) / prev.units * 100) : null,
      topProducts: top.filter((t) => String(t._id.b) === String(c._id)).slice(0, 5).map((t) => ({ productId: String(t._id.p), name: productNames.get(String(t._id.p)) || 'Unknown', units: t.units })),
    };
  }).sort((a, b) => b.units - a.units);
  return {
    dataSource: source, isSynthetic: source === 'synthetic_demo',
    dataLabel: source === 'synthetic_demo' ? 'Synthetic demonstration data — not real sales' : 'Real Cartify orders',
    days: d, periodEnd: end, branches: rows,
  };
}

// ── Low stock / surplus ───────────────────────────────────────────────────────────────────────
const slimRow = (r) => ({
  productId: r.productId, productName: r.productName, category: r.category, branchId: r.branchId, branchName: r.branchName,
  available: r.available, inbound: r.inbound, predictedDemand: r.predictedDemand, safetyStock: r.safetyStock,
  daysOfCover: r.daysOfCover, shortageRisk: r.shortageRisk, suggestedReplenishment: r.suggestedReplenishment,
  surplusUnits: r.surplusUnits, excessUnits: r.excessUnits, trend: r.trend, trendPct: r.trendPct,
});

export async function identifyLowStock({ branchId, horizonDays = 30, limit = 50 } = {}) {
  const { view, rows } = await branchForecastRows(horizonDays, { includeOnline: branchId === 'online' });
  const settings = policySettings();
  if (!view.run) {
    // No forecast yet: fall back to a fixed threshold on available stock
    const filter = branchId && branchId !== 'all' ? { branchId: oid(branchId, 'branchId') } : {};
    const inv = await branchInventoryModel.find(filter).populate('productId', 'name category').populate('branchId', 'name').lean();
    const items = inv.filter((r) => r.productId && r.quantity - r.reserved <= (r.safetyStock ?? settings.lowStockUnits))
      .map((r) => ({ productId: String(r.productId._id), productName: r.productId.name, branchId: String(r.branchId?._id), branchName: r.branchId?.name, available: r.quantity - r.reserved, threshold: r.safetyStock ?? settings.lowStockUnits }))
      .sort((a, b) => a.available - b.available);
    return { method: `threshold (available ≤ ${settings.lowStockUnits} units, no forecast available yet)`, forecast: null, total: items.length, items: items.slice(0, limit) };
  }
  let items = rows.filter((r) => ['high', 'medium'].includes(r.shortageRisk));
  if (branchId && branchId !== 'all') items = items.filter((r) => (branchId === 'online' ? r.branchId === null : r.branchId === String(branchId)));
  items.sort((a, b) => RISK_RANK[b.shortageRisk] - RISK_RANK[a.shortageRisk] || (a.daysOfCover ?? 1e9) - (b.daysOfCover ?? 1e9));
  return {
    method: `forecast-based: high = runs out within the ${settings.leadTimeDays}-day lead time, medium = will not cover the ${horizonDays}-day forecast`,
    forecast: view.run, horizonDays: Number(horizonDays), total: items.length, items: items.slice(0, limit).map(slimRow),
  };
}

export async function identifyExcess({ branchId, horizonDays = 30, limit = 50 } = {}) {
  const { view, rows } = await branchForecastRows(horizonDays);
  if (!view.run) return { forecast: null, total: 0, items: [], note: 'Run a demand forecast first: surplus is measured against expected demand.' };
  const settings = policySettings();
  let items = rows.filter((r) => r.surplusUnits >= settings.minTransferQty);
  if (branchId && branchId !== 'all') items = items.filter((r) => r.branchId === String(branchId));
  items.sort((a, b) => b.excessUnits - a.excessUnits || b.surplusUnits - a.surplusUnits);
  const byBranch = {};
  for (const r of items) { byBranch[r.branchName] = byBranch[r.branchName] || { items: 0, surplusUnits: 0, excessUnits: 0 }; byBranch[r.branchName].items += 1; byBranch[r.branchName].surplusUnits += r.surplusUnits; byBranch[r.branchName].excessUnits += r.excessUnits; }
  return {
    definition: `surplus = stock beyond the ${horizonDays}-day forecast plus safety stock (transferable); excess = surplus beyond a further ${settings.excessCoverDays} days of demand (overstock)`,
    forecast: view.run, horizonDays: Number(horizonDays), byBranch, total: items.length, items: items.slice(0, limit).map(slimRow),
  };
}

// ── Transfer & replenishment suggestions (deterministic rules over the forecast) ─────────────
function transferReasoning(t, H) {
  const d = t.to, s = t.from;
  return `${d.branchName} is expected to sell about ${Math.round(d.predictedDemand)} units of ${t.productName} in the next ${H} days ` +
    `(forecast). It has ${d.available} available${d.inbound ? ` and ${d.inbound} on the way` : ''} with a safety stock of ${d.safetyStock}, ` +
    `so it is ${d.shortage} units short${d.daysOfCover != null ? ` (about ${d.daysOfCover} days of cover)` : ''}. ` +
    `${s.branchName} has ${s.available} available against its own need of ${Math.round(s.predictedDemand + s.safetyStock)} ` +
    `(forecast ${Math.round(s.predictedDemand)} + safety ${s.safetyStock}), leaving ${s.surplus} spare. ` +
    `Transferring ${t.quantity} covers ${Math.round((100 * t.quantity) / d.shortage)}% of the shortage` +
    (t.distanceKm != null ? `; the branches are ${t.distanceKm} km apart.` : '.');
}

export async function suggestTransfers({ horizonDays = 30, productId, branchId, limit = 50 } = {}) {
  const settings = policySettings();
  const { view, rows } = await branchForecastRows(horizonDays);
  if (!view.run) return { forecast: null, transfers: [], replenishments: [], note: 'Run a demand forecast first: transfers are based on expected demand.' };
  const branches = new Map((await branchModel.find().lean()).map((b) => [String(b._id), b]));
  const active = (id) => branches.get(id)?.status === 'active';
  const byProduct = new Map();
  for (const r of rows) {
    if (productId && r.productId !== String(productId)) continue;
    if (!byProduct.has(r.productId)) byProduct.set(r.productId, []);
    byProduct.get(r.productId).push(r);
  }
  const transfers = [], replenishments = [];
  for (const list of byProduct.values()) {
    const needs = list.filter((r) => r.suggestedReplenishment > 0 && active(r.branchId))
      .sort((a, b) => RISK_RANK[b.shortageRisk] - RISK_RANK[a.shortageRisk] || b.suggestedReplenishment - a.suggestedReplenishment);
    const sources = list.filter((r) => r.surplusUnits >= settings.minTransferQty && active(r.branchId)).map((r) => ({ ...r, left: r.surplusUnits }));
    for (const dest of needs) {
      let remaining = dest.suggestedReplenishment;
      const ranked = sources.filter((s) => s.left >= settings.minTransferQty && s.branchId !== dest.branchId)
        .map((s) => ({ s, km: haversineKm(branches.get(s.branchId)?.location, branches.get(dest.branchId)?.location) }))
        .sort((a, b) => b.s.left - a.s.left || (a.km ?? 0) - (b.km ?? 0));
      for (const { s, km } of ranked) {
        if (remaining < settings.minTransferQty) break;
        const qty = Math.min(remaining, s.left);
        if (qty < settings.minTransferQty) continue;
        s.left -= qty; remaining -= qty;
        const t = {
          type: 'stock_transfer', productId: dest.productId, productName: dest.productName, quantity: qty, distanceKm: km,
          priority: dest.shortageRisk === 'high' ? 'high' : dest.shortageRisk === 'medium' ? 'medium' : 'low',
          from: { branchId: s.branchId, branchName: s.branchName, available: s.available, predictedDemand: s.predictedDemand, safetyStock: s.safetyStock, surplus: s.surplusUnits },
          to: { branchId: dest.branchId, branchName: dest.branchName, available: dest.available, inbound: dest.inbound, predictedDemand: dest.predictedDemand, safetyStock: dest.safetyStock, shortage: dest.suggestedReplenishment, daysOfCover: dest.daysOfCover, shortageRisk: dest.shortageRisk, trend: dest.trend },
        };
        t.reasoning = transferReasoning(t, horizonDays);
        transfers.push(t);
      }
      if (remaining >= 1) {
        replenishments.push({
          type: 'replenishment', productId: dest.productId, productName: dest.productName, quantity: remaining,
          priority: dest.shortageRisk === 'high' ? 'high' : dest.shortageRisk === 'medium' ? 'medium' : 'low',
          to: { branchId: dest.branchId, branchName: dest.branchName, available: dest.available, inbound: dest.inbound, predictedDemand: dest.predictedDemand, safetyStock: dest.safetyStock, shortage: dest.suggestedReplenishment, daysOfCover: dest.daysOfCover, shortageRisk: dest.shortageRisk },
          reasoning: `${dest.branchName} needs ${dest.suggestedReplenishment} more units of ${dest.productName} to cover the ${horizonDays}-day forecast ` +
            `(${Math.round(dest.predictedDemand)}) plus safety stock (${dest.safetyStock}); it has ${dest.available} available${dest.inbound ? ` and ${dest.inbound} on the way` : ''}. ` +
            (remaining < dest.suggestedReplenishment ? `Transfers from other branches cover ${dest.suggestedReplenishment - remaining}; reorder the remaining ${remaining} from the supplier.` : 'No other branch has spare stock, so reorder from the supplier.'),
        });
      }
    }
  }
  const prio = { high: 0, medium: 1, low: 2 };
  const filterBranch = (x) => !branchId || branchId === 'all' || x.to.branchId === String(branchId) || x.from?.branchId === String(branchId);
  const sortFn = (a, b) => prio[a.priority] - prio[b.priority] || b.quantity - a.quantity;
  const t = transfers.filter(filterBranch).sort(sortFn), r = replenishments.filter(filterBranch).sort(sortFn);
  return {
    forecast: view.run, horizonDays: Number(horizonDays), settings,
    method: 'Each branch needs its forecast demand plus safety stock; spare stock above that at another active branch is moved first (largest surplus, then nearest), and the rest is reordered from the supplier.',
    totalTransfers: t.length, totalReplenishments: r.length,
    transfers: t.slice(0, limit), replenishments: r.slice(0, limit),
  };
}

// ── Recommendations (persisted proposals) ─────────────────────────────────────────────────────
export async function generateRecommendations({ horizonDays = 30, user, source = 'rules_engine' } = {}) {
  const s = await suggestTransfers({ horizonDays, limit: 500 });
  if (!s.forecast) throw new AppError('Run a demand forecast before generating recommendations.', 409);
  const run = await latestRun();
  const superseded = await aiRecommendationModel.updateMany({ status: 'pending' }, { $set: { status: 'superseded', reviewNote: 'Replaced by a newer set of recommendations' } });
  const base = { horizonDays: Number(horizonDays), forecastRunId: run._id, isSyntheticData: !!run.isSynthetic, source, createdBy: user?._id || null };
  const docs = [
    ...s.transfers.map((t) => ({
      ...base, type: 'stock_transfer', productId: t.productId, sourceBranchId: t.from.branchId, destinationBranchId: t.to.branchId,
      affectedBranches: [t.from.branchId, t.to.branchId], suggestedAction: { action: 'transfer', quantity: t.quantity },
      reasoning: t.reasoning, evidence: { from: t.from, to: t.to, distanceKm: t.distanceKm, settings: s.settings, forecastAsOf: s.forecast.asOf }, priority: t.priority,
    })),
    ...s.replenishments.map((r) => ({
      ...base, type: 'replenishment', productId: r.productId, destinationBranchId: r.to.branchId, affectedBranches: [r.to.branchId],
      suggestedAction: { action: 'reorder from supplier', quantity: r.quantity }, reasoning: r.reasoning,
      evidence: { to: r.to, settings: s.settings, forecastAsOf: s.forecast.asOf }, priority: r.priority,
    })),
  ];
  const created = docs.length ? await aiRecommendationModel.insertMany(docs) : [];
  console.log(`[inventory] ${user?.email || 'system'} generated ${created.length} recommendations (${source}), superseded ${superseded.modifiedCount}`);
  return { created: created.length, transfers: s.transfers.length, replenishments: s.replenishments.length, superseded: superseded.modifiedCount, forecast: s.forecast };
}

export async function listRecommendations({ status = 'pending', type, page = 1, limit = 20 } = {}) {
  const filter = {};
  if (status && status !== 'all') filter.status = status;
  if (type) filter.type = type;
  const l = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100), p = Math.max(parseInt(page, 10) || 1, 1);
  const prio = { high: 0, medium: 1, low: 2 };
  const [total, docs] = await Promise.all([
    aiRecommendationModel.countDocuments(filter),
    aiRecommendationModel.find(filter).sort({ createdAt: -1 }).limit(500)
      .populate('productId', 'name category variants.images').populate('sourceBranchId', 'name code').populate('destinationBranchId', 'name code')
      .populate('reviewedBy', 'email firstName').lean(),
  ]);
  const typeOrder = { stock_transfer: 0, replenishment: 1, excess_stock: 2 };
  docs.sort((a, b) => (status === 'pending' ? prio[a.priority] - prio[b.priority] || typeOrder[a.type] - typeOrder[b.type] || (b.suggestedAction?.quantity || 0) - (a.suggestedAction?.quantity || 0) : 0) || b.createdAt - a.createdAt);
  return {
    total, page: p, limit: l, totalPages: Math.ceil(total / l),
    recommendations: docs.slice((p - 1) * l, p * l).map((d) => ({
      id: String(d._id), type: d.type, status: d.status, priority: d.priority, source: d.source, horizonDays: d.horizonDays, isSyntheticData: d.isSyntheticData,
      product: d.productId ? { id: String(d.productId._id), name: d.productId.name, category: d.productId.category, image: productImage(d.productId) } : null,
      from: d.sourceBranchId ? { id: String(d.sourceBranchId._id), name: d.sourceBranchId.name } : null,
      to: d.destinationBranchId ? { id: String(d.destinationBranchId._id), name: d.destinationBranchId.name } : null,
      suggestedAction: d.suggestedAction, reasoning: d.reasoning, evidence: d.evidence,
      reviewedBy: d.reviewedBy ? d.reviewedBy.email : null, reviewedAt: d.reviewedAt, reviewNote: d.reviewNote,
      stockMovementId: d.stockMovementId ? String(d.stockMovementId) : null, createdAt: d.createdAt,
    })),
  };
}

export async function approveRecommendation(id, user, note) {
  const rec = await aiRecommendationModel.findOneAndUpdate(
    { _id: oid(id), status: 'pending' },
    { $set: { status: 'approved', reviewedBy: user._id, reviewedAt: new Date(), reviewNote: note || '' } },
    { new: true },
  );
  if (!rec) throw new AppError('Recommendation not found or already reviewed', 409);
  try {
    const movement = await createMovement({
      type: rec.type === 'stock_transfer' ? 'transfer' : 'replenishment', productId: rec.productId,
      sourceBranchId: rec.sourceBranchId, destinationBranchId: rec.destinationBranchId, quantity: rec.suggestedAction.quantity,
      reason: `Approved recommendation: ${rec.reasoning}`.slice(0, 500), recommendationId: rec._id,
    }, user, 'recommendation', { approve: true, note });
    rec.stockMovementId = movement._id;
    await rec.save();
    console.log(`[inventory] ${user.email} approved recommendation ${rec._id} → movement #${movement.movementNumber}`);
    return { recommendation: rec, movement };
  } catch (err) {
    await aiRecommendationModel.updateOne({ _id: rec._id }, { $set: { status: 'pending', reviewedBy: null, reviewedAt: null, reviewNote: '' } });
    throw err;
  }
}

export async function rejectRecommendation(id, user, note) {
  const rec = await aiRecommendationModel.findOneAndUpdate(
    { _id: oid(id), status: 'pending' },
    { $set: { status: 'rejected', reviewedBy: user._id, reviewedAt: new Date(), reviewNote: note || '' } },
    { new: true },
  );
  if (!rec) throw new AppError('Recommendation not found or already reviewed', 409);
  console.log(`[inventory] ${user.email} rejected recommendation ${rec._id}`);
  return rec;
}

// ── Stock movements ───────────────────────────────────────────────────────────────────────────
async function reserveAtSource(m) {
  const res = await branchInventoryModel.updateOne(
    { branchId: m.sourceBranchId, productId: m.productId, $expr: { $gte: [{ $subtract: ['$quantity', '$reserved'] }, m.quantity] } },
    { $inc: { reserved: m.quantity } },
  );
  if (!res.modifiedCount) {
    const row = await branchInventoryModel.findOne({ branchId: m.sourceBranchId, productId: m.productId }).lean();
    throw new AppError(`The source branch has only ${Math.max(0, (row?.quantity || 0) - (row?.reserved || 0))} units available, ${m.quantity} requested`, 409);
  }
}

export async function createMovement({ type = 'transfer', productId, sourceBranchId, destinationBranchId, quantity, reason, recommendationId = null }, user, via = 'dashboard', { approve = false, note } = {}) {
  if (!['transfer', 'replenishment'].includes(type)) throw new AppError('type must be transfer or replenishment', 400);
  const q = Number(quantity);
  if (!Number.isInteger(q) || q < 1 || q > 100000) throw new AppError('quantity must be a whole number between 1 and 100000', 400);
  const pid = oid(productId, 'productId');
  if (!(await productModel.exists({ _id: pid }))) throw new AppError('Product not found', 404);
  const dest = await getBranchOrThrow(destinationBranchId);
  if (dest.status !== 'active') throw new AppError(`${dest.name} is not active`, 400);
  let src = null;
  if (type === 'transfer') {
    src = await getBranchOrThrow(sourceBranchId);
    if (String(src._id) === String(dest._id)) throw new AppError('Source and destination must be different branches', 400);
    if (src.status !== 'active') throw new AppError(`${src.name} is not active`, 400);
  }
  const doc = {
    movementNumber: await nextSequence('stockMovement'), type, productId: pid, sourceBranchId: src?._id || null, destinationBranchId: dest._id,
    quantity: q, reason: reason || '', recommendationId, requestedBy: user?._id || null, requestedVia: via, status: 'requested',
    statusHistory: [{ status: 'requested', by: user?._id, note: reason || '' }],
  };
  if (approve) {
    if (type === 'transfer') await reserveAtSource(doc);
    Object.assign(doc, { status: 'approved', approvedBy: user._id, approvedAt: new Date() });
    doc.statusHistory.push({ status: 'approved', by: user._id, note: note || '' });
  }
  const m = await stockMovementModel.create(doc);
  console.log(`[inventory] movement #${m.movementNumber} ${type} ${q} × ${pid} ${src ? src.code + '→' : ''}${dest.code} (${m.status}, via ${via}, by ${user?.email})`);
  return m;
}

async function transition(id, from, to, user, note, extra = {}) {
  const m = await stockMovementModel.findOneAndUpdate(
    { _id: oid(id), status: from },
    { $set: { status: to, ...extra }, $push: { statusHistory: { status: to, by: user._id, note: note || '', changedAt: new Date() } } },
    { new: true },
  );
  if (!m) {
    const exists = await stockMovementModel.findById(id).select('status').lean();
    throw new AppError(exists ? `Movement is ${exists.status}; it must be ${from} to do this` : 'Movement not found', exists ? 409 : 404);
  }
  return m;
}

export async function approveMovement(id, user, note) {
  const pending = await stockMovementModel.findById(oid(id)).lean();
  if (!pending) throw new AppError('Movement not found', 404);
  if (pending.status !== 'requested') throw new AppError(`Movement is ${pending.status}; only requested movements can be approved`, 409);
  if (pending.type === 'transfer') await reserveAtSource(pending);
  try {
    return await transition(id, 'requested', 'approved', user, note, { approvedBy: user._id, approvedAt: new Date() });
  } catch (err) {
    if (pending.type === 'transfer') await branchInventoryModel.updateOne({ branchId: pending.sourceBranchId, productId: pending.productId }, { $inc: { reserved: -pending.quantity } });
    throw err;
  }
}

export async function completeMovement(id, user, note) {
  const m = await transition(id, 'approved', 'completed', user, note, { completedBy: user._id, completedAt: new Date() });
  if (m.type === 'transfer') {
    const res = await branchInventoryModel.updateOne(
      { branchId: m.sourceBranchId, productId: m.productId, quantity: { $gte: m.quantity }, reserved: { $gte: m.quantity } },
      { $inc: { quantity: -m.quantity, reserved: -m.quantity } },
    );
    if (!res.modifiedCount) {
      await stockMovementModel.updateOne({ _id: m._id }, { $set: { status: 'approved', completedBy: null, completedAt: null }, $pop: { statusHistory: 1 } });
      throw new AppError('The source branch no longer holds the reserved units; check its stock before completing', 409);
    }
  }
  await branchInventoryModel.updateOne({ branchId: m.destinationBranchId, productId: m.productId }, { $inc: { quantity: m.quantity } }, { upsert: true });
  console.log(`[inventory] ${user.email} completed movement #${m.movementNumber}`);
  return m;
}

export const rejectMovement = (id, user, note) => transition(id, 'requested', 'rejected', user, note, { rejectedBy: user._id, rejectionReason: note || '' });

export async function cancelMovement(id, user, note) {
  const m = await transition(id, 'approved', 'cancelled', user, note);
  if (m.type === 'transfer') await branchInventoryModel.updateOne({ branchId: m.sourceBranchId, productId: m.productId, reserved: { $gte: m.quantity } }, { $inc: { reserved: -m.quantity } });
  if (m.recommendationId) await aiRecommendationModel.updateOne({ _id: m.recommendationId }, { $set: { reviewNote: `Movement #${m.movementNumber} cancelled` } });
  return m;
}

export async function listMovements({ status, type, branchId, productId, page = 1, limit = 20 } = {}) {
  const filter = {};
  if (status && status !== 'all') filter.status = status === 'open' ? { $in: ['requested', 'approved'] } : status;
  if (type) filter.type = type;
  if (productId) filter.productId = oid(productId, 'productId');
  if (branchId && branchId !== 'all') { const b = oid(branchId, 'branchId'); filter.$or = [{ sourceBranchId: b }, { destinationBranchId: b }]; }
  const l = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100), p = Math.max(parseInt(page, 10) || 1, 1);
  const [total, docs] = await Promise.all([
    stockMovementModel.countDocuments(filter),
    stockMovementModel.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l)
      .populate('productId', 'name').populate('sourceBranchId', 'name').populate('destinationBranchId', 'name')
      .populate('requestedBy', 'email').populate('approvedBy', 'email').lean(),
  ]);
  return {
    total, page: p, limit: l, totalPages: Math.ceil(total / l),
    movements: docs.map((m) => ({
      id: String(m._id), number: m.movementNumber, type: m.type, status: m.status, quantity: m.quantity, delta: m.delta,
      product: m.productId ? { id: String(m.productId._id), name: m.productId.name } : null,
      from: m.sourceBranchId ? { id: String(m.sourceBranchId._id), name: m.sourceBranchId.name } : null,
      to: m.destinationBranchId ? { id: String(m.destinationBranchId._id), name: m.destinationBranchId.name } : null,
      reason: m.reason, requestedVia: m.requestedVia, requestedBy: m.requestedBy?.email || null, approvedBy: m.approvedBy?.email || null,
      isDemo: m.isDemo, createdAt: m.createdAt, approvedAt: m.approvedAt, completedAt: m.completedAt, recommendationId: m.recommendationId ? String(m.recommendationId) : null,
    })),
  };
}

// ── Unusual changes ───────────────────────────────────────────────────────────────────────────
export async function detectAnomalies({ days = 14 } = {}) {
  const since = new Date(Date.now() - days * DAY_MS);
  const anomalies = [];
  const adjustments = await stockMovementModel.find({ type: 'adjustment', createdAt: { $gte: since } })
    .populate('productId', 'name').populate('destinationBranchId', 'name').lean();
  for (const a of adjustments) {
    const row = await branchInventoryModel.findOne({ branchId: a.destinationBranchId?._id, productId: a.productId?._id }).select('quantity').lean();
    const before = (row?.quantity || 0) - (a.delta || 0);
    if (Math.abs(a.delta || 0) >= Math.max(10, 0.3 * Math.max(before, 1))) {
      anomalies.push({
        type: 'large_adjustment', severity: (a.delta || 0) < 0 ? 'high' : 'medium', date: a.completedAt || a.createdAt,
        productId: a.productId ? String(a.productId._id) : null, productName: a.productId?.name, branchName: a.destinationBranchId?.name,
        detail: `Manual stock change of ${a.delta > 0 ? '+' : ''}${a.delta} units (${before} → ${before + (a.delta || 0)}): "${a.reason}". Large unexplained drops can mean loss or a counting error.`,
      });
    }
  }
  // Sales spikes / drops: last 7 days vs the previous 8 weeks, per branch and product
  const run = await latestRun();
  const source = run?.dataSource || (await detectDataSource()).source;
  let daily = [];
  let end;
  if (source === 'synthetic_demo') {
    const last = await syntheticSaleModel.findOne().sort({ date: -1 }).select('date').lean();
    end = utcDay(last?.date || new Date());
    daily = await syntheticSaleModel.aggregate([
      { $match: { date: { $gt: new Date(end.getTime() - 63 * DAY_MS), $lte: end }, branchId: { $ne: null } } },
      { $group: { _id: { p: '$productId', b: '$branchId' }, recent: { $sum: { $cond: [{ $gt: ['$date', new Date(end.getTime() - 7 * DAY_MS)] }, '$unitsSold', 0] } }, past: { $sum: { $cond: [{ $gt: ['$date', new Date(end.getTime() - 7 * DAY_MS)] }, 0, '$unitsSold'] } }, recentOut: { $sum: { $cond: [{ $and: [{ $gt: ['$date', new Date(end.getTime() - 7 * DAY_MS)] }, { $eq: ['$inStock', false] }] }, 1, 0] } } } },
    ]);
  } else if (source === 'orders') {
    end = utcDay(new Date(Date.now() - DAY_MS));
    daily = await orderModel.aggregate([
      { $match: { createdAt: { $gt: new Date(end.getTime() - 63 * DAY_MS), $lt: new Date(end.getTime() + DAY_MS) }, status: { $ne: 'cancelled' } } },
      { $unwind: '$products' },
      { $group: { _id: { p: '$products.productId', b: { $ifNull: ['$branchId', null] } }, recent: { $sum: { $cond: [{ $gt: ['$createdAt', new Date(end.getTime() - 6 * DAY_MS)] }, '$products.quantity', 0] } }, past: { $sum: { $cond: [{ $gt: ['$createdAt', new Date(end.getTime() - 6 * DAY_MS)] }, 0, '$products.quantity'] } } } },
    ]);
  }
  if (daily.length) {
    const names = new Map((await productModel.find({ _id: { $in: daily.map((d) => d._id.p) } }).select('name').lean()).map((p) => [String(p._id), p.name]));
    const bnames = new Map((await branchModel.find().select('name').lean()).map((b) => [String(b._id), b.name]));
    for (const d of daily) {
      const expected = (d.past / 56) * 7;
      if (expected < 1 && d.recent < 10) continue;
      const ratio = d.recent / Math.max(expected, 0.5);
      const base = { productId: String(d._id.p), productName: names.get(String(d._id.p)), branchName: d._id.b ? bnames.get(String(d._id.b)) : 'Online store', date: end };
      if (ratio >= 2.5 && d.recent >= 10) anomalies.push({ ...base, type: 'sales_spike', severity: ratio >= 4 ? 'high' : 'medium', detail: `${d.recent} units sold in the last 7 days vs about ${round(expected)} normally (${round(ratio)}×). Check whether it is a real demand change before reordering.` });
      else if (ratio <= 0.25 && expected >= 7 && !(d.recentOut > 2)) anomalies.push({ ...base, type: 'sales_drop', severity: 'medium', detail: `Only ${d.recent} units sold in the last 7 days vs about ${round(expected)} normally, while in stock.` });
    }
  }
  const sev = { high: 0, medium: 1, low: 2 };
  anomalies.sort((a, b) => sev[a.severity] - sev[b.severity]);
  return { dataSource: source, isSynthetic: source === 'synthetic_demo', windowDays: days, total: anomalies.length, anomalies };
}

// ── Report ────────────────────────────────────────────────────────────────────────────────────
export async function inventoryReport({ horizonDays = 30 } = {}) {
  const [overview, low, excess, suggestions, anomalies, sales, { rows }] = await Promise.all([
    getOverview({ horizonDays }), identifyLowStock({ horizonDays, limit: 10 }), identifyExcess({ horizonDays, limit: 10 }),
    suggestTransfers({ horizonDays, limit: 10 }), detectAnomalies(), getBranchSales({ days: 30 }), branchForecastRows(horizonDays),
  ]);
  const increasing = rows.filter((r) => r.trend === 'increasing').sort((a, b) => b.trendPct - a.trendPct).slice(0, 10).map(slimRow);
  return {
    generatedAt: new Date(), horizonDays: Number(horizonDays), forecast: overview.forecast,
    branches: overview.branches.map((b) => ({ name: b.name, status: b.status, available: b.available, lowStock: b.lowStock, forecast: b.forecast })),
    lowestInventoryBranch: overview.lowestInventory,
    lowStock: low.items, excess: excess.items, transfers: suggestions.transfers, replenishments: suggestions.replenishments,
    increasingDemand: increasing, anomalies: anomalies.anomalies.slice(0, 10), branchSales: sales,
    pendingRecommendations: overview.pendingRecommendations, openMovements: overview.openMovements,
  };
}

