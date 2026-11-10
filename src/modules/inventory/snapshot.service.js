// Daily stock snapshots (online store + every branch). Going forward they tell the forecasting model
// which zero-sales days were stockouts. Taken once a day by the server (when it runs as a normal
// long-lived process) and on demand via POST /inventory/snapshots.
import productModel from '../../../db/models/product.model.js';
import branchInventoryModel from '../../../db/models/branchInventory.model.js';
import inventorySnapshotModel from '../../../db/models/inventorySnapshot.model.js';
import connectToDB from '../../../db/connectionDB.js';
import { utcDay } from '../forecast/forecastData.js';

export async function takeInventorySnapshot(date = new Date()) {
  const day = utcDay(date);
  const [products, inventory] = await Promise.all([
    productModel.find().select('variants.stock variants.reserved').lean(),
    branchInventoryModel.find().select('branchId productId quantity reserved').lean(),
  ]);
  const ops = [
    ...products.map((p) => ({
      productId: p._id, branchId: null,
      onHand: (p.variants || []).reduce((a, v) => a + (v.stock || 0), 0),
      reserved: (p.variants || []).reduce((a, v) => a + (v.reserved || 0), 0),
    })),
    ...inventory.map((r) => ({ productId: r.productId, branchId: r.branchId, onHand: r.quantity, reserved: r.reserved })),
  ].map((s) => ({ updateOne: { filter: { date: day, branchId: s.branchId, productId: s.productId }, update: { $set: { onHand: s.onHand, reserved: s.reserved } }, upsert: true } }));
  if (ops.length) await inventorySnapshotModel.bulkWrite(ops, { ordered: false });
  return { date: day, rows: ops.length };
}

// Snapshot once per UTC day while the server runs. Disabled on serverless platforms (no long-lived
// process) and with INVENTORY_SNAPSHOTS=off; there, call POST /inventory/snapshots from a cron job.
export function startSnapshotSchedule() {
  if (process.env.INVENTORY_SNAPSHOTS === 'off' || process.env.VERCEL || process.env.NODE_ENV === 'test') return;
  let lastDay = null;
  const tick = async () => {
    const today = utcDay().toISOString();
    if (today === lastDay) return;
    try {
      await connectToDB();
      const { rows } = await takeInventorySnapshot();
      lastDay = today;
      console.log(`📸  Inventory snapshot for ${today.slice(0, 10)}: ${rows} product-locations`);
    } catch (err) {
      console.error('[snapshot] failed:', err.message);
    }
  };
  setTimeout(tick, 15_000).unref();
  setInterval(tick, 60 * 60_000).unref();
}
