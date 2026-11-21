import 'dotenv/config';
import mongoose from 'mongoose';
import connectToDB from './connectionDB.js';
import Market from './models/realEstateMarket.model.js';
import Property from './models/property.model.js';
import User from './models/user.model.js';
import { generateMarketRows } from './data/realEstateSynthetic.js';
import { dakahliaLocations } from './data/dakahliaLocations.js';

// "3-room apartment for rent in Toriel, Mansoura" built from the location names.
const typeNames = { apartment: 'apartment', studio: 'studio', duplex: 'duplex', penthouse: 'penthouse', villa: 'villa',
  chalet: 'chalet', shop: 'shop', office: 'office', land: 'land plot' };
function demoTitle(row) {
  const city = dakahliaLocations.find(c => c.slug === row.city);
  const district = city?.districts.find(d => d.slug === row.district);
  const place = district && city && !district.nameEn.startsWith(city.nameEn) ? `${district.nameEn}, ${city.nameEn}` : (district?.nameEn || row.district);
  const residential = !['shop', 'office', 'land'].includes(row.propertyType);
  const size = residential && row.rooms > 0 ? `${row.rooms}-room ` : `${row.area} m² `;
  const purpose = row.listingType === 'rent' ? 'for rent' : 'for sale';
  return `${size}${typeNames[row.propertyType]} ${purpose} in ${place}`;
}
import { snapshot } from '../src/modules/realestate/realestate.service.js';

async function seed() {
  await connectToDB();
  const clean = process.argv.includes('--clean');
  const admin = clean ? null : await User.findOne({ role: 'admin' }).sort({ createdAt: 1 });
  if (!clean && !admin) throw new Error('Create an admin user before seeding real estate');
  const demoIds = await Property.find({ isDemo: true }).distinct('_id');
  await Market.deleteMany({ $or: [{ source: 'synthetic_demo' }, { source: 'listing', listingId: { $in: demoIds } }] });
  await Property.deleteMany({ isDemo: true });
  if (clean) return console.log('Removed only real estate demo data');
  const rows = generateMarketRows();
  await Market.insertMany(rows);
  const photos = ['photo-1600585154340-be6161a56a0c', 'photo-1600607687920-4e2a09cf159d', 'photo-1600566753086-00f18fb6b3ea'];
  // Demo asking prices: most near the market, some clearly cheaper or dearer, so every verdict appears.
  const askingFactors = [1, 0.82, 1, 1.2, 1, 1, 0.9, 1.1];
  const step = row => (row.listingType === 'rent' ? 50 : 1000);
  // Listings are priced at today's market: use the 30 most recent market records.
  const recentRows = [...rows].sort((x, y) => y.transactionDate - x.transactionDate).slice(0, 30);
  const listingRows = recentRows.map((row, i) => {
    const price = Math.round(row.price * askingFactors[i % askingFactors.length] / step(row)) * step(row);
    return { ...row, price, pricePerM2: price / row.area };
  });
  // Estimates use the trained model (trained on first use), or comparables when the ai-service is off.
  const properties = [];
  for (const [i, row] of listingRows.entries()) {
    const estimate = await snapshot(row);
    properties.push({ ...row, owner: admin._id,
    title: demoTitle(row), description: 'Synthetic demonstration listing, not a real offer.',
    status: 'approved', isDemo: true, contactPhone: '01000000000', reviewedBy: admin._id, reviewedAt: new Date(),
    images: [{ url: `https://images.unsplash.com/${photos[i % photos.length]}?w=1000&auto=format&fit=crop` }],
    estimate,
    });
  }
  await Property.insertMany(properties);
  console.log('Created 6000 synthetic demo market rows and 30 approved demo properties');
}
seed().catch(err => { console.error(err.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
