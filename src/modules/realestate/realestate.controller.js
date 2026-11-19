import connectToDB from '../../../db/connectionDB.js';
import Property from '../../../db/models/property.model.js';
import Market from '../../../db/models/realEstateMarket.model.js';
import { dakahliaLocations, propertyTypes, finishing, views, amenities, dataNote } from '../../../db/data/dakahliaLocations.js';
import { AppError, asyncHandler } from '../../utils/error.js';
import { sendSuccess } from '../../utils/response.js';
import { uploadToCloudinary, deleteFromCloudinary } from '../../utils/cloudinary.js';
import { assertLocation, defaults } from './realestate.validation.js';
import * as service from './realestate.service.js';
import { modelStatus } from './realEstateAiClient.js';

const contentFields = [...service.featureFields, 'title', 'description', 'address', 'amenities', 'price', 'contactPhone'];
const content = body => Object.fromEntries(contentFields.filter(k => body[k] !== undefined).map(k => [k, body[k]]));
const owned = (p, user) => String(p.owner?._id || p.owner) === String(user?._id);
const getProperty = async id => {
  const property = await Property.findById(id);
  if (!property) throw new AppError('Property not found', 404);
  return property;
};
const requireOwner = (p, user) => { if (!owned(p, user)) throw new AppError('Only the owner can modify this property', 403); };
const serialize = (p, user, admin = false) => {
  const result = p.toObject ? p.toObject() : { ...p };
  if (!user) { delete result.contactPhone; result.contactHidden = true; }
  if (result.owner && typeof result.owner === 'object' && 'firstName' in result.owner) {
    const { firstName, lastName, email } = result.owner;
    result.owner = { firstName, lastName, ...(admin ? { email } : {}) };
  }
  return result;
};
const uploadImages = async files => {
  const images = [];
  try {
    for (const file of files || []) {
      const result = await uploadToCloudinary(file, 'cartify/real-estate');
      images.push({ url: result.secure_url, publicId: result.public_id });
    }
    return images;
  } catch (error) {
    await Promise.allSettled(images.map(i => deleteFromCloudinary(i.publicId)));
    throw error;
  }
};
const deleteImages = images => Promise.all(images.filter(i => i.publicId).map(i => deleteFromCloudinary(i.publicId)));
const pagination = req => ({ page: Number(req.query.page || 1), limit: Math.min(50, Number(req.query.limit || 20)) });
async function list(req, filter, admin = false, sort = { createdAt: -1 }) {
  const { page, limit } = pagination(req);
  const [properties, total] = await Promise.all([
    Property.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).populate('owner', admin ? 'firstName lastName email' : 'firstName lastName').lean(),
    Property.countDocuments(filter),
  ]);
  return { properties: properties.map(p => serialize(p, req.user, admin)), total, page, pages: Math.ceil(total / limit) };
}

export const locations = asyncHandler(async (req, res) => {
  await connectToDB();
  sendSuccess(res, 200, 'success', { cities: dakahliaLocations.map(c => ({ ...c,
    districts: c.districts.map(({ slug, nameEn, nameAr, views }) => ({ slug, nameEn, nameAr, views })) })),
  propertyTypes, finishing, views, amenities, dataNote });
});
export const estimate = asyncHandler(async (req, res) => {
  await connectToDB();
  const input = defaults(content(req.body)); assertLocation(input);
  sendSuccess(res, 200, 'success', { estimate: await service.estimate(input) });
});
export const market = asyncHandler(async (req, res) => {
  await connectToDB();
  sendSuccess(res, 200, 'success', { ...await service.marketSummary(req.query.listingType || 'sale'), dataNote });
});
export const properties = asyncHandler(async (req, res) => {
  await connectToDB();
  const q = req.query, filter = { status: 'approved' };
  for (const k of ['listingType', 'propertyType', 'city', 'district', 'finishing']) if (q[k]) filter[k] = q[k];
  for (const [field, min, max] of [['price', 'minPrice', 'maxPrice'], ['area', 'minArea', 'maxArea']]) {
    if (q[min] !== undefined || q[max] !== undefined) filter[field] = { ...(q[min] !== undefined ? { $gte: Number(q[min]) } : {}), ...(q[max] !== undefined ? { $lte: Number(q[max]) } : {}) };
  }
  if (q.rooms !== undefined) filter.rooms = { $gte: Number(q.rooms) };
  if (q.q) filter.title = { $regex: q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  const sorts = { newest: { createdAt: -1 }, price_asc: { price: 1 }, price_desc: { price: -1 }, area_desc: { area: -1 }, best_deal: { 'estimate.diffPercent': 1 } };
  sendSuccess(res, 200, 'success', await list(req, filter, false, { ...(sorts[q.sort] || sorts.newest), _id: 1 }));
});
export const detail = asyncHandler(async (req, res) => {
  await connectToDB();
  const p = await getProperty(req.params.id);
  if (p.status !== 'approved' && !owned(p, req.user) && req.user?.role !== 'admin') throw new AppError('Property not found', 404);
  await Property.updateOne({ _id: p._id }, { $inc: { views: 1 } }, { timestamps: false });
  p.views += 1;
  await p.populate('owner', 'firstName lastName');
  sendSuccess(res, 200, 'success', { property: serialize(p, req.user) });
});
export const create = asyncHandler(async (req, res) => {
  await connectToDB();
  const p = new Property({ ...defaults(content(req.body)), owner: req.user._id });
  assertLocation(p); await p.validate();
  p.estimate = await service.snapshot(p);
  const uploaded = await uploadImages(req.files);
  try { p.images = uploaded; await p.save(); }
  catch (error) { await Promise.allSettled(uploaded.map(i => deleteFromCloudinary(i.publicId))); throw error; }
  sendSuccess(res, 201, 'success', { property: p });
});
export const mine = asyncHandler(async (req, res) => {
  await connectToDB();
  sendSuccess(res, 200, 'success', await list(req, { owner: req.user._id }));
});
export const update = asyncHandler(async (req, res) => {
  await connectToDB();
  const p = await getProperty(req.params.id); requireOwner(p, req.user);
  const fields = content(req.body), removal = req.body.removeImages || [];
  if (!Object.keys(fields).length && !removal.length && !req.files?.length) throw new AppError('No changes supplied', 400);
  if (removal.some(id => !p.images.some(i => i.publicId === id))) throw new AppError('Image does not belong to this property', 400);
  const removed = p.images.filter(i => removal.includes(i.publicId));
  const retained = p.images.filter(i => !removal.includes(i.publicId));
  if (retained.length + (req.files?.length || 0) > 8) throw new AppError('Maximum 8 images per property', 400);
  Object.assign(p, fields);
  p.status = 'pending'; p.rejectionReason = undefined; p.reviewedBy = undefined; p.reviewedAt = undefined;
  assertLocation(p); await p.validate(); p.estimate = await service.snapshot(p);
  const uploaded = await uploadImages(req.files);
  try { p.images = [...retained, ...uploaded]; await p.save(); }
  catch (error) { await Promise.allSettled(uploaded.map(i => deleteFromCloudinary(i.publicId))); throw error; }
  await service.syncMarket(p);
  await deleteImages(removed);
  sendSuccess(res, 200, 'success', { property: p });
});
export const changeStatus = asyncHandler(async (req, res) => {
  await connectToDB();
  const p = await getProperty(req.params.id); requireOwner(p, req.user);
  const status = req.body.status;
  if (p.status !== 'approved') throw new AppError('Only approved properties can change status', 409);
  if ((status === 'sold' && p.listingType !== 'sale') || (status === 'rented' && p.listingType !== 'rent')) throw new AppError('Status does not match listing type', 400);
  p.status = status; await p.save(); await service.syncMarket(p);
  sendSuccess(res, 200, 'success', { property: p });
});
export const remove = asyncHandler(async (req, res) => {
  await connectToDB();
  const p = await getProperty(req.params.id);
  if (!owned(p, req.user) && req.user.role !== 'admin') throw new AppError('Not authorized to delete this property', 403);
  await deleteImages(p.images);
  await p.deleteOne(); await Market.deleteMany({ listingId: p._id, source: 'listing' }); service.invalidateMarketCache();
  sendSuccess(res, 200, 'success', { message: 'Property deleted' });
});
export const adminProperties = asyncHandler(async (req, res) => {
  await connectToDB();
  sendSuccess(res, 200, 'success', await list(req, req.query.status ? { status: req.query.status } : {}, true));
});
export const review = asyncHandler(async (req, res) => {
  await connectToDB();
  const p = await getProperty(req.params.id);
  if (p.status !== 'pending') throw new AppError('Only pending properties can be reviewed', 409);
  p.status = req.body.action === 'approve' ? 'approved' : 'rejected';
  p.rejectionReason = p.status === 'rejected' ? req.body.reason : undefined;
  p.reviewedBy = req.user._id; p.reviewedAt = new Date();
  await p.save(); await service.syncMarket(p);
  sendSuccess(res, 200, 'success', { property: p });
});
// Convert the ai-service metrics to the shape the website and app read.
const describeModel = (metrics = {}) => {
  const describeType = m => ({
    chosen: m.chosenModel,
    candidates: (m.candidates || []).map(c => ({ name: c.model, mae: c.MAE, mape: c.MAPE, r2: c.R2 })),
    rows: m.rowCount,
    trainedAt: m.trainedAt,
  });
  const types = Object.fromEntries(Object.entries(metrics).map(([kind, m]) => [kind, describeType(m)]));
  return Object.keys(types).length ? { trained: true, ...types } : { trained: false };
};
const safeStatus = async () => {
  try { return { reachable: true, ...describeModel(await modelStatus()) }; }
  catch (error) { return { reachable: false, trained: false, error: error.message }; }
};
const countsToMap = rows => Object.fromEntries(rows.map(r => [r._id, r.count]));
export const stats = asyncHandler(async (req, res) => {
  await connectToDB();
  const [counts, model] = await Promise.all([Property.aggregate([{ $facet: {
    byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
    byListingType: [{ $group: { _id: '$listingType', count: { $sum: 1 } } }],
    byCity: [{ $group: { _id: '$city', count: { $sum: 1 } } }],
    averagePricePerM2: [{ $group: { _id: { city: '$city', listingType: '$listingType' }, averagePricePerM2: { $avg: { $divide: ['$price', '$area'] } } } }],
  } }]), safeStatus()]);
  const { byStatus, byListingType, byCity, averagePricePerM2 } = counts[0];
  const avgPerM2ByCity = { sale: [], rent: [] };
  for (const row of averagePricePerM2) {
    avgPerM2ByCity[row._id.listingType]?.push({ city: row._id.city, avgPerM2: Math.round(row.averagePricePerM2) });
  }
  sendSuccess(res, 200, 'success', {
    byStatus: countsToMap(byStatus), byListingType: countsToMap(byListingType), byCity: countsToMap(byCity),
    avgPerM2ByCity, model,
  });
});
export const train = asyncHandler(async (req, res) => {
  await connectToDB();
  sendSuccess(res, 200, 'success', { model: describeModel(await service.trainFromDB()) });
});
export const model = asyncHandler(async (req, res) => {
  await connectToDB();
  sendSuccess(res, 200, 'success', { model: await safeStatus() });
});
