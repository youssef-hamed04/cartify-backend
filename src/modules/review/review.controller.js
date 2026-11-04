import reviewModel  from '../../../db/models/review.model.js';
import productModel  from '../../../db/models/product.model.js';
import orderModel    from '../../../db/models/order.model.js';
import connectToDB   from '../../../db/connectionDB.js';
import { AppError, asyncHandler } from '../../utils/error.js';
import { sendSuccess } from '../../utils/response.js';

const updateProductRating = async (productId) => {
  const stats = await reviewModel.aggregate([{ $match:{ productId } },{ $group:{ _id:'$productId', avg:{ $avg:'$rating' }, count:{ $sum:1 } } }]);
  const { avg=0, count=0 } = stats[0] || {};
  await productModel.findByIdAndUpdate(productId, { 'rating.average':+avg.toFixed(1), 'rating.count':count });
};

export const createReview = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const { productId, rating, title, body, orderId } = req.body;
  const product = await productModel.findById(productId);
  if (!product) return next(new AppError('Product not found', 404));
  const existing = await reviewModel.findOne({ productId, userId:req.user._id });
  if (existing) return next(new AppError('You have already reviewed this product', 409));
  let isVerifiedPurchase = false;
  if (orderId) {
    const order = await orderModel.findOne({ _id:orderId, userId:req.user._id, 'products.productId':productId, status:'delivered' });
    isVerifiedPurchase = !!order;
  }
  const review = await reviewModel.create({ productId, userId:req.user._id, orderId, rating, title, body, isVerifiedPurchase });
  await updateProductRating(product._id);
  await review.populate('userId','firstName lastName avatar');
  sendSuccess(res, 201, 'success', { review });
});

export const updateReview = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const review = await reviewModel.findById(req.params.id);
  if (!review) return next(new AppError('Review not found', 404));
  if (review.userId.toString()!==req.user._id.toString() && req.user.role!=='admin') return next(new AppError('Not authorized to edit this review', 403));
  const { rating, title, body } = req.body;
  if (rating!==undefined) review.rating = rating;
  if (title!==undefined)  review.title  = title;
  if (body!==undefined)   review.body   = body;
  await review.save();
  await updateProductRating(review.productId);
  await review.populate('userId','firstName lastName avatar');
  sendSuccess(res, 200, 'success', { review });
});

export const deleteReview = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const review = await reviewModel.findById(req.params.id);
  if (!review) return next(new AppError('Review not found', 404));
  if (review.userId.toString()!==req.user._id.toString() && req.user.role!=='admin') return next(new AppError('Not authorized to delete this review', 403));
  const { productId } = review;
  await review.deleteOne();
  await updateProductRating(productId);
  sendSuccess(res, 200, 'success', { message: 'Review deleted' });
});
