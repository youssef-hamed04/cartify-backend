import cartModel    from '../../../db/models/cart.model.js';
import productModel  from '../../../db/models/product.model.js';
import connectToDB   from '../../../db/connectionDB.js';
import { AppError, asyncHandler } from '../../utils/error.js';
import { sendSuccess } from '../../utils/response.js';

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const cartQuery   = (req) => req.user ? { userId: req.user._id } : { sessionId: req.sessionId };
const finalPrice  = (p)   => { const d=(p.price*(p.discount||0))/100; const r=(p.price*(p.raise||0))/100; return +(p.price-d+r).toFixed(2); };

const findOrCreateCart = async (req) => {
  let cart = await cartModel.findOne(cartQuery(req)).populate('items.productId');
  if (!cart) { cart = new cartModel({ ...cartQuery(req), items:[], ...(req.sessionId&&!req.user?{expiresAt:new Date(Date.now()+SEVEN_DAYS)}:{}) }); await cart.save(); }
  return cart;
};

const computeTotals = (cart) => {
  const valid = cart.items.filter((i) => i.productId);
  return { subtotal: +valid.reduce((a,i) => a+finalPrice(i.productId)*i.quantity, 0).toFixed(2), totalQuantity: valid.reduce((a,i)=>a+i.quantity,0) };
};

export const getCart = asyncHandler(async (req, res) => {
  await connectToDB();
  const cart = await findOrCreateCart(req);
  const before = cart.items.length;
  cart.items = cart.items.filter((i) => i.productId);
  if (cart.items.length !== before) await cart.save();
  const { subtotal, totalQuantity } = computeTotals(cart);
  sendSuccess(res, 200, 'success', { cart, subtotal, totalQuantity });
});

export const getCartQuantity = asyncHandler(async (req, res) => {
  await connectToDB();
  const cart = await cartModel.findOne(cartQuery(req));
  sendSuccess(res, 200, 'success', { totalQuantity: cart ? cart.items.reduce((a,i)=>a+i.quantity,0) : 0 });
});

export const addToCart = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const { productId, color, quantity=1 } = req.body;
  const qty = parseInt(quantity,10)||1;
  const product = await productModel.findById(productId);
  if (!product||product.hide) return next(new AppError('Product not found', 404));
  const variant = product.variants.find((v) => v.color.toLowerCase()===color.toLowerCase());
  if (!variant) return next(new AppError('Selected color not available for this product', 400));
  const available = variant.stock - variant.reserved;
  if (available < qty) return sendSuccess(res, 200, 'success', { stockLimitReached:true, available, msg:'Not enough stock available' });
  const cart = await findOrCreateCart(req);
  const existingIdx = cart.items.findIndex((item) => { const pid=item.productId?._id?.toString()??item.productId?.toString(); return pid===productId.toString()&&item.color.toLowerCase()===color.toLowerCase(); });
  if (existingIdx > -1) {
    if (qty > available) return sendSuccess(res, 200, 'success', { stockLimitReached:true, available, msg:'Not enough stock available' });
    cart.items[existingIdx].quantity += qty;
  } else {
    cart.items.push({ productId, quantity:qty, color, priceSnapshot:finalPrice(product) });
  }
  variant.reserved += qty;
  await Promise.all([cart.save(), product.save()]);
  await cart.populate('items.productId');
  const { subtotal, totalQuantity } = computeTotals(cart);
  sendSuccess(res, 200, 'success', { cart, subtotal, totalQuantity });
});

export const addQuantity = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const { productId, color } = req.body;
  const [cart, product] = await Promise.all([cartModel.findOne(cartQuery(req)), productModel.findById(productId)]);
  if (!cart)    return next(new AppError('Cart not found', 404));
  if (!product) return next(new AppError('Product not found', 404));
  const itemIdx = cart.items.findIndex((i) => i.productId.toString()===productId.toString()&&i.color.toLowerCase()===color.toLowerCase());
  if (itemIdx===-1) return next(new AppError('Item not found in cart', 404));
  const variant = product.variants.find((v) => v.color.toLowerCase()===color.toLowerCase());
  if (!variant) return next(new AppError('Color variant not found', 400));
  if (variant.stock-variant.reserved < 1) return sendSuccess(res, 200, 'success', { stockLimitReached:true, available:0, msg:'No more stock available' });
  cart.items[itemIdx].quantity += 1; variant.reserved += 1;
  await Promise.all([cart.save(), product.save()]);
  await cart.populate('items.productId');
  sendSuccess(res, 200, 'success', { cart, ...computeTotals(cart) });
});

export const reduceQuantity = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const { productId, color } = req.body;
  const [cart, product] = await Promise.all([cartModel.findOne(cartQuery(req)), productModel.findById(productId)]);
  if (!cart)    return next(new AppError('Cart not found', 404));
  if (!product) return next(new AppError('Product not found', 404));
  const itemIdx = cart.items.findIndex((i) => i.productId.toString()===productId.toString()&&i.color.toLowerCase()===color.toLowerCase());
  if (itemIdx===-1) return next(new AppError('Item not found in cart', 404));
  const variant = product.variants.find((v) => v.color.toLowerCase()===color.toLowerCase());
  if (variant) { variant.reserved = Math.max(0, variant.reserved-1); await product.save(); }
  cart.items[itemIdx].quantity -= 1;
  if (cart.items[itemIdx].quantity <= 0) cart.items.splice(itemIdx, 1);
  await cart.save();
  await cart.populate('items.productId');
  sendSuccess(res, 200, 'success', { cart, ...computeTotals(cart) });
});

export const removeItem = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const { productId, color } = req.body;
  const cart = await cartModel.findOne(cartQuery(req));
  if (!cart) return next(new AppError('Cart not found', 404));
  const itemIdx = cart.items.findIndex((i) => i.productId.toString()===productId.toString()&&i.color.toLowerCase()===color.toLowerCase());
  if (itemIdx===-1) return next(new AppError('Item not found in cart', 404));
  const removedQty = cart.items[itemIdx].quantity;
  cart.items.splice(itemIdx, 1);
  await cart.save();
  const product = await productModel.findById(productId);
  if (product) { const variant=product.variants.find((v)=>v.color.toLowerCase()===color.toLowerCase()); if (variant) { variant.reserved=Math.max(0,variant.reserved-removedQty); await product.save(); } }
  await cart.populate('items.productId');
  sendSuccess(res, 200, 'success', { cart, ...computeTotals(cart) });
});

export const emptyCart = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const cart = await cartModel.findOne(cartQuery(req));
  if (!cart) return next(new AppError('Cart not found', 404));
  if (!cart.items.length) return sendSuccess(res, 200, 'success', { cart, subtotal:0, totalQuantity:0 });
  const productIds = [...new Set(cart.items.map((i) => i.productId.toString()))];
  const products   = await productModel.find({ _id:{ $in:productIds } });
  const productMap = Object.fromEntries(products.map((p) => [p._id.toString(), p]));
  for (const item of cart.items) {
    const product = productMap[item.productId.toString()];
    if (!product) continue;
    const variant = product.variants.find((v) => v.color.toLowerCase()===item.color.toLowerCase());
    if (variant) variant.reserved = Math.max(0, variant.reserved-item.quantity);
  }
  await Promise.all(products.map((p) => p.save()));
  cart.items = [];
  await cart.save();
  sendSuccess(res, 200, 'success', { cart, subtotal:0, totalQuantity:0 });
});

export const getAllCarts = asyncHandler(async (req, res) => {
  await connectToDB();
  const { page=1, limit=20 } = req.query;
  const p=Math.max(parseInt(page)||1,1); const l=Math.min(parseInt(limit)||20,100); const skip=(p-1)*l;
  const total = await cartModel.countDocuments();
  const carts = await cartModel.find().populate('items.productId','name price variants category brand').sort({ updatedAt:-1 }).skip(skip).limit(l);
  sendSuccess(res, 200, 'success', { page:p, limit:l, total, totalPages:Math.ceil(total/l), carts });
});
