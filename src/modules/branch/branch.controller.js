import branchModel from '../../../db/models/branch.model.js';
import branchInventoryModel from '../../../db/models/branchInventory.model.js';
import connectToDB from '../../../db/connectionDB.js';
import { AppError, asyncHandler } from '../../utils/error.js';
import { sendSuccess } from '../../utils/response.js';

const EDITABLE = ['code', 'name', 'address', 'city', 'location', 'status'];
const pick = (body) => Object.fromEntries(EDITABLE.filter((f) => body[f] !== undefined).map((f) => [f, body[f]]));

// GET /branches?status=active
export const getBranches = asyncHandler(async (req, res) => {
  await connectToDB();
  const filter = req.query.status ? { status: req.query.status } : {};
  const branches = await branchModel.find(filter).sort({ name: 1 }).lean();
  const stock = await branchInventoryModel.aggregate([
    { $group: { _id: '$branchId', skus: { $sum: 1 }, units: { $sum: '$quantity' }, reserved: { $sum: '$reserved' } } },
  ]);
  const byId = new Map(stock.map((s) => [String(s._id), s]));
  sendSuccess(res, 200, 'success', {
    branches: branches.map((b) => ({ ...b, stock: { skus: byId.get(String(b._id))?.skus || 0, units: byId.get(String(b._id))?.units || 0, reserved: byId.get(String(b._id))?.reserved || 0 } })),
  });
});

export const getBranchById = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const branch = await branchModel.findById(req.params.id).lean();
  if (!branch) return next(new AppError('Branch not found', 404));
  sendSuccess(res, 200, 'success', { branch });
});

export const createBranch = asyncHandler(async (req, res) => {
  await connectToDB();
  const branch = await branchModel.create(pick(req.body));
  console.log(`[branch] ${req.user.email} created branch ${branch.code}`);
  sendSuccess(res, 201, 'success', { branch });
});

export const updateBranch = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const branch = await branchModel.findByIdAndUpdate(req.params.id, pick(req.body), { new: true, runValidators: true });
  if (!branch) return next(new AppError('Branch not found', 404));
  console.log(`[branch] ${req.user.email} updated branch ${branch.code}`);
  sendSuccess(res, 200, 'success', { branch });
});
