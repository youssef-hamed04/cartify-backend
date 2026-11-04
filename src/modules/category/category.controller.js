import categoryModel from '../../../db/models/category.model.js';
import productModel  from '../../../db/models/product.model.js';
import connectToDB   from '../../../db/connectionDB.js';
import { AppError, asyncHandler } from '../../utils/error.js';
import { sendSuccess } from '../../utils/response.js';
import { uploadToCloudinary, deleteFromCloudinary } from '../../utils/cloudinary.js';
import { slugify } from '../../utils/slug.js';

export const getCategories = asyncHandler(async (req, res) => {
  await connectToDB();
  const categories = await categoryModel.find({ isActive:true }).sort({ displayOrder:1, name:1 });
  sendSuccess(res, 200, 'success', { categories });
});

export const getCategoryBySlug = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const category = await categoryModel.findOne({ slug:req.params.slug, isActive:true });
  if (!category) return next(new AppError('Category not found', 404));
  const { page=1, limit=12 } = req.query;
  const p=Math.max(parseInt(page)||1,1); const l=Math.min(parseInt(limit)||12,100); const skip=(p-1)*l;
  const filter = { category:{$regex:category.name,$options:'i'}, hide:false };
  const total = await productModel.countDocuments(filter);
  const products = await productModel.find(filter).skip(skip).limit(l);
  sendSuccess(res, 200, 'success', { category, products, page:p, limit:l, total, totalPages:Math.ceil(total/l) });
});

export const createCategory = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const { name, description, icon, bannerText, displayOrder } = req.body;
  const slug = slugify(name);
  if (await categoryModel.findOne({ slug })) return next(new AppError('Category already exists', 409));
  let image = {};
  if (req.file) { const r = await uploadToCloudinary(req.file, 'cartify/categories'); image = { url:r.secure_url, publicId:r.public_id }; }
  const category = await categoryModel.create({ name, slug, description, icon, bannerText, image, displayOrder:displayOrder||0 });
  sendSuccess(res, 201, 'success', { category });
});

export const updateCategory = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const category = await categoryModel.findById(req.params.id);
  if (!category) return next(new AppError('Category not found', 404));
  const { name, description, icon, bannerText, displayOrder, isActive } = req.body;
  if (req.file) {
    if (category.image?.publicId) await deleteFromCloudinary(category.image.publicId);
    const r = await uploadToCloudinary(req.file, 'cartify/categories');
    category.image = { url:r.secure_url, publicId:r.public_id };
  }
  if (name!==undefined)        { category.name=name; category.slug=slugify(name); }
  if (description!==undefined) category.description=description;
  if (icon!==undefined)        category.icon=icon;
  if (bannerText!==undefined)  category.bannerText=bannerText;
  if (displayOrder!==undefined)category.displayOrder=displayOrder;
  if (isActive!==undefined)    category.isActive=isActive;
  await category.save();
  sendSuccess(res, 200, 'success', { category });
});

export const deleteCategory = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const category = await categoryModel.findById(req.params.id);
  if (!category) return next(new AppError('Category not found', 404));
  if (category.image?.publicId) await deleteFromCloudinary(category.image.publicId);
  await category.deleteOne();
  sendSuccess(res, 200, 'success', { message: 'Category deleted' });
});

export const syncProductCounts = asyncHandler(async (req, res) => {
  await connectToDB();
  const categories = await categoryModel.find();
  await Promise.all(categories.map(async (cat) => {
    const count = await productModel.countDocuments({ category:{$regex:cat.name,$options:'i'}, hide:false });
    cat.productCount = count;
    return cat.save();
  }));
  sendSuccess(res, 200, 'success', { message: 'Product counts synced' });
});
