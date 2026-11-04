import crypto from 'crypto';
import { AppError } from '../utils/error.js';

export const deviceAuth = (req, res, next) => {
  const apiKey = req.headers['x-device-key'];
  const boxId = req.headers['x-box-id'];

  if (!apiKey) return next(new AppError('Missing X-Device-Key header', 401));
  if (!boxId || !boxId.trim()) return next(new AppError('Missing or invalid X-Box-Id header', 401));

  const validKey = process.env.DEVICE_API_KEY;
  if (!validKey) {
    console.error('[deviceAuth] DEVICE_API_KEY is not set in environment');
    return next(new AppError('Server configuration error', 500));
  }

  const provided = Buffer.from(apiKey);
  const expected = Buffer.from(validKey);
  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(provided, expected)
  ) {
    return next(new AppError('Invalid device API key', 403));
  }

  req.boxId = boxId.trim();
  next();
};
