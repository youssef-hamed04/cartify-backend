import returnModel from '../../../db/models/return.model.js';
import connectToDB from '../../../db/connectionDB.js';
import { AppError, asyncHandler } from '../../utils/error.js';
import { sendSuccess } from '../../utils/response.js';
import { generateLockerCode, generateLockerUserId } from '../../utils/lockerCode.js';
import orderModel from '../../../db/models/order.model.js';

/** Return requests are valid for 48 hours */
const CODE_TTL_MS = 48 * 60 * 60 * 1000;

// ── POST /returns ─────────────────────────────────────────────────────────────
export const createReturn = asyncHandler(async (req, res) => {
  await connectToDB();
  const { orderId, reason, notes, items } = req.body;

  // Generate a unique 6-digit lockerUserId — retry once on the rare collision
  let lockerUserId = generateLockerUserId();
  if (await returnModel.findOne({ lockerUserId, status: 'pending' })) {
    lockerUserId = generateLockerUserId();
  }


  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  const existingReturn = await returnModel.findOne({
    orderId,
    status: 'pending',
  });
  if (existingReturn) {
    existingReturn.items.push(...items);

    await existingReturn.save();
    const unlockCode = generateLockerCode(existingReturn.lockerUserId);

    const ord = await orderModel.findById(orderId);

    if (ord) {
      ord.products.forEach(product => {
        if (product.productId.toString() === items[0].productId.toString()) {
          product.isRefundRequested = true;
        }
      });
      await ord.save();
    }
    return sendSuccess(res, 200, 'already exists', {
      returnRequest: {
        ...existingReturn.toObject(),
        unlockCode
      }
    });
  }
  // Generate today's unlock code to return to the client
  // (regenerated fresh each call — daily rotation is automatic)
  const unlockCode = generateLockerCode(lockerUserId);

  const returnRequest = await returnModel.create({
    userId: req.user?._id || null,
    sessionId: req.sessionId || null,
    orderId: orderId || null,
    items,
    unlockCode,
    reason,
    notes: notes || '',
    lockerUserId,
    codeGeneratedAt: new Date(),
    expiresAt,
    status: 'pending',
  });

  const ord = await orderModel.findById(orderId);

  if (ord) {
    ord.products.forEach(product => {
      if (product.productId.toString() === items[0].productId.toString()) {
        product.isRefundRequested = true;
      }
    });
    await ord.save();
  }


  sendSuccess(res, 201, 'success', {
    returnRequest: {
      ...returnRequest.toObject(),
      unlockCode,    // 4-digit code for display; NOT persisted
    },
  });
});

// ── GET /returns/my ───────────────────────────────────────────────────────────
export const getMyReturns = asyncHandler(async (req, res) => {
  await connectToDB();
  const filter = req.user ? { userId: req.user._id } : { sessionId: req.sessionId };
  const { page = 1, limit = 10 } = req.query;
  const p = Math.max(parseInt(page) || 1, 1);
  const l = Math.min(parseInt(limit) || 10, 50);
  const skip = (p - 1) * l;

  const total = await returnModel.countDocuments(filter);
  const returns = await returnModel
    .find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(l)
    .populate('orderId', 'randomId totalPrice');

  // Attach a fresh unlock code to each pending return
  const returnsWithCode = returns.map(r => {
    const obj = r.toObject();
    if (r.status === 'pending' && new Date() < r.expiresAt) {
      obj.unlockCode = generateLockerCode(r.lockerUserId);
    }
    return obj;
  });

  sendSuccess(res, 200, 'success', {
    page: p, limit: l, total, totalPages: Math.ceil(total / l),
    returns: returnsWithCode,
  });
});

// ── GET /returns/:id ──────────────────────────────────────────────────────────
export const getReturnById = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const returnRequest = await returnModel
    .findById(req.params.id)
    .populate('orderId', 'randomId totalPrice status');

  if (!returnRequest) return next(new AppError('Return request not found', 404));

  if (req.user?.role !== 'admin') {
    const isOwner =
      (req.user && returnRequest.userId?.toString() === req.user._id.toString()) ||
      (req.sessionId && returnRequest.sessionId === req.sessionId);
    if (!isOwner) return next(new AppError('Access denied', 403));
  }

  const obj = returnRequest.toObject();
  if (returnRequest.status === 'pending' && new Date() < returnRequest.expiresAt) {
    obj.unlockCode = generateLockerCode(returnRequest.lockerUserId);
  }

  sendSuccess(res, 200, 'success', { returnRequest: obj });
});

// ── GET /returns (admin) ──────────────────────────────────────────────────────
export const getAllReturns = asyncHandler(async (req, res) => {
  await connectToDB();
  const { page = 1, limit = 20, status, search } = req.query;
  const p = Math.max(parseInt(page) || 1, 1);
  const l = Math.min(parseInt(limit) || 20, 100);
  const skip = (p - 1) * l;

  const filter = {};
  if (status) filter.status = status;
  if (search) {
    const re = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { lockerUserId: { $regex: re, $options: 'i' } },
      { reason: { $regex: re, $options: 'i' } },
    ];
  }

  const total = await returnModel.countDocuments(filter);
  const returns = await returnModel
    .find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(l)
    .populate('userId', 'firstName lastName email')
    .populate('orderId', 'randomId totalPrice');

  sendSuccess(res, 200, 'success', {
    page: p, limit: l, total, totalPages: Math.ceil(total / l), returns,
  });
});

// ── POST /returns/validate-code (used by locker hardware validation endpoint) ─
export const validateReturnCode = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const { lockerUserId, unlockCode } = req.body;
  if (!lockerUserId || !unlockCode) {
    return next(new AppError('lockerUserId and unlockCode are required', 400));
  }

  const returnRequest = await returnModel.findOne({ lockerUserId });
  if (!returnRequest) return sendSuccess(res, 200, 'success', { action: 'deny' });
  if (new Date() > returnRequest.expiresAt) return sendSuccess(res, 200, 'success', { action: 'expired' });
  if (returnRequest.status !== 'pending') return sendSuccess(res, 200, 'success', { action: 'used' });

  // Validate code (today + yesterday fallback)
  const { validateLockerCode } = await import('../../utils/lockerCode.js');
  const valid = validateLockerCode(lockerUserId, String(unlockCode));
  if (!valid) return sendSuccess(res, 200, 'success', { action: 'deny' });

  // Mark completed
  returnRequest.status = 'completed';
  returnRequest.completedAt = new Date();
  await returnRequest.save();

  sendSuccess(res, 200, 'success', { action: 'open' });
});

// ── PATCH /returns/:id (admin — manual status override) ───────────────────────
export const updateReturn = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const returnRequest = await returnModel.findById(req.params.id);
  if (!returnRequest) return next(new AppError('Return request not found', 404));

  const { status } = req.body;
  const ALLOWED = ['pending', 'completed', 'expired', 'denied'];
  if (!ALLOWED.includes(status))
    return next(new AppError(`Status must be one of: ${ALLOWED.join(', ')}`, 400));

  returnRequest.status = status;
  if (status === 'completed' && !returnRequest.completedAt) {
    returnRequest.completedAt = new Date();
  }
  await returnRequest.save();
  sendSuccess(res, 200, 'success', { returnRequest });
});
