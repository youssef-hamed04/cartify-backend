import Market from '../../../db/models/realEstateMarket.model.js';
import Property from '../../../db/models/property.model.js';
import { realEstateFields } from '../../../db/models/realEstateFields.js';
import { AppError } from '../../utils/error.js';
import * as ai from './realEstateAiClient.js';

export const featureFields = Object.keys(realEstateFields()).filter(key => key !== 'price');
export const pickFeatures = p => Object.fromEntries(featureFields.map(key => [key, p[key]]));
export const marketRow = p => ({ ...pickFeatures(p), price: p.price, pricePerM2: p.price / p.area,
  transactionDate: p.reviewedAt || p.updatedAt || new Date(), source: 'listing', listingId: p._id });

export async function syncMarket(p) {
  if (['approved', 'sold', 'rented'].includes(p.status) && !p.isDemo) {
    const row = marketRow(p);
    if (['sold', 'rented'].includes(p.status)) row.transactionDate = p.updatedAt;
    await Market.updateOne({ listingId: p._id, source: 'listing' }, { $set: row }, { upsert: true, runValidators: true });
  } else {
    await Market.deleteMany({ listingId: p._id, source: 'listing' });
  }
  invalidateMarketCache();
}

let training;
export function trainFromDB() {
  if (!training) training = (async () => {
    const [rows, properties] = await Promise.all([
      Market.find({}).lean(),
      Property.find({ status: { $in: ['approved', 'sold', 'rented'] }, isDemo: { $ne: true } }).lean(),
    ]);
    // Build listing rows from current documents, avoiding stale or duplicate valuations.
    const byListing = new Map(properties.map(p => [String(p._id), { ...marketRow(p), transactionDate: ['sold', 'rented'].includes(p.status) ? p.updatedAt : p.reviewedAt || p.updatedAt }]));
    const trainingRows = rows.filter(r => !r.listingId || !byListing.has(String(r.listingId)));
    trainingRows.push(...byListing.values());
    if (trainingRows.length < 20) throw new AppError('At least 20 market records are required to train the price estimation service', 409);
    return ai.trainModel({ rows: trainingRows, asOf: new Date().toISOString() });
  })().finally(() => { training = null; });
  return training;
}

export function percentile(values, q) {
  const sorted = [...values].sort((a, b) => a - b), pos = (sorted.length - 1) * q;
  const lower = Math.floor(pos), fraction = pos - lower;
  return sorted[lower] + (sorted[Math.ceil(pos)] - sorted[lower]) * fraction;
}
export async function comparables(p) {
  let rows = [];
  for (const filter of [{ district: p.district, propertyType: p.propertyType }, { district: p.district }, {}]) {
    rows = await Market.find({ listingType: p.listingType, city: p.city, ...filter }).select('pricePerM2 transactionDate').lean();
    if (rows.length) break;
  }
  if (!rows.length) throw new AppError('No comparable market data is available for this location', 503);
  const values = rows.map(row => {
    const months = Math.min(24, Math.max(0, (Date.now() - new Date(row.transactionDate).getTime()) / (30.4375 * 86400000)));
    return row.pricePerM2 * (p.listingType === 'sale' ? 1.02 : 1.015) ** months;
  });
  const pricePerM2 = percentile(values, .5);
  return { pricePerM2, price: pricePerM2 * p.area, low: percentile(values, .25) * p.area,
    high: percentile(values, .75) * p.area, method: 'comparables', model: null, comparablesCount: rows.length };
}

export async function estimate(p) {
  let result;
  try {
    try { result = await ai.estimatePrice(pickFeatures(p)); }
    catch (error) {
      if (error.statusCode !== 409) throw error;
      await trainFromDB();
      result = await ai.estimatePrice(pickFeatures(p));
    }
    result = { ...result, method: 'ml', comparablesCount: 0 };
  } catch (error) {
    if (!error.unreachable) throw error;
    result = await comparables(p);
  }
  // Round to 1,000 EGP for sale prices and 50 EGP for monthly rent; price per m² to the pound.
  const step = p.listingType === 'rent' ? 50 : 1000;
  const roundTo = value => Math.round(value / step) * step;
  return { ...result, price: roundTo(result.price), low: roundTo(result.low), high: roundTo(result.high),
    pricePerM2: Math.round(result.pricePerM2), currency: 'EGP', period: p.listingType === 'rent' ? 'month' : 'total' };
}
export async function snapshot(p) {
  const result = await estimate(p), diffPercent = Math.round((p.price - result.price) / result.price * 1000) / 10;
  return { ...result, diffPercent, verdict: diffPercent < -10 ? 'below_market' : diffPercent > 10 ? 'above_market' : 'fair', computedAt: new Date() };
}

const cache = new Map();
export const invalidateMarketCache = () => cache.clear();
export async function marketSummary(listingType) {
  const hit = cache.get(listingType);
  if (hit && hit.expires > Date.now()) return hit.data;
  const since = new Date(); since.setUTCMonth(since.getUTCMonth() - 6);
  const rows = await Market.find({ listingType, transactionDate: { $gte: since, $lte: new Date() } }).select('city district pricePerM2').lean();
  const districts = new Map(), cities = new Map();
  for (const r of rows) {
    const key = `${r.city}/${r.district}`;
    if (!districts.has(key)) districts.set(key, { city: r.city, district: r.district, values: [] });
    if (!cities.has(r.city)) cities.set(r.city, { city: r.city, values: [] });
    districts.get(key).values.push(r.pricePerM2); cities.get(r.city).values.push(r.pricePerM2);
  }
  const summarize = ({ values, ...keys }) => ({ ...keys, count: values.length,
    avgPerM2: Math.round(values.reduce((a, b) => a + b, 0) / values.length), medianPerM2: Math.round(percentile(values, .5)) });
  const data = { listingType, currency: 'EGP', period: listingType === 'rent' ? 'month' : 'total',
    districts: [...districts.values()].map(summarize), cities: [...cities.values()].map(summarize) };
  cache.set(listingType, { expires: Date.now() + 600000, data });
  return data;
}
