import { dakahliaLocations, propertyTypes, finishing } from './dakahliaLocations.js';
// Reproducible synthetic DEMO data only. Pass asOf explicitly for identical dated output.
export function generateMarketRows(count = 6000, seed = 2026, asOf = new Date()) {
  let state = seed >>> 0;
  const rng = () => { state = (1664525 * state + 1013904223) >>> 0; return (state + 0.5) / 4294967296; };
  const pick = a => a[Math.floor(rng() * a.length)];
  const ranges = [[80,250], [40,70], [180,350], [150,300], [250,600], [60,150], [20,150], [40,200], [150,1000]];
  const multipliers = [1,1.05,1.10,1.15,1.35,1,1.6,1.2,0.55];
  const districts = dakahliaLocations.flatMap(c => c.districts.flatMap(d => Array(['mansoura','new-mansoura','talkha'].includes(c.slug) ? 5 : 1).fill({ city: c.slug, ...d })));
  return Array.from({ length: count }, () => {
    const d = pick(districts), listingType = rng() < 0.75 ? 'sale' : 'rent';
    const allowed = propertyTypes.filter(t => t !== 'chalet' || d.city === 'gamasa' || (d.city === 'new-mansoura' && d.slug === 'seafront'));
    const propertyType = pick(allowed), i = propertyTypes.indexOf(propertyType), land = propertyType === 'land';
    const area = Math.round(ranges[i][0] + rng() * (ranges[i][1] - ranges[i][0]));
    const finish = land ? 'none' : pick(finishing), floor = land ? 0 : Math.floor(rng() * 11);
    const hasElevator = !land && rng() < 0.65, buildingAge = Math.floor(rng() * 41);
    const furnished = !land && listingType === 'rent' && rng() < 0.35, view = pick(d.views);
    const monthsAgo = rng() * 24;
    const factor = multipliers[i] * ({ none: .78, semi: .88, 'super-lux': 1, 'ultra-lux': 1.12 }[finish])
      * (furnished ? 1.25 : 1) * Math.max(.70, 1 - .008 * buildingAge)
      * (land ? 1 : floor === 0 ? .95 : floor < 4 ? 1 : hasElevator ? 1.02 : 1 - .03 * (floor - 4))
      * ({ nile: 1.12, sea: 1.15, garden: 1.05, street: 1 }[view]) * (area / 120) ** -.08
      * (listingType === 'sale' ? 1.02 : 1.015) ** -monthsAgo
      * Math.exp(.12 * Math.sqrt(-2 * Math.log(rng())) * Math.cos(2 * Math.PI * rng()));
    const step = listingType === 'sale' ? 1000 : 50;
    const price = Math.max(step, Math.round((listingType === 'sale' ? d.baseSalePerM2 : d.baseRentPerM2) * area * factor / step) * step);
    return { listingType, propertyType, city: d.city, district: d.slug, area,
      rooms: land ? 0 : Math.max(1, Math.min(8, Math.round(area / 45))), bathrooms: land ? 0 : Math.max(1, Math.round(area / 100)),
      floor, hasElevator, buildingAge, finishing: finish, furnished, view, price, pricePerM2: price / area,
      transactionDate: new Date(new Date(asOf).getTime() - monthsAgo * 30.4375 * 86400000), source: 'synthetic_demo' };
  });
}
