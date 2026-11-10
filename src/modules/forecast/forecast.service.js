// Demand forecasting: runs the model through the AI service, stores the results, and serves them
// with up-to-date stock figures (stock is re-read on every request; predictions come from the run).
import mongoose from 'mongoose';
import forecastRunModel from '../../../db/models/forecastRun.model.js';
import productModel from '../../../db/models/product.model.js';
import branchModel from '../../../db/models/branch.model.js';
import branchInventoryModel from '../../../db/models/branchInventory.model.js';
import stockMovementModel from '../../../db/models/stockMovement.model.js';
import { AppError } from '../../utils/error.js';
import { detectDataSource, loadSeries, isoDay, weeklyHistory } from './forecastData.js';
import { requestForecast } from './aiServiceClient.js';
import { evaluateStock, policySettings, worstRisk } from '../inventory/stockPolicy.js';

export const HORIZONS = [7, 30, 90];
const RISK_RANK = { high: 3, medium: 2, low: 1, none: 0 };
const TREND_THRESHOLD = 0.15;

// Current stock for every product at every location, plus approved deliveries not yet received.
export async function loadStockContext() {
  const [products, inventory, branches, inbound] = await Promise.all([
    productModel.find().select('name category variants.stock variants.reserved hide').lean(),
    branchInventoryModel.find().select('branchId productId quantity reserved safetyStock updatedAt').lean(),
    branchModel.find().select('name code status location').lean(),
    stockMovementModel.aggregate([
      { $match: { status: 'approved', destinationBranchId: { $ne: null } } },
      { $group: { _id: { p: '$productId', b: '$destinationBranchId' }, qty: { $sum: '$quantity' } } },
    ]),
  ]);
  const ctx = { products: new Map(), stock: new Map(), branches: new Map(), inbound: new Map() };
  for (const p of products) {
    ctx.products.set(String(p._id), p);
    ctx.stock.set(`${p._id}:online`, {
      onHand: (p.variants || []).reduce((a, v) => a + (v.stock || 0), 0),
      reserved: (p.variants || []).reduce((a, v) => a + (v.reserved || 0), 0),
    });
  }
  for (const r of inventory) ctx.stock.set(`${r.productId}:${r.branchId}`, { onHand: r.quantity, reserved: r.reserved, safetyOverride: r.safetyStock ?? undefined, updatedAt: r.updatedAt });
  for (const b of branches) ctx.branches.set(String(b._id), b);
  for (const r of inbound) ctx.inbound.set(`${r._id.p}:${r._id.b}`, r.qty);
  return ctx;
}

function hydrate(row, horizonDays, ctx, settings) {
  const key = `${row.productId}:${row.branchId || 'online'}`;
  const s = ctx.stock.get(key) || { onHand: 0, reserved: 0 };
  const product = ctx.products.get(String(row.productId));
  return {
    ...row,
    productId: String(row.productId),
    branchId: row.branchId ? String(row.branchId) : null,
    productName: product?.name || row.productName,
    category: product?.category || row.category,
    branchName: row.branchId ? (ctx.branches.get(String(row.branchId))?.name || row.branchName || 'Unknown branch') : 'Online store',
    ...evaluateStock({ predicted: row.predictedDemand, low: row.low, high: row.high, horizonDays }, { ...s, inbound: ctx.inbound.get(key) || 0 }, settings),
  };
}

export async function runForecast({ horizons = HORIZONS, userId = null } = {}) {
  const detection = await detectDataSource();
  if (!detection.source) throw new AppError(detection.reason, 422);
  const busy = await forecastRunModel.exists({ status: 'running', createdAt: { $gte: new Date(Date.now() - 10 * 60_000) } });
  if (busy) throw new AppError('A forecast is already running. Try again in a minute.', 409);

  const { asOf, series, snapshotDays } = await loadSeries(detection.source);
  if (!series.length || !asOf) throw new AppError('No sales history found to forecast from.', 422);
  const settings = policySettings();
  const run = await forecastRunModel.create({
    status: 'running', asOf, dataSource: detection.source, isSynthetic: detection.source === 'synthetic_demo',
    createdBy: userId, settings: { ...settings, dataSourceReason: detection.reason, snapshotDays: snapshotDays ?? null },
  });
  const t0 = Date.now();
  try {
    const out = await requestForecast({ asOf: isoDay(asOf), horizons, series });
    const ctx = await loadStockContext();
    run.horizons = out.horizons.map((h) => ({
      horizonDays: h.horizonDays, status: h.status, selectedModel: h.selectedModel, selectedModelLabel: h.selectedModelLabel,
      selectionRule: h.selectionRule, candidates: h.candidates, test: h.test, interval: h.interval,
      featureImportance: h.featureImportance, warnings: h.warnings,
      results: h.forecasts.map((f) => {
        const base = {
          productId: f.productId, branchId: f.branchId, predictedDemand: f.predicted, low: f.low, high: f.high,
          dailyRate: f.dailyRate, recentDailyRate: f.recentDailyRate, trend: f.trend, trendPct: f.trendPct,
          stockoutDaysLast28: f.stockoutDaysLast28, lowConfidence: f.lowConfidence,
        };
        return hydrate(base, h.horizonDays, ctx, settings); // stock as it was when the forecast ran
      }),
    }));
    Object.assign(run, {
      status: 'completed', historyDays: out.historyDays, seriesCount: out.seriesCount, serviceVersion: out.serviceVersion,
      features: out.features, target: out.target, durationMs: Date.now() - t0,
    });
    await run.save();
    console.log(`[forecast] run ${run._id} completed: ${out.seriesCount} series, source ${run.dataSource}, ${run.durationMs} ms`);
    return run;
  } catch (err) {
    run.status = 'failed';
    run.error = err.message;
    run.durationMs = Date.now() - t0;
    await run.save().catch(() => {});
    throw err;
  }
}

export const latestRun = () => forecastRunModel.findOne({ status: 'completed' }).sort({ createdAt: -1 }).lean();

export const runMeta = (run) => run && ({
  id: String(run._id), asOf: run.asOf, createdAt: run.createdAt, dataSource: run.dataSource, isSynthetic: run.isSynthetic,
  historyDays: run.historyDays, seriesCount: run.seriesCount, settings: run.settings, durationMs: run.durationMs,
  dataLabel: run.isSynthetic ? 'Synthetic demonstration data — not real sales' : 'Real Cartify orders',
});

const horizonMeta = (h) => ({
  horizonDays: h.horizonDays, status: h.status, selectedModel: h.selectedModel, selectedModelLabel: h.selectedModelLabel,
  selectionRule: h.selectionRule, candidates: h.candidates, test: h.test, interval: h.interval,
  featureImportance: h.featureImportance, warnings: h.warnings,
});

function aggregateByProduct(rows, horizonDays) {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.productId)) groups.set(r.productId, []);
    groups.get(r.productId).push(r);
  }
  return [...groups.values()].map((list) => {
    const sum = (k) => +list.reduce((a, r) => a + (r[k] || 0), 0).toFixed(2);
    const rate = sum('dailyRate');
    const recentKnown = list.filter((r) => r.recentDailyRate != null);
    const recent = recentKnown.length ? recentKnown.reduce((a, r) => a + r.recentDailyRate, 0) : null;
    const pct = recent != null ? (rate - recent) / Math.max(recent, 0.05) : null;
    const available = sum('available');
    return {
      productId: list[0].productId, productName: list[0].productName, category: list[0].category,
      branchId: null, branchName: list.length > 1 ? `${list.length} locations` : list[0].branchName, locations: list.length,
      predictedDemand: sum('predictedDemand'), low: sum('low'), high: sum('high'), dailyRate: rate, recentDailyRate: recent,
      trend: pct == null ? 'unknown' : pct >= TREND_THRESHOLD ? 'increasing' : pct <= -TREND_THRESHOLD ? 'decreasing' : 'stable',
      trendPct: pct == null ? null : +pct.toFixed(4),
      stockoutDaysLast28: Math.max(...list.map((r) => r.stockoutDaysLast28 || 0)),
      lowConfidence: list.some((r) => r.lowConfidence),
      currentStock: sum('currentStock'), reserved: sum('reserved'), available, inbound: sum('inbound'),
      safetyStock: sum('safetyStock'), suggestedReplenishment: sum('suggestedReplenishment'), surplusUnits: sum('surplusUnits'), excessUnits: sum('excessUnits'),
      daysOfCover: rate > 0 ? +(available / rate).toFixed(1) : null,
      shortageRisk: worstRisk(list.map((r) => r.shortageRisk)),
      locationsAtRisk: list.filter((r) => ['high', 'medium'].includes(r.shortageRisk)).length,
      horizonDays,
    };
  });
}

const SORTS = {
  risk: (a, b) => RISK_RANK[b.shortageRisk] - RISK_RANK[a.shortageRisk] || (a.daysOfCover ?? 1e9) - (b.daysOfCover ?? 1e9),
  demand: (a, b) => b.predictedDemand - a.predictedDemand,
  growth: (a, b) => (b.trendPct ?? -1e9) - (a.trendPct ?? -1e9),
  decline: (a, b) => (a.trendPct ?? 1e9) - (b.trendPct ?? 1e9),
  replenishment: (a, b) => b.suggestedReplenishment - a.suggestedReplenishment,
  excess: (a, b) => b.excessUnits - a.excessUnits,
  name: (a, b) => String(a.productName).localeCompare(String(b.productName)),
};

/**
 * Latest forecast for one horizon with current stock. Filters: branchId ('all' | 'online' | id),
 * productId, trend, risk, search; groupBy 'location' (default) or 'product'.
 */
export async function getForecastView({ horizonDays = 30, branchId = 'all', productId, trend, risk, search, groupBy = 'location', sort = 'risk', page = 1, limit = 50 } = {}) {
  const run = await latestRun();
  if (!run) return { run: null, horizon: null, summary: null, rows: [], total: 0 };
  const h = run.horizons.find((x) => x.horizonDays === Number(horizonDays));
  if (!h) throw new AppError(`The latest forecast has no ${horizonDays}-day horizon. Run a new forecast.`, 404);
  const ctx = await loadStockContext();
  const settings = policySettings();
  let rows = h.results.map((r) => hydrate(r, h.horizonDays, ctx, settings));
  if (branchId && branchId !== 'all') rows = rows.filter((r) => (branchId === 'online' ? r.branchId === null : r.branchId === String(branchId)));
  if (productId) rows = rows.filter((r) => r.productId === String(productId));
  if (groupBy === 'product') rows = aggregateByProduct(rows, h.horizonDays);
  if (search) { const q = String(search).toLowerCase(); rows = rows.filter((r) => `${r.productName} ${r.category} ${r.branchName}`.toLowerCase().includes(q)); }
  if (trend) rows = rows.filter((r) => r.trend === trend);
  if (risk === 'at_risk') rows = rows.filter((r) => ['high', 'medium'].includes(r.shortageRisk));
  else if (risk) rows = rows.filter((r) => r.shortageRisk === risk);

  const summary = {
    rows: rows.length,
    totalPredicted: +rows.reduce((a, r) => a + r.predictedDemand, 0).toFixed(1),
    totalAvailable: rows.reduce((a, r) => a + r.available, 0),
    highRisk: rows.filter((r) => r.shortageRisk === 'high').length,
    mediumRisk: rows.filter((r) => r.shortageRisk === 'medium').length,
    increasing: rows.filter((r) => r.trend === 'increasing').length,
    decreasing: rows.filter((r) => r.trend === 'decreasing').length,
    replenishmentUnits: rows.reduce((a, r) => a + r.suggestedReplenishment, 0),
    excessUnits: rows.reduce((a, r) => a + r.excessUnits, 0),
    lowConfidence: rows.filter((r) => r.lowConfidence).length,
  };
  rows.sort(SORTS[sort] || SORTS.risk);
  const l = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const p = Math.max(parseInt(page, 10) || 1, 1);
  return { run: runMeta(run), horizon: horizonMeta(h), settings, summary, total: rows.length, page: p, limit: l, totalPages: Math.ceil(rows.length / l), rows: rows.slice((p - 1) * l, p * l) };
}

export async function getProductForecast(productId, { horizonDays = 30, branchId = 'all', weeks = 26 } = {}) {
  if (!mongoose.isValidObjectId(productId)) throw new AppError('Invalid product id', 400);
  const product = await productModel.findById(productId).select('name category').lean();
  if (!product) throw new AppError('Product not found', 404);
  const run = await latestRun();
  if (!run) throw new AppError('No forecast has been run yet.', 404);
  const view = await getForecastView({ horizonDays, productId, limit: 500 });
  const rows = branchId === 'all' ? view.rows : view.rows.filter((r) => (branchId === 'online' ? r.branchId === null : r.branchId === String(branchId)));
  const history = await weeklyHistory(run.dataSource, productId, { branchId, weeks, asOf: run.asOf });
  const total = aggregateByProduct(rows, Number(horizonDays))[0] || null;
  return { run: view.run, horizon: view.horizon, product: { id: String(product._id), name: product.name, category: product.category }, total, locations: rows, history };
}

export const listRuns = (limit = 20) => forecastRunModel.find().sort({ createdAt: -1 }).limit(limit)
  .select('status asOf dataSource isSynthetic historyDays seriesCount durationMs error createdAt horizons.horizonDays horizons.selectedModel horizons.status horizons.candidates')
  .lean();
