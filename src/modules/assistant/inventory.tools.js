// Tools of the Cartify Inventory Agent (admins only). They call the admin inventory / forecast REST
// endpoints with the admin's own token, so the backend's adminOnly checks apply to every call.
// The only tool that leads to a data change prepares a transfer *request* and waits for the admin to
// press Confirm; the request then still needs approval and completion on the dashboard.
import { randomUUID } from 'crypto';
import { callApi, ToolError } from './internalApi.js';

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const horizonDays = { type: 'integer', enum: [7, 30, 90], default: 30, description: 'Forecast horizon in days' };
const branchRef = { type: 'string', maxLength: 60, description: 'Branch id, or branch name (e.g. "University Branch"), or "online" for the online store where supported' };
const productRef = { type: 'string', maxLength: 120, description: 'Product id, or exact/partial product name' };
const limit = (d = 10, max = 30) => ({ type: 'integer', minimum: 1, maximum: max, default: d });
const ACTION_TTL_MS = 30 * 60_000;
const isId = (v) => /^[a-f\d]{24}$/i.test(v || '');

async function branches(ctx) {
  ctx.cache.branches ??= (await callApi(ctx.api, 'GET', '/branches')).branches;
  return ctx.cache.branches;
}

async function resolveBranch(ctx, ref, { allowOnline = false } = {}) {
  if (!ref || ref === 'all') return undefined;
  if (allowOnline && /^online( store)?$/i.test(ref)) return 'online';
  const list = await branches(ctx);
  if (isId(ref)) { if (list.some((b) => String(b._id) === ref)) return ref; throw new ToolError(`No branch with id ${ref}`, 404); }
  const q = ref.toLowerCase().replace(/\s*branch$/, '');
  const hits = list.filter((b) => b.name.toLowerCase().includes(q) || b.code.toLowerCase() === ref.toLowerCase());
  if (hits.length === 1) return String(hits[0]._id);
  throw new ToolError(hits.length ? `"${ref}" matches several branches: ${hits.map((b) => b.name).join(', ')}` : `No branch called "${ref}". Branches: ${list.map((b) => b.name).join(', ')}`, 404);
}

async function resolveProduct(ctx, ref) {
  if (isId(ref)) return ref;
  const res = await callApi(ctx.api, 'GET', '/products', { query: { search: ref, limit: 8 } });
  const exact = res.products.find((p) => p.name.toLowerCase() === ref.toLowerCase());
  if (exact) return exact._id;
  if (res.products.length === 1) return res.products[0]._id;
  throw new ToolError(res.products.length ? `"${ref}" matches several products: ${res.products.map((p) => `${p.name} (${p._id})`).join('; ')}` : `No product matches "${ref}"`, 404);
}

const runInfo = (f) => (f ? { asOf: f.asOf, dataSource: f.dataSource, dataLabel: f.dataLabel } : null);

export const inventoryTools = [
  {
    name: 'get_all_branches',
    description: 'All branches with id, code, name, address, status and stock totals.',
    input_schema: obj({}),
    handler: async (_i, ctx) => ({ data: { branches: (await branches(ctx)).map((b) => ({ id: b._id, code: b.code, name: b.name, city: b.city, address: b.address, status: b.status, isDemo: b.isDemo, skus: b.stock.skus, units: b.stock.units, reserved: b.stock.reserved })) } }),
  },
  {
    name: 'get_inventory_overview',
    description: 'Per-branch summary: available units, out-of-stock and low-stock counts, forecast demand, high/medium shortage risks, surplus items, increasing-demand items; plus the branch with the lowest inventory and pending recommendations.',
    input_schema: obj({ horizonDays }),
    handler: async ({ horizonDays: h }, ctx) => {
      const d = await callApi(ctx.api, 'GET', '/inventory/overview', { query: { horizonDays: h } });
      return { data: { forecast: runInfo(d.forecast), horizonDays: d.horizonDays, lowestInventoryBranch: d.lowestInventory, branches: d.branches.map(({ location, address, ...b }) => b), online: d.online, pendingRecommendations: d.pendingRecommendations, openMovements: d.openMovements, stockRules: d.settings } };
    },
  },
  {
    name: 'get_branch_inventory',
    description: 'Stock of one branch, product by product, with forecast demand, days of cover and shortage risk. Filter with status: low (at risk), excess (spare stock), out (zero available).',
    input_schema: obj({ branch: branchRef, status: { type: 'string', enum: ['all', 'low', 'excess', 'out'], default: 'all' }, search: { type: 'string', maxLength: 60 }, horizonDays, limit: limit(15, 50) }, ['branch']),
    handler: async ({ branch, status, search, horizonDays: h, limit: l }, ctx) => {
      const id = await resolveBranch(ctx, branch);
      if (!id) throw new ToolError('Choose one branch');
      const d = await callApi(ctx.api, 'GET', `/inventory/branches/${id}`, { query: { status, search, horizonDays: h, limit: l } });
      return { data: { branch: d.branch, forecast: runInfo(d.forecast), total: d.total, items: d.items.map(({ image, brand, ...i }) => i) } };
    },
  },
  {
    name: 'get_product_stock_across_branches',
    description: 'Stock of one product at every branch and in the online store, with forecast need, shortage and spare units per branch, and open transfers.',
    input_schema: obj({ product: productRef, horizonDays }, ['product']),
    handler: async ({ product, horizonDays: h }, ctx) => {
      const id = await resolveProduct(ctx, product);
      const d = await callApi(ctx.api, 'GET', `/inventory/products/${id}`, { query: { horizonDays: h } });
      return { data: { ...d, forecast: runInfo(d.forecast) } };
    },
  },
  {
    name: 'get_branch_sales',
    description: 'Units sold and revenue per branch over the last N days, change vs the previous N days, and top products per branch. Use for "compare sales between branches".',
    input_schema: obj({ branch: branchRef, days: { type: 'integer', minimum: 7, maximum: 365, default: 30 } }),
    handler: async ({ branch, days }, ctx) => {
      const id = await resolveBranch(ctx, branch, { allowOnline: true });
      return { data: await callApi(ctx.api, 'GET', '/inventory/sales', { query: { branchId: id, days } }) };
    },
  },
  {
    name: 'get_demand_forecast',
    description: 'Predictions of the demand forecasting model (latest run), per product and location or per product overall, with current stock, safety stock, suggested replenishment, trend and shortage risk, plus the model and its test accuracy.',
    input_schema: obj({
      horizonDays, branch: branchRef, product: productRef,
      groupBy: { type: 'string', enum: ['location', 'product'], default: 'location' },
      trend: { type: 'string', enum: ['increasing', 'decreasing', 'stable'] },
      risk: { type: 'string', enum: ['high', 'medium', 'low', 'none', 'at_risk'] },
      sort: { type: 'string', enum: ['risk', 'demand', 'growth', 'decline', 'replenishment', 'excess'], default: 'risk' },
      limit: limit(10, 30),
    }),
    handler: async ({ horizonDays: h, branch, product, groupBy, trend, risk, sort, limit: l }, ctx) => {
      const [branchId, productId] = await Promise.all([resolveBranch(ctx, branch, { allowOnline: true }), product ? resolveProduct(ctx, product) : undefined]);
      const d = await callApi(ctx.api, 'GET', '/forecasts/latest', { query: { horizonDays: h, branchId, productId, groupBy, trend, risk, sort, limit: l } });
      if (!d.run) return { data: { note: 'No forecast has been run yet. Ask the admin to run one on the Demand Forecasting page.' } };
      const best = (d.horizon.candidates || []).find((c) => c.name === d.horizon.selectedModel);
      return {
        data: {
          forecast: runInfo(d.run), horizonDays: d.horizon.horizonDays,
          model: { name: d.horizon.selectedModelLabel, testMAE: best?.mae, testWAPE: best?.wape, testPeriod: d.horizon.test },
          summary: d.summary, total: d.total,
          rows: d.rows.map((r) => ({ productId: r.productId, productName: r.productName, branchId: r.branchId, branchName: r.branchName, predictedDemand: r.predictedDemand, range: [r.low, r.high], available: r.available, inbound: r.inbound, safetyStock: r.safetyStock, suggestedReplenishment: r.suggestedReplenishment, surplusUnits: r.surplusUnits, daysOfCover: r.daysOfCover, shortageRisk: r.shortageRisk, trend: r.trend, trendPct: r.trendPct, lowConfidence: r.lowConfidence })),
        },
      };
    },
  },
  {
    name: 'identify_low_stock',
    description: 'Products likely to run out: high risk = runs out before a delivery could arrive (lead time), medium = will not cover the forecast horizon. Optionally for one branch.',
    input_schema: obj({ branch: branchRef, horizonDays, limit: limit(10, 30) }),
    handler: async ({ branch, horizonDays: h, limit: l }, ctx) => {
      const branchId = await resolveBranch(ctx, branch, { allowOnline: true });
      const d = await callApi(ctx.api, 'GET', '/inventory/low-stock', { query: { branchId, horizonDays: h, limit: l } });
      return { data: { ...d, forecast: runInfo(d.forecast) } };
    },
  },
  {
    name: 'identify_excess_stock',
    description: 'Branches and products with spare stock beyond the forecast need plus safety stock (transferable), and long-term overstock.',
    input_schema: obj({ branch: branchRef, horizonDays, limit: limit(10, 30) }),
    handler: async ({ branch, horizonDays: h, limit: l }, ctx) => {
      const branchId = await resolveBranch(ctx, branch);
      const d = await callApi(ctx.api, 'GET', '/inventory/excess', { query: { branchId, horizonDays: h, limit: l } });
      return { data: { ...d, forecast: runInfo(d.forecast) } };
    },
  },
  {
    name: 'suggest_stock_transfer',
    description: "Transfer and supplier-reorder suggestions computed by Cartify's stock rules from the forecast: which branch should send how many units to which branch, and what to reorder. Read-only.",
    input_schema: obj({ product: productRef, branch: branchRef, horizonDays, limit: limit(8, 20) }),
    handler: async ({ product, branch, horizonDays: h, limit: l }, ctx) => {
      const [productId, branchId] = await Promise.all([product ? resolveProduct(ctx, product) : undefined, resolveBranch(ctx, branch)]);
      const d = await callApi(ctx.api, 'GET', '/inventory/transfer-suggestions', { query: { productId, branchId, horizonDays: h, limit: l } });
      const data = { forecast: runInfo(d.forecast), horizonDays: d.horizonDays, method: d.method, totalTransfers: d.totalTransfers, totalReplenishments: d.totalReplenishments, transfers: d.transfers, replenishments: d.replenishments, note: d.note };
      return { data, block: d.transfers?.length ? { type: 'transfer_suggestions', horizonDays: d.horizonDays, transfers: d.transfers.slice(0, 6) } : undefined };
    },
  },
  {
    name: 'create_stock_transfer_request',
    description: 'Prepare a stock transfer request between two branches. Nothing is created until the admin presses Confirm; the request then still needs approval and completion on the Branch & Inventory page. Use the quantity from suggest_stock_transfer unless the admin asked for another.',
    input_schema: obj({ product: productRef, fromBranch: branchRef, toBranch: branchRef, quantity: { type: 'integer', minimum: 1, maximum: 10000 }, reason: { type: 'string', maxLength: 300 } }, ['product', 'fromBranch', 'toBranch', 'quantity']),
    handler: async ({ product, fromBranch, toBranch, quantity, reason }, ctx) => {
      const [productId, sourceBranchId, destinationBranchId] = await Promise.all([resolveProduct(ctx, product), resolveBranch(ctx, fromBranch), resolveBranch(ctx, toBranch)]);
      if (!sourceBranchId || !destinationBranchId) throw new ToolError('Both branches are required');
      if (sourceBranchId === destinationBranchId) throw new ToolError('Source and destination must be different branches');
      const stock = await callApi(ctx.api, 'GET', `/inventory/products/${productId}`);
      const src = stock.branches.find((b) => b.branchId === sourceBranchId), dst = stock.branches.find((b) => b.branchId === destinationBranchId);
      if (src.available < quantity) throw new ToolError(`${src.branchName} has only ${src.available} units available`);
      const actionId = randomUUID();
      const summary = `Request transfer of ${quantity} × ${stock.product.name} from ${src.branchName} to ${dst.branchName}`;
      ctx.conversation.pendingActions.push({ actionId, type: 'create_stock_transfer_request', payload: { productId, sourceBranchId, destinationBranchId, quantity, reason: reason || 'Suggested by the inventory agent' }, summary, expiresAt: new Date(Date.now() + ACTION_TTL_MS) });
      return {
        data: { status: 'awaiting_admin_confirmation', actionId, summary, note: 'Not created yet. Ask the admin to press Confirm on the card.' },
        block: { type: 'confirm_action', actionId, kind: 'create_stock_transfer_request', title: 'Create transfer request?', summary, product: { id: productId, name: stock.product.name }, from: { name: src.branchName, available: src.available }, to: { name: dst.branchName, available: dst.available }, quantity, reason: reason || '' },
      };
    },
  },
  {
    name: 'get_stock_movement_history',
    description: 'Stock movements (transfers, supplier deliveries, manual adjustments), newest first, optionally for one branch, product or status.',
    input_schema: obj({ branch: branchRef, product: productRef, status: { type: 'string', enum: ['all', 'open', 'requested', 'approved', 'completed', 'rejected', 'cancelled'], default: 'all' }, type: { type: 'string', enum: ['transfer', 'replenishment', 'adjustment'] }, limit: limit(10, 30) }),
    handler: async ({ branch, product, status, type, limit: l }, ctx) => {
      const [branchId, productId] = await Promise.all([resolveBranch(ctx, branch), product ? resolveProduct(ctx, product) : undefined]);
      const d = await callApi(ctx.api, 'GET', '/inventory/movements', { query: { branchId, productId, status, type, limit: l } });
      return { data: { total: d.total, movements: d.movements.map(({ recommendationId, ...m }) => m) } };
    },
  },
  {
    name: 'get_recommendations',
    description: 'Saved stock recommendations (transfer / reorder proposals) and their review status.',
    input_schema: obj({ status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'all'], default: 'pending' }, limit: limit(10, 30) }),
    handler: async ({ status, limit: l }, ctx) => {
      const d = await callApi(ctx.api, 'GET', '/inventory/recommendations', { query: { status, limit: l } });
      return { data: { total: d.total, recommendations: d.recommendations.map(({ evidence, ...r }) => ({ ...r, product: r.product?.name })) } };
    },
  },
  {
    name: 'detect_inventory_anomalies',
    description: 'Unusual inventory changes: large manual stock corrections, and sales spikes or drops in the last 7 days vs the previous 8 weeks.',
    input_schema: obj({ days: { type: 'integer', minimum: 1, maximum: 90, default: 14 } }),
    handler: async ({ days }, ctx) => ({ data: await callApi(ctx.api, 'GET', '/inventory/anomalies', { query: { days } }) }),
  },
  {
    name: 'generate_inventory_report',
    description: 'A full inventory report: branches, lowest-inventory branch, low stock, surplus, suggested transfers and reorders, increasing demand, anomalies, branch sales and pending work. Use for broad questions; prefer the specific tools for narrow ones.',
    input_schema: obj({ horizonDays }),
    handler: async ({ horizonDays: h }, ctx) => {
      const { report } = await callApi(ctx.api, 'GET', '/inventory/report', { query: { horizonDays: h } });
      const slim = (list, n = 6) => (list || []).slice(0, n);
      return { data: { ...report, forecast: runInfo(report.forecast), lowStock: slim(report.lowStock), excess: slim(report.excess), transfers: slim(report.transfers, 5).map(({ reasoning, ...t }) => t), replenishments: slim(report.replenishments, 5).map(({ reasoning, ...r }) => r), increasingDemand: slim(report.increasingDemand), anomalies: slim(report.anomalies) } };
    },
  },
];
