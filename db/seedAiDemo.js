/**
 * Cartify — AI demo data seeder (SYNTHETIC DEMONSTRATION DATA)
 * Run:   npm run seed:ai-demo            (after `npm run seed`; 2 years by default, --days=N to change)
 *        npm run seed:ai-demo -- --clean (remove the demo data only)
 *
 * Cartify has no order history or branch inventory yet, so this script simulates two years of
 * daily sales for 4 sample branches in Mansoura with a simple inventory policy (reorder point,
 * supplier lead times, occasional supplier delays), which produces realistic stockouts.
 *
 * Everything it writes is flagged: branches/movements `isDemo: true`, sales in the separate
 * `syntheticsales` collection with `source: 'synthetic_demo'`. It never edits products, orders,
 * users or any non-demo record. Forecasts trained on this data are labelled as demonstration data.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import productModel from './models/product.model.js';
import branchModel from './models/branch.model.js';
import branchInventoryModel from './models/branchInventory.model.js';
import stockMovementModel from './models/stockMovement.model.js';
import syntheticSaleModel from './models/syntheticSale.model.js';
import forecastRunModel from './models/forecastRun.model.js';
import aiRecommendationModel from './models/aiRecommendation.model.js';
import counterModel from './models/counter.model.js';

const DB_URI = process.env.DB_URL || process.env.DB_URL_ONLINE;
const args = process.argv.slice(2);
const CLEAN_ONLY = args.includes('--clean');
const DAYS = Math.min(Math.max(parseInt(args.find((a) => a.startsWith('--days='))?.split('=')[1] || '730', 10), 120), 1095);
const DAY_MS = 86_400_000;

// ── Deterministic random numbers (same dataset every run for the same products) ──────────────
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hashString = (s) => [...s].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0), 2166136261);
const poisson = (rand, lambda) => {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gaussian(rand)));
  const L = Math.exp(-lambda); let k = 0, p = 1;
  do { k++; p *= rand(); } while (p > L);
  return k - 1;
};
const gaussian = (rand) => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
const gamma4 = (rand) => { let s = 0; for (let i = 0; i < 4; i++) s -= Math.log(rand() || 1e-12); return s / 4; }; // mean 1, overdispersion

// ── Sample branches (Mansoura). Names and coordinates are SAMPLE values for the demo. ─────────
const BRANCHES = [
  { code: 'MNS-UNI', name: 'University Branch', address: 'El-Gomhoreya St., near Mansoura University', location: { lat: 31.0409, lng: 31.3557 }, traffic: 1.1,
    affinity: { 'School Supplies': 1.8, Electronics: 1.3, Accessories: 1.0, Fashion: 0.9, Beauty: 0.8, 'Home & Living': 0.6 } },
  { code: 'MNS-MSH', name: 'El-Mashaya Branch', address: 'El-Mashaya El-Sofleya, Nile Corniche', location: { lat: 31.0458, lng: 31.388 }, traffic: 1.25,
    affinity: { Fashion: 1.5, Beauty: 1.4, Accessories: 1.3, Electronics: 0.9, 'Home & Living': 0.8, 'School Supplies': 0.6 } },
  { code: 'MNS-TOR', name: 'Toriel Branch', address: 'El-Gaish St., Toriel', location: { lat: 31.0503, lng: 31.4006 }, traffic: 0.9,
    affinity: { 'Home & Living': 1.6, Electronics: 1.1, Beauty: 1.0, Fashion: 0.9, Accessories: 0.9, 'School Supplies': 0.8 } },
  { code: 'MNS-GHN', name: 'Gehan Street Branch', address: 'Gehan St., El-Mansoura', location: { lat: 31.0372, lng: 31.3712 }, traffic: 0.8, affinity: {} },
];

// Monthly seasonality (Jan..Dec) per category: back-to-school in Feb/Sep, White Friday in Nov, year-end gifts.
const SEASON = {
  'School Supplies': [1.3, 1.5, 0.9, 0.8, 0.7, 0.6, 0.6, 1.0, 1.9, 1.4, 0.9, 0.8],
  Electronics:       [0.9, 0.9, 0.95, 1.0, 0.95, 1.0, 1.0, 1.0, 1.05, 1.0, 1.6, 1.3],
  Fashion:           [1.1, 0.9, 1.2, 1.3, 1.0, 0.9, 1.0, 0.9, 1.0, 1.1, 1.2, 1.3],
  Beauty:            [1.0, 1.2, 1.3, 1.0, 1.0, 1.0, 1.1, 1.0, 0.9, 1.0, 1.1, 1.4],
  'Home & Living':   [1.0, 0.9, 1.2, 1.3, 1.0, 0.9, 0.9, 0.9, 1.0, 1.0, 1.1, 1.2],
  Accessories:       [1.0, 1.3, 1.1, 1.0, 1.0, 1.0, 1.0, 0.9, 0.9, 1.0, 1.1, 1.4],
};
const WEEKDAY = [1.0, 0.9, 0.9, 0.95, 1.1, 1.35, 1.3]; // Sun..Sat — Friday/Saturday weekend

const seasonal = (category, d) => {
  const m = SEASON[category] || Array(12).fill(1);
  const pos = d.getUTCMonth() + (d.getUTCDate() - 1) / 31 - 0.5; // interpolate between month midpoints
  const i = Math.floor(pos), f = pos - i;
  return m[(i + 12) % 12] * (1 - f) + m[(i + 13) % 12] * f;
};
const finalPrice = (p) => +(p.price * (1 - (p.discount || 0) / 100 + (p.raise || 0) / 100)).toFixed(2);

async function cleanDemoData() {
  const demoBranches = await branchModel.find({ isDemo: true }).select('_id');
  const ids = demoBranches.map((b) => b._id);
  const [sales, inv, mov, recs, runs, branches] = await Promise.all([
    syntheticSaleModel.deleteMany({}),
    branchInventoryModel.deleteMany({ branchId: { $in: ids } }),
    stockMovementModel.deleteMany({ $or: [{ isDemo: true }, { sourceBranchId: { $in: ids } }, { destinationBranchId: { $in: ids } }] }),
    aiRecommendationModel.deleteMany({ $or: [{ isSyntheticData: true }, { affectedBranches: { $in: ids } }] }),
    forecastRunModel.deleteMany({ dataSource: 'synthetic_demo' }),
    branchModel.deleteMany({ isDemo: true }),
  ]);
  console.log(`🧹  Removed demo data: ${sales.deletedCount} synthetic sales, ${branches.deletedCount} branches, ${inv.deletedCount} inventory rows, ${mov.deletedCount} movements, ${recs.deletedCount} recommendations, ${runs.deletedCount} forecast runs`);
}

async function seed() {
  if (!DB_URI) { console.error('❌  DB_URL is not set'); process.exit(1); }
  if (process.env.NODE_ENV === 'production' && !args.includes('--force')) {
    console.error('❌  Refusing to write demo data with NODE_ENV=production (pass --force if you really mean it)');
    process.exit(1);
  }
  await mongoose.connect(DB_URI);
  console.log('✅  MongoDB connected');
  try {
    await cleanDemoData();
    if (CLEAN_ONLY) return;

    const products = await productModel.find({ hide: false }).lean();
    if (!products.length) throw new Error('No products found. Run `npm run seed` first.');

    const branches = await branchModel.insertMany(BRANCHES.map(({ traffic, affinity, ...b }) => ({ ...b, city: 'Mansoura', status: 'active', isDemo: true })));
    console.log(`🏬  Created ${branches.length} sample branches in Mansoura`);

    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const start = new Date(today.getTime() - DAYS * DAY_MS); // last simulated day = yesterday
    const datasetId = `synthetic-demo-${today.toISOString().slice(0, 10)}`;
    const sales = [], inventory = [], movements = [];

    // A few products get a demand surge at University Branch in the last ~75 days (shortage scenario),
    // while El-Mashaya over-ordered them (surplus). One other product has a short sales spike at Gehan St.
    const surge = new Set(products.filter((p) => ['Electronics', 'School Supplies'].includes(p.category))
      .sort((a, b) => hashString(a.name) - hashString(b.name)).slice(0, 3).map((p) => String(p._id)));
    const spikeProduct = String(products.filter((p) => !surge.has(String(p._id)) && ['Beauty', 'Fashion'].includes(p.category))
      .sort((a, b) => hashString(a.name) - hashString(b.name))[0]?._id);

    for (const p of products) {
      const rand = mulberry32(hashString(String(p.name)));
      const price = finalPrice(p);
      const count = p.rating?.count || 0;
      const base = Math.min(4, Math.max(0.15, (0.6 + Math.log10(count + 10)) * Math.pow(120 / (price + 60), 0.6)));
      const u = rand();
      const growth = u < 0.2 ? 0.6 : u < 0.35 ? -0.4 : (rand() - 0.5) * 0.2; // yearly trend
      // ~4 promotions a year, 7–14 days, 10–30 % off
      const promos = [...Array(4)].map(() => { const s = Math.floor(rand() * DAYS); return { s, e: s + 7 + Math.floor(rand() * 8), off: 10 + Math.floor(rand() * 21) }; });

      for (const [bi, b] of BRANCHES.entries()) {
        const branchId = branches[bi]._id;
        const r = mulberry32(hashString(`${p._id}:${b.code}`));
        const level = base * b.traffic * (b.affinity[p.category] ?? 1) * (0.7 + 0.6 * r());
        const lead = 5 + Math.floor(r() * 6);
        const careful = r() > 0.35; // some locations keep a thin buffer and sell out more often
        const bufferDays = careful ? 5 : 1;
        const daysPerOrder = 20 + r() * 25;
        // El-Mashaya over-ordered the surge products: surplus stock that could be transferred
        const overOrder = bi === 1 && surge.has(String(p._id)) ? 3 : 1;
        let stock = Math.round(level * 30 * (0.8 + r() * 0.7)) + 5;
        let pending = null; // { arrive, qty, placed }
        const recent = []; // units sold in the last 14 days: the branch reorders based on recent sales

        for (let t = 0; t < DAYS; t++) {
          const day = new Date(start.getTime() + t * DAY_MS);
          if (pending && t >= pending.arrive) {
            stock += pending.qty;
            if (DAYS - t <= 60) movements.push({ type: 'replenishment', productId: p._id, destinationBranchId: branchId, quantity: pending.qty, status: 'completed', reason: 'Supplier delivery (simulated)', requestedVia: 'demo_seed', isDemo: true, approvedAt: new Date(start.getTime() + pending.placed * DAY_MS), completedAt: day, createdAt: new Date(start.getTime() + pending.placed * DAY_MS) });
            pending = null;
          }
          const promo = promos.find((x) => t >= x.s && t <= x.e);
          const off = promo ? promo.off : 0;
          let mult = seasonal(p.category, day) * WEEKDAY[day.getUTCDay()] * Math.max(0.3, 1 + growth * (t / 365)) * (1 + 2 * off / 100);
          if (bi === 0 && surge.has(String(p._id)) && t > DAYS - 75) mult *= 1 + 1.2 * (t - (DAYS - 75)) / 75;
          if (bi === 3 && String(p._id) === spikeProduct && t > DAYS - 5) mult *= 3.5; // short unusual spike (anomaly demo)
          const demand = poisson(r, level * mult * gamma4(r));
          const sold = Math.min(demand, stock);
          stock -= sold;
          sales.push({ source: 'synthetic_demo', datasetId, date: day, productId: p._id, branchId, unitsSold: sold, unitPrice: +(price * (1 - off / 100)).toFixed(2), discount: Math.min(90, (p.discount || 0) + off), closingStock: stock, inStock: stock > 0, latentDemand: demand });
          recent.push(sold);
          if (recent.length > 14) recent.shift();
          const avg = Math.max(level * 0.5, recent.reduce((a, x) => a + x, 0) / recent.length);
          if (!pending && stock <= Math.ceil(avg * (lead + bufferDays))) {
            const delayed = r() < 0.15; // supplier delay
            pending = { arrive: t + lead * (delayed ? 2 : 1), qty: Math.ceil(avg * daysPerOrder * overOrder) + 3, placed: t };
          }
        }
        inventory.push({ branchId, productId: p._id, quantity: stock, reserved: 0 });
      }
    }

    for (let i = 0; i < sales.length; i += 5000) await syntheticSaleModel.insertMany(sales.slice(i, i + 5000), { ordered: false });
    console.log(`📈  Inserted ${sales.length} synthetic daily sales rows (${DAYS} days × ${products.length} products × ${branches.length} branches)`);
    await branchInventoryModel.insertMany(inventory);
    console.log(`📦  Set current branch inventory for ${inventory.length} product-branch pairs`);

    // A large unexplained stock-count correction (anomaly demo) and two past transfers
    const rand = mulberry32(7);
    const pick = () => products[Math.floor(rand() * products.length)];
    const ago = (d) => new Date(today.getTime() - d * DAY_MS);
    const candidates = inventory.filter((x) => String(x.branchId) === String(branches[2]._id) && x.quantity >= 25);
    const adjRow = candidates[Math.floor(rand() * candidates.length)];
    if (adjRow) {
      const adjQty = Math.round(adjRow.quantity * 0.4); // ~40 % of the stock "missing" at a count
      await branchInventoryModel.updateOne({ branchId: adjRow.branchId, productId: adjRow.productId }, { $inc: { quantity: -adjQty } });
      movements.push({ type: 'adjustment', productId: adjRow.productId, destinationBranchId: adjRow.branchId, quantity: adjQty, delta: -adjQty, status: 'completed', reason: 'Stock count correction (simulated)', requestedVia: 'demo_seed', isDemo: true, completedAt: ago(5), createdAt: ago(5) });
    }
    for (const [from, to, d] of [[1, 0, 21], [3, 2, 12]]) {
      const tp = pick();
      movements.push({ type: 'transfer', productId: tp._id, sourceBranchId: branches[from]._id, destinationBranchId: branches[to]._id, quantity: 4 + Math.floor(rand() * 6), status: 'completed', reason: 'Rebalancing (simulated)', requestedVia: 'demo_seed', isDemo: true, approvedAt: ago(d + 1), completedAt: ago(d), createdAt: ago(d + 1) });
    }

    const counter = await counterModel.findOneAndUpdate({ _id: 'stockMovement' }, { $inc: { seq: movements.length } }, { new: true, upsert: true });
    const firstNo = counter.seq - movements.length + 1;
    movements.sort((a, b) => a.createdAt - b.createdAt).forEach((m, i) => {
      m.movementNumber = firstNo + i;
      m.statusHistory = [{ status: m.status, changedAt: m.completedAt || m.createdAt, note: 'Synthetic demo history' }];
      m.updatedAt = m.completedAt || m.createdAt;
    });
    await stockMovementModel.insertMany(movements, { timestamps: false }); // keep the simulated dates
    console.log(`🚚  Inserted ${movements.length} demo stock movements (last 60 days of deliveries, 2 transfers, 1 adjustment)`);

    const stockouts = sales.filter((s) => !s.inStock).length;
    console.log(`\n⚠️   This is SYNTHETIC DEMONSTRATION DATA (dataset ${datasetId}). ${(100 * stockouts / sales.length).toFixed(1)} % of product-days end sold out.`);
    console.log('✨  Done. Start the AI service, then run a forecast from the admin "Demand Forecasting" page.\n');
  } finally {
    await mongoose.disconnect();
  }
}

seed().catch((err) => { console.error('❌  AI demo seeding failed:', err.message); process.exit(1); });
