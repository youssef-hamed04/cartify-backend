// Synthetic demonstration baselines in EGP, 2026; these are not official market figures.
export const dataNote = 'Prices are based on demonstration data for Dakahlia, not official figures.';
export const propertyTypes = ['apartment', 'studio', 'duplex', 'penthouse', 'villa', 'chalet', 'shop', 'office', 'land'];
export const finishing = ['none', 'semi', 'super-lux', 'ultra-lux'];
export const views = ['street', 'garden', 'nile', 'sea'];
export const amenities = ['parking', 'security', 'garden', 'pool', 'gas', 'ac'];
const d = (slug, nameEn, nameAr, sale, rent, extra) => ({ slug, nameEn, nameAr, baseSalePerM2: sale, baseRentPerM2: rent, views: ['street', 'garden', ...(extra ? [extra] : [])] });
const c = (slug, nameEn, nameAr, districts) => ({ slug, nameEn, nameAr, districts });
export const dakahliaLocations = [
  c('mansoura', 'Mansoura', 'المنصورة', [
    d('toriel', 'Toriel', 'توريل', 32000, 75, 'nile'), d('university', 'University', 'حي الجامعة', 28000, 70),
    d('el-mashaya', 'El Mashaya', 'المشاية', 30000, 72, 'nile'), d('hay-gharb', 'Hay Gharb', 'حي غرب', 22000, 55, 'nile'),
    d('hay-shark', 'Hay Shark', 'حي شرق', 20000, 50), d('mit-hadr', 'Mit Hadr', 'ميت حدر', 18000, 45),
    d('gedila', 'Gedila', 'جديلة', 16000, 40), d('sandoub', 'Sandoub', 'سندوب', 14000, 35),
  ]),
  c('new-mansoura', 'New Mansoura', 'المنصورة الجديدة', [d('seafront', 'Seafront', 'الواجهة البحرية', 45000, 90, 'sea'), d('downtown', 'Downtown', 'وسط المدينة', 34000, 70), d('residential', 'Residential', 'الأحياء السكنية', 28000, 60)]),
  c('talkha', 'Talkha', 'طلخا', [d('talkha-city', 'Talkha City', 'مدينة طلخا', 14000, 34), d('talkha-corniche', 'Talkha Corniche', 'كورنيش طلخا', 17000, 40, 'nile')]),
  c('gamasa', 'Gamasa', 'جمصة', [d('gamasa-beach', 'Gamasa Beach', 'جمصة الشاطئ', 18000, 60, 'sea'), d('gamasa-city', 'Gamasa City', 'جمصة المدينة', 13000, 40)]),
  c('mit-ghamr', 'Mit Ghamr', 'ميت غمر', [d('mit-ghamr-city', 'Mit Ghamr City', 'مدينة ميت غمر', 15000, 35), d('dakadous', 'Dakadous', 'دقادوس', 11000, 26, 'nile')]),
  ...[
    ['aga', 'Aga', 'أجا', 10000, 24], ['senbellawein', 'El Senbellawein', 'السنبلاوين', 12000, 28],
    ['dekernes', 'Dekernes', 'دكرنس', 11000, 26], ['belqas', 'Belqas', 'بلقاس', 10500, 25],
    ['sherbin', 'Sherbin', 'شربين', 10000, 24, 'nile'], ['manzala', 'El Manzala', 'المنزلة', 8500, 20],
    ['minyet-el-nasr', 'Minyet El Nasr', 'منية النصر', 8500, 20], ['bani-ebeid', 'Bani Ebeid', 'بني عبيد', 8000, 19],
    ['nabaroh', 'Nabaroh', 'نبروه', 9500, 22], ['temay-el-amdid', 'Temay El Amdid', 'تمي الأمديد', 8500, 20],
    ['gamaliya', 'El Gamaliya', 'الجمالية', 8000, 19], ['mit-salsil', 'Mit Salsil', 'ميت سلسيل', 7500, 18],
    ['matareya', 'El Matareya', 'المطرية', 8000, 19], ['kurdi', 'El Kurdi', 'الكردي', 7500, 18],
  ].map(([slug, en, ar, sale, rent, view]) => c(slug, en, ar, [d(`${slug}-city`, en, ar, sale, rent, view)])),
];
export const findDistrict = (city, district) => dakahliaLocations.find(c => c.slug === city)?.districts.find(d => d.slug === district);
export function locationError(p) {
  const district = findDistrict(p.city, p.district);
  if (!district) return 'District must belong to a supported Dakahlia city';
  if (!district.views.includes(p.view)) return 'View is not allowed in this district';
  if (p.propertyType === 'chalet' && !(p.city === 'gamasa' || (p.city === 'new-mansoura' && p.district === 'seafront'))) return 'Chalets are only allowed in Gamasa or New Mansoura seafront';
  if (p.propertyType === 'land' && (p.finishing !== 'none' || p.rooms || p.bathrooms || p.floor || p.hasElevator)) return 'Land must have no finishing, rooms, bathrooms, floor or elevator';
  return null;
}
