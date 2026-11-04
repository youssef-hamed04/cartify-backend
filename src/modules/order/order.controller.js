import orderModel from '../../../db/models/order.model.js';
import cartModel from '../../../db/models/cart.model.js';
import productModel from '../../../db/models/product.model.js';
import userModel from '../../../db/models/user.model.js';
import connectToDB from '../../../db/connectionDB.js';
import { AppError, asyncHandler } from '../../utils/error.js';
import { sendSuccess } from '../../utils/response.js';
import { calculateShipping, getShippingRates } from '../../utils/shipping.js';
import { nextSequence, generateRandomCode } from '../../utils/counter.js';
import { sendEmail, generateOrderConfirmationHtml } from '../../utils/email.js';

const finalPrice = (p) => { const d = (p.price * (p.discount || 0)) / 100; const r = (p.price * (p.raise || 0)) / 100; return +(p.price - d + r).toFixed(2); };

export const getOrders = asyncHandler(async (req, res) => {
  await connectToDB();
  const { page = 1, limit = 10, status, sort, search } = req.query;
  const filter = {};
  let raw = String(search || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (raw) { filter.$or = [{ randomId: { $regex: raw, $options: 'i' } }, { firstName: { $regex: raw, $options: 'i' } }, { lastName: { $regex: raw, $options: 'i' } }, { email: { $regex: raw, $options: 'i' } }, { phone: { $regex: raw, $options: 'i' } }]; if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) filter.$or.push({ createdAt: { $gte: new Date(`${raw}T00:00:00`), $lte: new Date(`${raw}T23:59:59`) } }); }
  if (status) filter.status = status;
  const sortQuery = sort === 'oldest' ? { createdAt: 1 } : { createdAt: -1 };
  const p = Math.max(parseInt(page) || 1, 1); const l = Math.min(parseInt(limit) || 10, 100); const skip = (p - 1) * l;
  const total = await orderModel.countDocuments(filter);
  const orders = await orderModel.find(filter).sort(sortQuery).skip(skip).limit(l).populate({ path: 'products.productId', select: 'name price variants' });
  sendSuccess(res, 200, 'success', { page: p, limit: l, total, totalPages: Math.ceil(total / l), orders });
});

export const getMyOrders = asyncHandler(async (req, res) => {
  await connectToDB();
  const { page = 1, limit = 10 } = req.query;
  const p = Math.max(parseInt(page) || 1, 1); const l = Math.min(parseInt(limit) || 10, 50); const skip = (p - 1) * l;
  const filter = req.user ? { userId: req.user._id } : { sessionId: req.sessionId };
  const total = await orderModel.countDocuments(filter);
  const orders = await orderModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(l).populate({ path: 'products.productId', select: 'name variants' });
  sendSuccess(res, 200, 'success', { page: p, limit: l, total, totalPages: Math.ceil(total / l), orders });
});

export const getShippingRatesEndpoint = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'success', { shippingRates: getShippingRates() });
});

export const getOrderById = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const order = await orderModel.findById(req.params.id).populate({ path: 'products.productId', select: 'name variants price' });
  if (!order) return next(new AppError('Order not found', 404));
  if (req.user?.role !== 'admin') {
    const isOwner = (req.user && order.userId?.toString() === req.user._id.toString()) || (req.sessionId && order.sessionId === req.sessionId);
    if (!isOwner) return next(new AppError('Access denied', 403));
  }
  sendSuccess(res, 200, 'success', { order });
});

export const createOrder = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const sessionId = req.user ? null : req.sessionId;
  const userId = req.user?._id || null;
  const { email, firstName, lastName, address, phone, city, governorate, paymentMethod = 'cash', notes } = req.body;
  const cartQuery = userId ? { userId } : { sessionId };
  const cart = await cartModel.findOne(cartQuery).populate('items.productId', '-__v -hide');
  if (!cart || !cart.items.length) return next(new AppError('Cart is empty or not found', 400));

  const orderItems = [];
  const modifiedProducts = new Map();
  for (const item of cart.items) {
    const product = item.productId;
    if (!product) return next(new AppError('A product in your cart is no longer available', 400));
    const variant = product.variants.find((v) => v.color.toLowerCase() === item.color.toLowerCase());
    if (!variant) return next(new AppError(`Color "${item.color}" not available for "${product.name}"`, 400));
    if (variant.stock < item.quantity) return next(new AppError(`Insufficient stock for "${product.name}" (${item.color})`, 400));
    variant.stock = Math.max(0, variant.stock - item.quantity);
    variant.reserved = Math.max(0, variant.reserved - item.quantity);
    modifiedProducts.set(product._id.toString(), product);
    orderItems.push({ productId: product._id, name: product.name, color: item.color, imageUrl: variant.images?.[0]?.url || '', quantity: item.quantity, unitPrice: finalPrice(product) });
  }
  await Promise.all([...modifiedProducts.values()].map((p) => p.save()));

  const subtotal = orderItems.reduce((a, i) => a + i.unitPrice * i.quantity, 0);
  const shippingCost = calculateShipping(governorate);
  const totalPrice = +(subtotal + shippingCost).toFixed(2);
  const orderNumber = await nextSequence('order');
  const randomId = generateRandomCode(6);

  const order = await orderModel.create({ sessionId, userId, orderNumber, randomId, products: orderItems, subtotal: +subtotal.toFixed(2), shippingCost, totalPrice, email, firstName, lastName, address, phone, city, governorate, paymentMethod, notes: notes || '', statusHistory: [{ status: 'placed' }] });
  cart.items = [];
  await cart.save();

  const userRecord = await userModel.findOne({ email });
  if (userRecord) {
    if (firstName) userRecord.firstName = firstName;
    if (lastName) userRecord.lastName = lastName;
    if (address) userRecord.address = address;
    if (phone) userRecord.phone = phone;
    if (city) userRecord.city = city;
    if (governorate) userRecord.governorate = governorate;
    userRecord.orders.push({ orderId: order._id });
    userRecord.totalSpent = (userRecord.totalSpent || 0) + totalPrice;
    await userRecord.save();
  } else {
    await userModel.create({ email, firstName, lastName, address, phone, city, governorate, orders: [{ orderId: order._id }], totalSpent: totalPrice });
  }


  sendEmail(email, `Order #${randomId} Confirmed — Cartify`, generateOrderConfirmationHtml(order)).catch(() => { });
  await order.populate({ path: 'products.productId', select: 'name variants' });
  sendSuccess(res, 201, 'success', { order });
});

export const updateOrder = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const order = await orderModel.findById(req.params.id);
  if (!order) return next(new AppError('Order not found', 404));
  const { status, email, firstName, lastName, address, phone, city, governorate, trackingNumber, notes } = req.body;
  if (email) order.email = email;
  if (firstName) order.firstName = firstName;
  if (lastName) order.lastName = lastName;
  if (address) order.address = address;
  if (phone) order.phone = phone;
  if (city) order.city = city;
  if (governorate) order.governorate = governorate;
  if (trackingNumber) order.trackingNumber = trackingNumber;
  if (notes) order.notes = notes;
  if (status && status !== order.status) { order.status = status; order.statusHistory.push({ status, changedAt: new Date() }); if (status === 'delivered') { order.isPaid = true; order.paidAt = new Date(); } }
  await order.save();
  if (order.userId) {
    const user = await userModel.findById(order.userId);
    if (user) { if (email) user.email = email; if (firstName) user.firstName = firstName; if (lastName) user.lastName = lastName; if (address) user.address = address; if (phone) user.phone = phone; if (city) user.city = city; if (governorate) user.governorate = governorate; await user.save(); }
  }
  await order.populate({ path: 'products.productId', select: 'name variants' });
  sendSuccess(res, 200, 'success', { order });
});

export const cancelOrder = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const order = await orderModel.findById(req.params.id);
  if (!order) return next(new AppError('Order not found', 404));
  if (['delivered', 'cancelled'].includes(order.status)) return next(new AppError(`Cannot cancel an order that is already ${order.status}`, 400));
  const productIds = [...new Set(order.products.map((i) => i.productId.toString()))];
  const products = await productModel.find({ _id: { $in: productIds } });
  const productMap = Object.fromEntries(products.map((p) => [p._id.toString(), p]));
  for (const item of order.products) {
    const product = productMap[item.productId.toString()];
    if (!product) continue;
    const variant = product.variants.find((v) => v.color.toLowerCase() === item.color.toLowerCase());
    if (variant) variant.stock += item.quantity;
  }
  await Promise.all(products.map((p) => p.save()));
  order.status = 'cancelled';
  order.statusHistory.push({ status: 'cancelled', changedAt: new Date() });
  await order.save();
  sendSuccess(res, 200, 'success', { order });
});
