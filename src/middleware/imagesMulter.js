import multer from 'multer';
import { AppError } from '../utils/error.js';

const MAX_MB = parseInt(process.env.IMAGE_MAX_SIZE_MB || '5', 10);

const ALLOWED_IMAGE_MIME = [
    'image/jpeg',
    'image/jpg',
];

const fileFilter = (_req, file, cb) => {
    if (ALLOWED_IMAGE_MIME.includes(file.mimetype)) return cb(null, true);
    cb(new AppError(`Unsupported image format: ${file.mimetype}. Only JPEG is accepted.`, 400), false);
};

// Memory storage — JPEG images from ESP32-CAM are small (< 100 KB typical).
// No temp files needed; buffer is passed directly to Cloudinary.
const upload = multer({
    storage: multer.memoryStorage(),
    fileFilter,
    limits: {
        fileSize: MAX_MB * 1024 * 1024,
        files: 1,
    },
}).single('image');

/**
 * Promise wrapper so the controller can use async/await.
 */
export const handleImageUpload = (req, res) =>
    new Promise((resolve, reject) => {
        upload(req, res, (err) => {
            if (!err) return resolve();
            if (err.code === 'LIMIT_FILE_SIZE') return reject(new AppError(`Image exceeds ${MAX_MB} MB limit`, 413));
            if (err instanceof multer.MulterError) return reject(new AppError(err.message, 400));
            reject(err);
        });
    });
