import rateLimit from 'express-rate-limit';

const byBox = (req) => req.headers['x-box-id'] || req.ip;

// /camera/upload — allow 5 image captures per box per minute
export const imageUploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: byBox,
  message: { msg: 'error', err: 'Upload rate limit exceeded for this device' },
  standardHeaders: true,
  legacyHeaders: false,
});
