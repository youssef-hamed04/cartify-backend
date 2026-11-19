// End-to-end test for the real estate endpoints against a running backend (and ai-service).
// It creates a test user and listings, then deletes the listings it made. Uses JSON bodies only,
// so no photos are uploaded to Cloudinary.
// Usage: node tests/realestate.workflow.mjs [baseUrl]   (after `npm run seed:real-estate`)
const BASE = process.argv[2] || process.env.API_URL || 'http://localhost:3001';
let pass = 0;
let fail = 0;

class Client {
  constructor() { this.bearer = null; }
  async req(method, path, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.bearer) headers.Authorization = `Bearer ${this.bearer}`;
    const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }
}

function check(name, condition, info = '') {
  if (condition) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${typeof info === 'string' ? info : JSON.stringify(info).slice(0, 300)}`); }
}

const guest = new Client();
const owner = new Client();
const stranger = new Client();
const admin = new Client();
const stamp = Date.now();

for (const [client, email] of [[owner, `re.owner.${stamp}@example.com`], [stranger, `re.other.${stamp}@example.com`]]) {
  const r = await client.req('POST', '/users/auth', { email });
  client.bearer = r.data.token;
}
const adminLogin = await admin.req('POST', '/users/auth', { email: 'admin@cartify.com', password: 'Admin@12345' });
admin.bearer = adminLogin.data.token;
check('logins', owner.bearer && stranger.bearer && adminLogin.data.user?.role === 'admin');

// ── Public data
let r = await guest.req('GET', '/real-estate/locations');
check('locations: 19 cities with Arabic names', r.status === 200 && r.data.cities.length === 19 && !!r.data.cities[0].nameAr);
check('locations: enums and data note', r.data.propertyTypes?.includes('villa') && /demonstration/.test(r.data.dataNote));

const apartment = {
  listingType: 'sale', propertyType: 'apartment', city: 'mansoura', district: 'toriel', area: 150, rooms: 3,
  bathrooms: 2, floor: 4, hasElevator: true, buildingAge: 5, finishing: 'super-lux', view: 'street',
};
r = await guest.req('POST', '/real-estate/estimate', apartment);
const sale = r.data.estimate;
check('estimate sale', r.status === 200 && sale.price > 0 && sale.low < sale.price && sale.price < sale.high, r.data);
check('estimate is in a realistic range for Toriel (20k–45k / m²)', sale.pricePerM2 > 20000 && sale.pricePerM2 < 45000, sale);
check('estimate period total', sale.period === 'total' && sale.currency === 'EGP');

r = await guest.req('POST', '/real-estate/estimate', { ...apartment, area: 300 });
check('bigger area costs more in total', r.data.estimate.price > sale.price);
r = await guest.req('POST', '/real-estate/estimate', { ...apartment, finishing: 'none' });
check('unfinished costs less than super-lux', r.data.estimate.price < sale.price);
r = await guest.req('POST', '/real-estate/estimate', { ...apartment, district: 'mansoura', city: 'mansoura' });
check('unknown district rejected', r.status === 400);
r = await guest.req('POST', '/real-estate/estimate', { ...apartment, city: 'talkha' });
check('district from another city rejected', r.status === 400);
r = await guest.req('POST', '/real-estate/estimate', { ...apartment, listingType: 'rent' });
check('estimate rent per month', r.status === 200 && r.data.estimate.period === 'month' && r.data.estimate.price < 100000, r.data);

r = await guest.req('GET', '/real-estate/market?listingType=sale');
check('market summary', r.status === 200 && r.data.districts.length > 20 && r.data.districts[0].avgPerM2 > 0, r.data);

r = await guest.req('GET', '/real-estate/properties?limit=5&sort=price_desc');
check('browse approved listings', r.status === 200 && r.data.total >= 30 && r.data.properties.length === 5);
check('browse sorted by price', r.data.properties.every((p, i, all) => !i || all[i - 1].price >= p.price));
check('browse hides phone from guests', r.data.properties.every(p => !p.contactPhone && p.contactHidden));
check('browse never exposes owner email', r.data.properties.every(p => !p.owner?.email));
r = await guest.req('GET', '/real-estate/properties?listingType=rent&city=mansoura');
check('filter by type and city', r.status === 200 && r.data.properties.every(p => p.listingType === 'rent' && p.city === 'mansoura'));

// ── Owner creates a listing → pending, hidden from the public
const listing = { ...apartment, title: `Test flat ${stamp}`, description: 'Workflow test listing', price: 5000000, contactPhone: '01012345678', amenities: ['parking', 'security'] };
r = await guest.req('POST', '/real-estate/properties', listing);
check('guest cannot create', r.status === 401);
r = await owner.req('POST', '/real-estate/properties', { ...listing, contactPhone: '123' });
check('invalid phone rejected', r.status === 400);
r = await owner.req('POST', '/real-estate/properties', listing);
const created = r.data.property;
check('owner creates listing as pending', r.status === 201 && created?.status === 'pending', r.data);
check('listing gets an estimate and verdict', created?.estimate?.price > 0 && ['below_market', 'fair', 'above_market'].includes(created.estimate.verdict));
const id = created?._id;

r = await guest.req('GET', `/real-estate/properties/${id}`);
check('pending listing hidden from public', r.status === 404);
r = await owner.req('GET', `/real-estate/properties/${id}`);
check('owner can see own pending listing', r.status === 200);
r = await owner.req('GET', '/real-estate/my-properties');
check('my properties lists it', r.data.properties?.some(p => p._id === id));
r = await stranger.req('PATCH', `/real-estate/properties/${id}`, { price: 1 });
check('stranger cannot edit', r.status === 403);
r = await owner.req('PATCH', `/real-estate/properties/${id}/status`, { status: 'sold' });
check('cannot mark pending listing sold', r.status === 409);

// ── Admin review
r = await owner.req('GET', '/real-estate/admin/properties?status=pending');
check('non-admin blocked from admin list', r.status === 403);
r = await admin.req('GET', '/real-estate/admin/properties?status=pending');
check('admin sees pending listing with owner email', r.status === 200 && r.data.properties.some(p => p._id === id && p.owner?.email));
r = await admin.req('PATCH', `/real-estate/admin/properties/${id}/review`, { action: 'reject' });
check('reject needs a reason', r.status === 400);
r = await admin.req('PATCH', `/real-estate/admin/properties/${id}/review`, { action: 'reject', reason: 'Add photos' });
check('admin rejects with reason', r.status === 200 && r.data.property.status === 'rejected' && r.data.property.rejectionReason === 'Add photos');
r = await owner.req('PATCH', `/real-estate/properties/${id}`, { price: 4800000 });
check('owner edit sends it back to pending', r.status === 200 && r.data.property.status === 'pending' && !r.data.property.rejectionReason);
r = await admin.req('PATCH', `/real-estate/admin/properties/${id}/review`, { action: 'approve' });
check('admin approves', r.status === 200 && r.data.property.status === 'approved');

r = await guest.req('GET', `/real-estate/properties/${id}`);
check('approved listing public, phone hidden for guests', r.status === 200 && !r.data.property.contactPhone && r.data.property.contactHidden);
r = await stranger.req('GET', `/real-estate/properties/${id}`);
check('logged-in user sees phone', r.data.property?.contactPhone === '01012345678');

r = await owner.req('PATCH', `/real-estate/properties/${id}/status`, { status: 'rented' });
check('sale listing cannot be marked rented', r.status === 400);
r = await owner.req('PATCH', `/real-estate/properties/${id}/status`, { status: 'sold' });
check('owner marks sold', r.status === 200 && r.data.property.status === 'sold');

// ── Admin stats and model
r = await admin.req('GET', '/real-estate/admin/stats');
check('admin stats', r.status === 200 && r.data.byStatus?.sold >= 1 && Array.isArray(r.data.avgPerM2ByCity?.sale), r.data);
check('stats include trained model', r.data.model?.trained && r.data.model.sale?.chosen && r.data.model.sale.candidates.length === 4, r.data.model);
r = await admin.req('GET', '/real-estate/admin/model');
check('model status', r.status === 200 && r.data.model?.rent?.rows > 0, r.data);

// ── Clean up
r = await stranger.req('DELETE', `/real-estate/properties/${id}`);
check('stranger cannot delete', r.status === 403);
r = await owner.req('DELETE', `/real-estate/properties/${id}`);
check('owner deletes', r.status === 200);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
