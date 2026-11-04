import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import userModel from '../../../db/models/user.model.js';
import otpModel from '../../../db/models/otp.model.js';
import cartModel from '../../../db/models/cart.model.js';
import wishlistModel from '../../../db/models/wishlist.model.js';
import connectToDB from '../../../db/connectionDB.js';
import { AppError, asyncHandler } from '../../utils/error.js';
import { sendSuccess } from '../../utils/response.js';
import { sendEmail, generateOtpHtml } from '../../utils/email.js';
import { clearSessionCookie, getRequestSessionId } from '../../middleware/session.js';
import orderModel from '../../../db/models/order.model.js';
import returnModel from '../../../db/models/return.model.js';

const issueToken = (res, user) => {
  const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
  res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', path: '/', maxAge: 7 * 24 * 60 * 60 * 1000 });
  return token;
};

const mergeCart = async (sessionId, userId) => {
  if (!sessionId) return;
  const [sessionCart, userCart] = await Promise.all([cartModel.findOne({ sessionId }), cartModel.findOne({ userId })]);
  if (!sessionCart) return;
  if (!userCart) { sessionCart.userId = userId; sessionCart.sessionId = undefined; sessionCart.expiresAt = undefined; await sessionCart.save(); return; }
  if (!sessionCart.items.length) { await sessionCart.deleteOne(); return; }
  for (const item of sessionCart.items) {
    const existing = userCart.items.find((i) => i.productId.toString() === item.productId.toString() && i.color === item.color);
    if (existing) existing.quantity += item.quantity; else userCart.items.push({ productId: item.productId, quantity: item.quantity, color: item.color });
  }
  await userCart.save(); await sessionCart.deleteOne();
};

const mergeWishlist = async (sessionId, userId) => {
  if (!sessionId) return;
  const [sw, uw] = await Promise.all([wishlistModel.findOne({ sessionId }), wishlistModel.findOne({ userId })]);
  if (!sw) return;
  if (!uw) { sw.userId = userId; sw.sessionId = undefined; await sw.save(); return; }
  for (const item of sw.items) { if (!uw.items.find((i) => i.productId.toString() === item.productId.toString())) uw.items.push({ productId: item.productId }); }
  await uw.save(); await sw.deleteOne();
};

const mergeGuestData = async (req, res, user) => {
  const sessionId = getRequestSessionId(req);
  if (sessionId) {
    await Promise.all([
      mergeCart(sessionId, user._id),
      mergeWishlist(sessionId, user._id),
      orderModel.updateMany(
        { sessionId, userId: null },
        {
          $set: { userId: user._id },
          $unset: { sessionId: "" }
        }
      ),
      // Guest return requests follow the guest's orders into the account
      returnModel.updateMany(
        { sessionId, userId: null },
        { $set: { userId: user._id }, $unset: { sessionId: "" } }
      )]);
    clearSessionCookie(res);
  }
};

const populateUser = (id) => userModel.findById(id).populate({ path: 'orders.orderId', select: 'randomId totalPrice status createdAt' });

export const authUser = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const { email, password } = req.body;
  let user = await userModel.findOne({ email }).select('+password');
  // Admin accounts must always prove the password; email alone is not enough
  if (user?.role === 'admin') {
    const ok = typeof password === 'string' && user.password && await bcrypt.compare(password, user.password);
    if (!ok) return next(new AppError('Invalid email or password', 401));
  }
  const isNew = !user;
  if (!user) {
    user = await userModel.create({ email });
  }
  const token = issueToken(res, user);
  await mergeGuestData(req, res, user);
  sendSuccess(res, isNew ? 201 : 200, 'success', { token, user: await populateUser(user._id) });
});

// ── Email OTP login (mobile app) ──────────────────────────────────────────────
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const hashCode = (email, code) => crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${email}:${code}`).digest('hex');

export const requestOtp = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const { email } = req.body;
  const code = String(crypto.randomInt(100000, 1000000));
  await otpModel.deleteMany({ email });
  await otpModel.create({ email, codeHash: hashCode(email, code), expiresAt: new Date(Date.now() + OTP_TTL_MS) });

  const sent = await sendEmail(email, 'Your Cartify sign-in code', generateOtpHtml(code));
  if (!sent) {
    if (process.env.NODE_ENV === 'production') return next(new AppError('Could not send the code. Please try again.', 502));
    console.log(`🔑  [dev] OTP for ${email}: ${code}`);
  }
  sendSuccess(res, 200, 'success', { message: 'Code sent', expiresInSeconds: OTP_TTL_MS / 1000 });
});

export const verifyOtp = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const { email, code } = req.body;
  const otp = await otpModel.findOne({ email });
  if (!otp || otp.expiresAt < new Date()) return next(new AppError('Code expired. Please request a new one.', 400));
  if (otp.attempts >= OTP_MAX_ATTEMPTS) {
    await otp.deleteOne();
    return next(new AppError('Too many attempts. Please request a new code.', 429));
  }
  const expected = Buffer.from(otp.codeHash);
  const provided = Buffer.from(hashCode(email, String(code)));
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    otp.attempts += 1;
    await otp.save();
    return next(new AppError('Incorrect code', 400));
  }
  await otp.deleteOne();

  let user = await userModel.findOne({ email });
  const isNew = !user;
  if (!user) user = await userModel.create({ email, isVerified: true });
  else if (!user.isVerified) { user.isVerified = true; await user.save(); }

  const token = issueToken(res, user);
  await mergeGuestData(req, res, user);
  sendSuccess(res, isNew ? 201 : 200, 'success', { token, isNew, user: await populateUser(user._id) });
});

export const logoutUser = asyncHandler(async (req, res) => {
  res.clearCookie('token', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', path: '/' });
  sendSuccess(res, 200, 'success', { message: 'Logged out successfully' });
});

export const getMyProfile = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const user = await userModel.findById(req.user._id).populate({ path: 'orders.orderId', populate: { path: 'products.productId', select: 'name variants price' } });
  if (!user) return next(new AppError('User not found', 404));
  sendSuccess(res, 200, 'success', { user });
});

export const updateMyProfile = asyncHandler(async (req, res) => {
  await connectToDB();
  const allowed = ['firstName', 'lastName', 'phone', 'address', 'city', 'governorate'];
  const updates = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  const user = await userModel.findByIdAndUpdate(req.user._id, updates, { new: true, runValidators: true });
  sendSuccess(res, 200, 'success', { user });
});

export const getAllUsers = asyncHandler(async (req, res) => {
  await connectToDB();
  const { page = 1, limit = 20, search } = req.query;
  const p = Math.max(parseInt(page) || 1, 1); const l = Math.min(parseInt(limit) || 20, 100); const skip = (p - 1) * l;
  const filter = {};
  if (search) filter.$or = [{ email: { $regex: search, $options: 'i' } }, { firstName: { $regex: search, $options: 'i' } }, { lastName: { $regex: search, $options: 'i' } }];
  const total = await userModel.countDocuments(filter);
  const users = await userModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(l);
  sendSuccess(res, 200, 'success', { page: p, limit: l, total, totalPages: Math.ceil(total / l), users });
});

export const getUserById = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const user = await userModel.findById(req.params.id).populate('orders.orderId');
  if (!user) return next(new AppError('User not found', 404));
  sendSuccess(res, 200, 'success', { user });
});

export const updateUserById = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const allowed = ['firstName', 'lastName', 'phone', 'address', 'city', 'governorate', 'email', 'role'];
  const updates = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  const user = await userModel.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
  if (!user) return next(new AppError('User not found', 404));
  sendSuccess(res, 200, 'success', { user });
});
