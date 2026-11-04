import wishlistModel from '../../../db/models/wishlist.model.js';
import productModel   from '../../../db/models/product.model.js';
import connectToDB    from '../../../db/connectionDB.js';
import { AppError, asyncHandler } from '../../utils/error.js';
import { sendSuccess } from '../../utils/response.js';

const wishQuery = (req) => req.user ? { userId: req.user._id } : { sessionId: req.sessionId };

const assertIdentity = (req, next) => {
  if (!req.user && !req.sessionId) { next(new AppError('Session or user not found', 400)); return false; }
  return true;
};

const findOrCreateWishlist = async (req) => {
  let w = await wishlistModel.findOne(wishQuery(req));
  if (!w) w = await wishlistModel.create({ ...wishQuery(req), items:[] });
  return w;
};

const POPULATE = { path:'items.productId', select:'name price discount raise category brand variants rating slug' };

export const getWishlist = asyncHandler(async (req, res, next) => {
  await connectToDB();
  if (!assertIdentity(req, next)) return;
  const wishlist = await wishlistModel.findOne(wishQuery(req)).populate(POPULATE);
  sendSuccess(res, 200, 'success', { wishList: wishlist ?? { items:[] } });
});

export const toggleWishlist = asyncHandler(async (req, res, next) => {
  await connectToDB();
  if (!assertIdentity(req, next)) return;
  const { productId } = req.body;
  const product = await productModel.findById(productId);
  if (!product||product.hide) return next(new AppError('Product not found', 404));
  const wishlist = await findOrCreateWishlist(req);
  const idx = wishlist.items.findIndex((i) => i.productId.toString()===productId.toString());
  let added, msg;
  if (idx===-1) { wishlist.items.push({ productId, addedAt:new Date() }); added=true; msg='Item added to wishlist'; }
  else          { wishlist.items.splice(idx,1); added=false; msg='Item removed from wishlist'; }
  await wishlist.save();
  await wishlist.populate(POPULATE);
  sendSuccess(res, 200, msg, { added, wishList: wishlist });
});

export const emptyWishlist = asyncHandler(async (req, res, next) => {
  await connectToDB();
  if (!assertIdentity(req, next)) return;
  const wishlist = await wishlistModel.findOne(wishQuery(req));
  if (!wishlist||!wishlist.items.length) return sendSuccess(res, 200, 'Already empty', { wishList:{ items:[] } });
  wishlist.items = [];
  await wishlist.save();
  sendSuccess(res, 200, 'success', { wishList: wishlist });
});

export const removeFromWishlist = asyncHandler(async (req, res, next) => {
  await connectToDB();
  if (!assertIdentity(req, next)) return;
  const { productId } = req.params;
  const wishlist = await wishlistModel.findOne(wishQuery(req));
  if (!wishlist) return next(new AppError('Wishlist not found', 404));
  const before = wishlist.items.length;
  wishlist.items = wishlist.items.filter((i) => i.productId.toString()!==productId);
  if (wishlist.items.length===before) return next(new AppError('Item not found in wishlist', 404));
  await wishlist.save();
  await wishlist.populate(POPULATE);
  sendSuccess(res, 200, 'success', { wishList: wishlist });
});
