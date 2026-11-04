import lockerModel from '../../../db/models/locker.model.js';
import connectToDB from '../../../db/connectionDB.js';
import { AppError, asyncHandler } from '../../utils/error.js';
import { sendSuccess } from '../../utils/response.js';

const EDITABLE = ['boxId', 'name', 'address', 'city', 'location', 'status', 'hours', 'freeSlots', 'isActive'];
const pick = (body) => Object.fromEntries(EDITABLE.filter((f) => body[f] !== undefined).map((f) => [f, body[f]]));

// ── GET /lockers ──────────────────────────────────────────────────────────────
export const getLockers = asyncHandler(async (req, res) => {
  await connectToDB();
  const filter = req.user?.role === 'admin' && req.query.all === 'true' ? {} : { isActive: true };
  const lockers = await lockerModel.find(filter).sort({ name: 1 });
  sendSuccess(res, 200, 'success', { lockers });
});

export const getLockerById = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const locker = await lockerModel.findById(req.params.id);
  if (!locker) return next(new AppError('Locker not found', 404));
  sendSuccess(res, 200, 'success', { locker });
});

// ── Admin ─────────────────────────────────────────────────────────────────────
export const createLocker = asyncHandler(async (req, res) => {
  await connectToDB();
  const locker = await lockerModel.create(pick(req.body));
  sendSuccess(res, 201, 'success', { locker });
});

export const updateLocker = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const locker = await lockerModel.findByIdAndUpdate(req.params.id, pick(req.body), { new: true, runValidators: true });
  if (!locker) return next(new AppError('Locker not found', 404));
  sendSuccess(res, 200, 'success', { locker });
});

export const deleteLocker = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const locker = await lockerModel.findByIdAndDelete(req.params.id);
  if (!locker) return next(new AppError('Locker not found', 404));
  sendSuccess(res, 200, 'success', { message: 'Locker deleted' });
});
