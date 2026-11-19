// Offline regression checks: no database connections, server listeners, or external services.
import assert from 'node:assert/strict';
import { validationResult } from 'express-validator';
import { generateMarketRows } from '../db/data/realEstateSynthetic.js';
import { dakahliaLocations, locationError } from '../db/data/dakahliaLocations.js';
import Property from '../db/models/property.model.js';
import Market from '../db/models/realEstateMarket.model.js';
import { featureRules, propertyRules, listRules, reviewRules, defaults } from '../src/modules/realestate/realestate.validation.js';
import { estimate, percentile, snapshot, trainFromDB, syncMarket } from '../src/modules/realestate/realestate.service.js';
import { detail, changeStatus, update, review } from '../src/modules/realestate/realestate.controller.js';

const rows = generateMarketRows(6000, 2026, new Date('2026-11-19T00:00:00Z'));
assert.deepEqual(rows, generateMarketRows(6000, 2026, new Date('2026-11-19T00:00:00Z')));
assert.equal(dakahliaLocations.length, 19);
assert.equal(dakahliaLocations.reduce((n, c) => n + c.districts.length, 0), 31);
assert.ok(rows.filter(r => r.listingType === 'sale').length / rows.length > .70);
for (const row of rows) {
  assert.equal(locationError(row), null);
  assert.ok(row.price > 0);
  assert.equal(row.price / row.area, row.pricePerM2);
  assert.equal(row.price % (row.listingType === 'sale' ? 1000 : 50), 0);
}
const base = { ...rows[0], owner: '507f1f77bcf86cd799439011', title: 'Valid property', contactPhone: '01012345678' };
await new Property(base).validate();
await assert.rejects(new Property({ ...base, city: 'mansoura', district: 'seafront' }).validate());
await assert.rejects(new Property({ ...base, images: Array.from({ length: 9 }, () => ({ url: 'https://example.com/image.jpg' })) }).validate());
await assert.rejects(new Property({ ...base, contactPhone: '123' }).validate());
assert.ok(locationError(defaults({ city: 'mansoura', district: 'toriel', propertyType: 'land', rooms: 1 })));
assert.ok(locationError(defaults({ city: 'mansoura', district: 'toriel', propertyType: 'chalet' })));

async function validate(rules, body = {}, query = {}) {
  const req = { body, query };
  for (const rule of rules) await rule.run(req);
  return validationResult(req);
}
assert.ok((await validate(featureRules(), rows[0])).isEmpty());
assert.ok(!(await validate(featureRules(), { ...rows[0], area: 0 })).isEmpty());
assert.ok((await validate(propertyRules(true), { title: 'Updated title' })).isEmpty());
assert.ok(!(await validate(propertyRules(true), { price: -10 })).isEmpty());
assert.ok(!(await validate(listRules, {}, { city: 'mansoura', district: 'seafront' })).isEmpty());
assert.ok(!(await validate(listRules, {}, { limit: 51 })).isEmpty());
assert.ok(!(await validate(reviewRules, { action: 'reject' })).isEmpty());
assert.equal(percentile([10, 20, 30, 40], .5), 25);

const originalFetch = global.fetch, originalFind = Market.find, originalProperties = Property.find;
const originalUpdate = Market.updateOne, originalDelete = Market.deleteMany;
try {
  global.fetch = async () => ({ ok: true, json: async () => ({ price: 100000, pricePerM2: 1000, low: 80000, high: 120000, model: 'Ridge' }) });
  const low = await snapshot({ ...base, price: 80000 });
  assert.equal(low.verdict, 'below_market'); assert.equal(low.diffPercent, -20);
  assert.equal((await snapshot({ ...base, price: 100000 })).verdict, 'fair');
  assert.equal((await snapshot({ ...base, price: 120000 })).verdict, 'above_market');

  let filterCalls = 0;
  global.fetch = async () => { throw new Error('offline'); };
  Market.find = filter => {
    filterCalls += 1;
    assert.equal(filter.city, base.city);
    return { select: () => ({ lean: async () => filter.propertyType ? [] : [1000, 2000, 3000].map(pricePerM2 => ({ pricePerM2, transactionDate: new Date() })) }) };
  };
  const fallback = await estimate({ ...base, area: 100, listingType: 'rent' });
  assert.equal(filterCalls, 2); assert.equal(fallback.method, 'comparables'); assert.equal(fallback.period, 'month');
  assert.equal(fallback.comparablesCount, 3); assert.ok(Math.abs(fallback.price - 200000) < 1);

  const id = '507f1f77bcf86cd799439011';
  let sentRows, calls = 0;
  Market.find = () => ({ lean: async () => [...rows.slice(0, 30), { ...rows[0], source: 'listing', listingId: id }] });
  Property.find = () => ({ lean: async () => [{ ...base, _id: id, status: 'approved', reviewedAt: new Date() }] });
  global.fetch = async (url, options) => {
    if (url.endsWith('/train')) { sentRows = JSON.parse(options.body).rows; return { ok: true, json: async () => ({}) }; }
    calls += 1;
    return calls === 1 ? { ok: false, status: 409, json: async () => ({ detail: 'model not trained' }) }
      : { ok: true, json: async () => ({ price: 100, pricePerM2: 1, low: 80, high: 120, model: 'Ridge' }) };
  };
  assert.equal((await estimate(base)).method, 'ml'); assert.equal(calls, 2); assert.equal(sentRows.length, 31);
  assert.equal(sentRows.filter(r => r.listingId === id).length, 1);
  await trainFromDB();
  let synced, deleted;
  Market.updateOne = async (filter, update) => { synced = update.$set; };
  Market.deleteMany = async filter => { deleted = filter; };
  await syncMarket({ ...base, _id: id, status: 'sold', updatedAt: new Date() });
  assert.equal(synced.source, 'listing'); assert.equal(synced.listingId, id);
  await syncMarket({ ...base, _id: id, status: 'pending' }); assert.equal(deleted.listingId, id);
} finally {
  global.fetch = originalFetch; Market.find = originalFind; Property.find = originalProperties;
  Market.updateOne = originalUpdate; Market.deleteMany = originalDelete;
}
console.log('PASS real estate offline validation, generation, estimates, fallback, training retry/deduplication and market sync');

const oldConnection = global._mongooseCache.conn;
const originalById = Property.findById, originalPropertyUpdate = Property.updateOne;
global._mongooseCache.conn = {}; // Satisfy connectToDB without opening a connection.
function invoke(handler, req) {
  return new Promise((resolve, reject) => {
    const res = { status() { return this; }, json: resolve };
    handler(req, res, reject);
  });
}
try {
  let incremented = 0;
  Property.findById = async () => ({ ...base, status: 'approved', views: 0,
    async populate() { this.owner = { firstName: 'Owner', lastName: 'Name', email: 'private@example.com', password: 'secret' }; return this; } });
  Property.updateOne = async () => { incremented++; };
  const anonymous = await invoke(detail, { params: { id: base.owner }, user: null });
  assert.equal(anonymous.property.contactHidden, true); assert.ok(!('contactPhone' in anonymous.property));
  assert.deepEqual(anonymous.property.owner, { firstName: 'Owner', lastName: 'Name' }); assert.equal(incremented, 1);
  const authenticated = await invoke(detail, { params: { id: base.owner }, user: { _id: base.owner } });
  assert.equal(authenticated.property.contactPhone, base.contactPhone);
  Property.findById = async () => ({ ...base, status: 'pending' });
  await assert.rejects(invoke(detail, { params: { id: base.owner }, user: null }), e => e.statusCode === 404);
  await assert.rejects(invoke(update, { params: { id: base.owner }, user: { _id: '507f1f77bcf86cd799439012' }, body: { title: 'Not mine' } }), e => e.statusCode === 403);
  await assert.rejects(invoke(changeStatus, { params: { id: base.owner }, user: { _id: base.owner }, body: { status: 'sold' } }), e => e.statusCode === 409);
  Property.findById = async () => ({ ...base, listingType: 'rent', status: 'approved' });
  await assert.rejects(invoke(changeStatus, { params: { id: base.owner }, user: { _id: base.owner }, body: { status: 'sold' } }), e => e.statusCode === 400);
  await assert.rejects(invoke(review, { params: { id: base.owner }, user: { _id: base.owner, role: 'admin' }, body: { action: 'approve' } }), e => e.statusCode === 409);
} finally {
  global._mongooseCache.conn = oldConnection;
  Property.findById = originalById; Property.updateOne = originalPropertyUpdate;
}
console.log('PASS real estate contact privacy, owner authorization, visibility and status transition guards');
