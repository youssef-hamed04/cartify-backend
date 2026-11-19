import { body, query } from 'express-validator';
import { propertyTypes, finishing, views, amenities, dakahliaLocations, findDistrict, locationError } from '../../../db/data/dakahliaLocations.js';
import { AppError } from '../../utils/error.js';

export const normalizeMultipart = (req, res, next) => {
  try {
    for (const field of ['amenities', 'removeImages']) {
      if (typeof req.body?.[field] === 'string') req.body[field] = JSON.parse(req.body[field]);
    }
    next();
  } catch { next(new AppError('amenities and removeImages must be JSON arrays', 400)); }
};
export function featureRules(partial = false) {
  const required = key => partial ? body(key).optional() : body(key);
  return [
    required('listingType').isIn(['sale', 'rent']), required('propertyType').isIn(propertyTypes),
    required('city').isIn(dakahliaLocations.map(c => c.slug)), required('district').isString().isLength({ min: 1, max: 80 }),
    required('area').isFloat({ min: 15, max: 5000 }).toFloat(),
    ...[['rooms', 0, 20], ['bathrooms', 0, 10], ['floor', -1, 60], ['buildingAge', 0, 80]].map(([k, min, max]) => body(k).optional().isInt({ min, max }).toInt()),
    body('finishing').optional().isIn(finishing), body('view').optional().isIn(views),
    ...['furnished', 'hasElevator'].map(k => body(k).optional().isBoolean({ strict: false }).toBoolean()),
  ];
}
export function propertyRules(partial = false) {
  const required = key => partial ? body(key).optional() : body(key);
  return [...featureRules(partial), required('title').isString().trim().isLength({ min: 5, max: 120 }),
    required('price').isFloat({ gt: 0 }).toFloat(), required('contactPhone').isString().matches(/^(010|011|012|015)[0-9]{8}$/),
    body('description').optional().isString().isLength({ max: 3000 }), body('address').optional().isString().isLength({ max: 500 }),
    body('amenities').optional().isArray({ max: 6 }), body('amenities.*').isIn(amenities),
    body('removeImages').optional().isArray({ max: 8 }), body('removeImages.*').isString().isLength({ min: 1, max: 250 }),
  ];
}
export function assertLocation(p) {
  const error = locationError(p);
  if (error) throw new AppError(error, 400);
}
export const defaults = p => ({ rooms: 0, bathrooms: 0, floor: 0, hasElevator: false, buildingAge: 0,
  finishing: 'none', furnished: false, view: 'street', ...p });
export const paginationRules = [query('page').optional().isInt({ min: 1, max: 100000 }), query('limit').optional().isInt({ min: 1, max: 50 })];
export const listingTypeRule = query('listingType').optional().isIn(['sale', 'rent']);
export const listRules = [...paginationRules, listingTypeRule,
  query('propertyType').optional().isIn(propertyTypes), query('city').optional().isIn(dakahliaLocations.map(c => c.slug)),
  query('district').optional().isString().custom((v, { req }) => {
    if (req.query.city ? !findDistrict(req.query.city, v) : !dakahliaLocations.some(c => c.districts.some(d => d.slug === v))) throw new Error('Invalid district for city');
    return true;
  }),
  ...['minPrice', 'maxPrice', 'minArea', 'maxArea'].map(k => query(k).optional().isFloat({ min: 0 })),
  query('rooms').optional().isInt({ min: 0, max: 20 }), query('finishing').optional().isIn(finishing),
  query('q').optional().isString().isLength({ max: 120 }),
  query('sort').optional().isIn(['newest', 'price_asc', 'price_desc', 'area_desc', 'best_deal']),
];
export const statusRules = [body('status').isIn(['sold', 'rented', 'archived'])];
export const reviewRules = [body('action').isIn(['approve', 'reject']), body('reason').optional().isString().trim().isLength({ max: 1000 }),
  body('reason').custom((value, { req }) => req.body.action !== 'reject' || (typeof value === 'string' && value.trim().length > 0)).withMessage('A rejection reason is required')];
export const adminRules = [...paginationRules, query('status').optional().isIn(['pending', 'approved', 'rejected', 'sold', 'rented', 'archived'])];
