import jwt from 'jsonwebtoken';
import userModel from '../../db/models/user.model.js';
import { AppError, asyncHandler } from '../utils/error.js';

export const protectRoute = asyncHandler(async (req, res, next) => {
  // Bearer header first (mobile app), cookie second (web)
  const token = req.headers.authorization?.split(' ')[1] || req.cookies?.token;
  if (!token) { req.user = null; return next(); }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await userModel.findById(decoded.id).select('-password -refreshToken') || null;
  } catch { req.user = null; }
  next();
});

export const requireAuth = (req, res, next) => {
  if (!req.user) return next(new AppError('Authentication required. Please login.', 401));
  next();
};

export const adminOnly = (req, res, next) => {
  if (!req.user)                  return next(new AppError('Authentication required.', 401));
  if (req.user.role !== 'admin')  return next(new AppError('Admin access required.', 403));
  next();
};
