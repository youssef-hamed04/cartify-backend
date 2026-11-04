import productModel from '../../../db/models/product.model.js';
import reviewModel from '../../../db/models/review.model.js';
import connectToDB from '../../../db/connectionDB.js';
import { AppError, asyncHandler } from '../../utils/error.js';
import { sendSuccess } from '../../utils/response.js';
import { uploadToCloudinary, deleteFromCloudinary } from '../../utils/cloudinary.js';
import { slugify } from '../../utils/slug.js';

export const getProducts = asyncHandler(async (req, res) => {
  await connectToDB();
  const { page = 1, limit = 4, search, category, brand, minPrice, maxPrice, sort, featured, color } = req.query;
  const filter = { hide: false };
  if (search) filter.$or = [{ name: { $regex: search, $options: 'i' } }, { category: { $regex: search, $options: 'i' } }, { brand: { $regex: search, $options: 'i' } }, { description: { $regex: search, $options: 'i' } }];
  if (category) filter.category = { $regex: category, $options: 'i' };
  if (brand) filter.brand = { $regex: brand, $options: 'i' };
  if (featured === 'true') filter.isFeatured = true;
  if (minPrice || maxPrice) { filter.price = {}; if (minPrice) filter.price.$gte = Number(minPrice); if (maxPrice) filter.price.$lte = Number(maxPrice); }
  if (color) filter['variants.color'] = { $regex: color, $options: 'i' };
  const sortMap = { price_asc: { price: 1 }, price_desc: { price: -1 }, newest: { createdAt: -1 }, rating: { 'rating.average': -1 } };
  const sortQuery = sortMap[sort] || { createdAt: -1 };
  const p = Math.max(parseInt(page) || 1, 1);
  const l = Math.min(Math.max(parseInt(limit) || 4, 1), 100);
  const skip = (p - 1) * l;
  const total = await productModel.countDocuments(filter);
  const products = await productModel.find(filter).sort(sortQuery).skip(skip).limit(l);
  sendSuccess(res, 200, 'success', { page: p, limit: l, total, totalPages: Math.ceil(total / l), products });
});

export const getProductById = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const product = await productModel.findById(req.params.id);
  if (!product || product.hide) return next(new AppError('Product not found', 404));
  sendSuccess(res, 200, 'success', { product });
});

export const getProductBySlug = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const product = await productModel.findOne({ slug: req.params.slug, hide: false });
  if (!product) return next(new AppError('Product not found', 404));
  sendSuccess(res, 200, 'success', { product });
});

export const getAllCategories = asyncHandler(async (req, res) => {
  await connectToDB();
  const categories = await productModel.aggregate([{ $match: { hide: false } }, { $group: { _id: '$category', count: { $sum: 1 } } }, { $project: { _id: 0, category: '$_id', count: 1 } }, { $sort: { count: -1 } }]);
  sendSuccess(res, 200, 'success', { categories });
});

export const getAllBrands = asyncHandler(async (req, res) => {
  await connectToDB();
  const brands = await productModel.aggregate([{ $match: { hide: false, brand: { $ne: null } } }, { $group: { _id: '$brand', count: { $sum: 1 } } }, { $project: { _id: 0, brand: '$_id', count: 1 } }, { $sort: { count: -1 } }]);
  sendSuccess(res, 200, 'success', { brands });
});

export const getFeaturedProducts = asyncHandler(async (req, res) => {
  await connectToDB();
  const products = await productModel.find({ isFeatured: true, hide: false }).limit(parseInt(req.query.limit) || 8);
  sendSuccess(res, 200, 'success', { products });
});

export const createProduct = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const { name, price, description, category, brand, discount, raise, variantsMeta } = req.body;
  let parsedVariants = [];
  try { parsedVariants = typeof variantsMeta === 'string' ? JSON.parse(variantsMeta) : (variantsMeta || []); } catch { return next(new AppError('Invalid variantsMeta JSON', 400)); }
  const uploadResults = req.files?.length ? await Promise.all(req.files.map((f) => uploadToCloudinary(f, 'cartify/products'))) : [];
  const variants = parsedVariants.map((v) => ({ color: v.color, colorHex: v.colorHex || '', stock: v.stock || 0, reserved: 0, images: (v.fileIndexes || []).map((idx) => ({ url: uploadResults[idx]?.secure_url || '', publicId: uploadResults[idx]?.public_id || '' })) }));
  let slug = slugify(name);
  if (await productModel.findOne({ slug })) slug = `${slug}-${Date.now()}`;
  const product = await productModel.create({ name, slug, price, description, category, brand, discount: discount || 0, raise: raise || 0, variants });
  sendSuccess(res, 201, 'success', { product });
});

export const updateProduct = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const product = await productModel.findById(req.params.id);
  if (!product) return next(new AppError('Product not found', 404));
  const { name, price, description, category, brand, discount, raise, hide, isFeatured, variantsMeta } = req.body;
  const uploadResults = req.files?.length ? await Promise.all(req.files.map((f) => uploadToCloudinary(f, 'cartify/products'))) : [];
  if (variantsMeta) {
    let pv; try { pv = typeof variantsMeta === 'string' ? JSON.parse(variantsMeta) : variantsMeta; } catch { return next(new AppError('Invalid variantsMeta JSON', 400)); }
    product.variants = pv.map((v) => { const old = product.variants.find((x) => x.color === v.color); const oldImgs = (v.keepOldImages || []).map((url) => ({ url })); const newImgs = (v.fileIndexes || []).map((idx) => ({ url: uploadResults[idx]?.secure_url || '', publicId: uploadResults[idx]?.public_id || '' })); return { color: v.color, colorHex: v.colorHex || old?.colorHex || '', stock: v.stock ?? old?.stock ?? 0, reserved: old?.reserved ?? 0, images: [...oldImgs, ...newImgs] }; });
  }
  if (name !== undefined) { product.name = name; product.slug = slugify(name); }
  if (price !== undefined) product.price = price;
  if (description !== undefined) product.description = description;
  if (category !== undefined) product.category = category;
  if (brand !== undefined) product.brand = brand;
  if (discount !== undefined) product.discount = discount;
  if (raise !== undefined) product.raise = raise;
  if (hide !== undefined) product.hide = hide === 'true' || hide === true;
  if (isFeatured !== undefined) product.isFeatured = isFeatured === 'true' || isFeatured === true;
  await product.save();
  sendSuccess(res, 200, 'success', { product });
});

export const bulkUpdateByBrand = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const { brand, raise, discount } = req.body;
  if (!brand) return next(new AppError('Brand is required', 400));
  const result = await productModel.updateMany({ brand: { $regex: brand, $options: 'i' } }, { $set: { raise, discount } });
  if (result.matchedCount === 0) return next(new AppError('No products found for this brand', 404));
  sendSuccess(res, 200, 'success', { updated: result.modifiedCount });
});

export const bulkUpdateByCategory = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const { category, raise, discount } = req.body;
  if (!category) return next(new AppError('Category is required', 400));
  const result = await productModel.updateMany({ category: { $regex: category, $options: 'i' } }, { $set: { raise, discount } });
  if (result.matchedCount === 0) return next(new AppError('No products found for this category', 404));
  sendSuccess(res, 200, 'success', { updated: result.modifiedCount });
});

export const deleteProduct = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const product = await productModel.findById(req.params.id);
  if (!product) return next(new AppError('Product not found', 404));
  await Promise.allSettled(product.variants.flatMap((v) => v.images.filter((i) => i.publicId).map((i) => deleteFromCloudinary(i.publicId))));
  await product.deleteOne();
  sendSuccess(res, 200, 'success', { message: 'Product deleted' });
});

export const getProductReviews = asyncHandler(async (req, res) => {
  await connectToDB();
  const { page = 1, limit = 10 } = req.query;
  const p = Math.max(parseInt(page) || 1, 1); const l = Math.min(parseInt(limit) || 10, 50); const skip = (p - 1) * l;
  const [reviews, total] = await Promise.all([
    reviewModel.find({ productId: req.params.id }).populate('userId', 'firstName lastName avatar').sort({ createdAt: -1 }).skip(skip).limit(l),
    reviewModel.countDocuments({ productId: req.params.id }),
  ]);
  sendSuccess(res, 200, 'success', { page: p, limit: l, total, totalPages: Math.ceil(total / l), reviews });
});
