import multer from 'multer';
import path from 'path';
import { mkdirSync } from 'fs';
import { nanoid } from 'nanoid';
import { AppError } from '../utils/error.js';

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

if (process.env.NODE_ENV !== 'production') {
  try { mkdirSync(path.resolve('uploads'), { recursive: true }); } catch { /* exists */ }
}

const fileFilter = (req, file, cb) =>
  ALLOWED_MIME.includes(file.mimetype)
    ? cb(null, true)
    : cb(new AppError('Only image files are allowed (jpeg, png, webp, gif, avif)', 400), false);

export const multerCloud = () =>
  multer({ storage: multer.memoryStorage(), fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });

export const multerLocal = () =>
  multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, path.resolve('uploads')),
      filename:    (req, file, cb) => cb(null, nanoid(8) + path.extname(file.originalname)),
    }),
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 },
  });

export const upload =
  process.env.NODE_ENV === 'production' ? multerCloud() : multerLocal();
