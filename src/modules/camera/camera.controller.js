/**
 * src/modules/camera/camera.controller.js
 *
 * Routes:
 *   POST   /camera/upload            — ESP32-CAM uploads a JPEG image
 *   GET    /camera/sessions          — admin: list all sessions
 *   GET    /camera/session/:id       — admin: single session
 *   GET    /camera/return/:returnId  — admin: session for a return
 *   DELETE /camera/session/:id       — admin: delete session + Cloudinary asset
 */

import cameraSessionModel from '../../../db/models/cameraSession.model.js';
import returnModel from '../../../db/models/return.model.js';
import connectToDB from '../../../db/connectionDB.js';
import { AppError, asyncHandler } from '../../utils/error.js';
import { sendSuccess } from '../../utils/response.js';
import { uploadImageToCloud, deleteImageFromCloud } from '../../utils/imageUpload.js';
import { handleImageUpload } from '../../middleware/imagesMulter.js'

// ── POST /camera/upload ───────────────────────────────────────────────────────
/**
 * ESP32-CAM sends a JPEG image via multipart/form-data.
 *
 * Expected fields:
 *   image          (file, required)  — JPEG captured by the camera
 *   returnId       (text, required)  — MongoDB ObjectId of the return request
 *   firmwareVersion (text, optional) — e.g. "1.0.3", for diagnostics
 *
 * The firmware in the provided code sends:
 *   Content-Type: image/jpeg   (raw POST body, not multipart)
 *
 * We support BOTH:
 *   - multipart/form-data with field name "image"  (preferred, carries returnId)
 *   - raw image/jpeg body                           (legacy, returnId from header)
 */
export const uploadImage = asyncHandler(async (req, res, next) => {
  await connectToDB();

  let imageBuffer;
  let returnId;
  let firmwareVersion;

  const contentType = req.headers['content-type'] || '';
  const weight = req.headers['x-weight'];
  if (contentType.includes('multipart/form-data')) {
    // ── Multipart upload (preferred) ─────────────────────────────────────────
    try {
      await handleImageUpload(req, res);
    } catch (err) {
      return next(err);
    }

    if (!req.file) return next(new AppError('No image file received', 400));

    imageBuffer = req.file.buffer;
    returnId = req.body.returnId;
    firmwareVersion = req.body.firmwareVersion || null;

  } else if (contentType.includes('image/jpeg') || contentType.includes('image/jpg')) {
    // ── Raw JPEG body (matches original ESP32 firmware exactly) ──────────────
    imageBuffer = req.body;   // raw Buffer when express.raw() is applied to this route
    returnId = req.headers['x-return-id'];
    firmwareVersion = req.headers['x-firmware-version'] || null;

    if (!imageBuffer || imageBuffer.length === 0) {
      return next(new AppError('Empty image body received', 400));
    }

    const maxBytes = parseInt(process.env.IMAGE_MAX_SIZE_MB || '5', 10) * 1024 * 1024;
    if (imageBuffer.length > maxBytes) {
      return next(new AppError(`Image exceeds ${process.env.IMAGE_MAX_SIZE_MB || 5} MB limit`, 413));
    }
  } else {
    return next(new AppError(
      'Unsupported Content-Type. Send multipart/form-data or image/jpeg.',
      400
    ));
  }

  const boxId = req.boxId;

  // ── Validate returnId ─────────────────────────────────────────────────────
  if (!returnId) return next(new AppError('returnId is required (body field or X-Return-Id header)', 400));

  const returnDoc = await returnModel.findById(returnId);
  if (!returnDoc) return next(new AppError('Return request not found', 404));
  if (returnDoc.status !== 'pending') {
    return next(new AppError(`Cannot attach image — return status is "${returnDoc.status}"`, 409));
  }

  // ── Create session document ───────────────────────────────────────────────
  const attemptNumber = await cameraSessionModel.countDocuments({ returnId }) + 1;

  const session = await cameraSessionModel.create({
    returnId,
    boxId,
    weight: weight ? Number(weight) : null,
    status: 'uploading',
    capturedAt: new Date(),
    attemptNumber,
    deviceFirmware: firmwareVersion,
    fileSizeBytes: imageBuffer.length,
  });

  // ── Upload to Cloudinary ──────────────────────────────────────────────────
  let cloudResult;
  try {
    cloudResult = await uploadImageToCloud(imageBuffer, { returnId, boxId });
  } catch (cloudErr) {
    console.error('[camera] Cloudinary upload failed:', cloudErr.message);
    session.status = 'failed';
    session.errorMessage = cloudErr.message;
    await session.save();
    return next(new AppError('Image upload to cloud storage failed', 502));
  }

  // ── Confirm session ───────────────────────────────────────────────────────
  session.status = 'confirmed';
  session.imageUrl = cloudResult.url;
  session.publicId = cloudResult.publicId;
  session.fileSizeBytes = cloudResult.bytes;
  session.format = cloudResult.format;
  session.confirmedAt = new Date();
  await session.save();

  // ── Attach image to return document ──────────────────────────────────────
  await returnModel.findByIdAndUpdate(returnId, {
    $set: {
      imageUrl: cloudResult.url,
      imageSessionId: session._id,
      imageUploadedAt: new Date(),
      weight: weight ? Number(weight) : null,
    },
  });

  sendSuccess(res, 200, 'success', {
    sessionId: session._id,
    imageUrl: cloudResult.url,
  });
});

// ── GET /camera/sessions ──────────────────────────────────────────────────────
export const listSessions = asyncHandler(async (req, res) => {
  await connectToDB();

  const { page = 1, limit = 20, status, boxId } = req.query;
  const p = Math.max(parseInt(page) || 1, 1);
  const l = Math.min(parseInt(limit) || 20, 100);
  const skip = (p - 1) * l;

  const filter = {};
  if (status) filter.status = status;
  if (boxId) filter.boxId = boxId;

  const total = await cameraSessionModel.countDocuments(filter);
  const sessions = await cameraSessionModel
    .find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(l)
    .populate('returnId', 'status reason lockerUserId');

  sendSuccess(res, 200, 'success', {
    page: p, limit: l, total,
    totalPages: Math.ceil(total / l),
    sessions,
  });
});

// ── GET /camera/session/:id ───────────────────────────────────────────────────
export const getSession = asyncHandler(async (req, res, next) => {
  await connectToDB();

  const session = await cameraSessionModel
    .findById(req.params.id)
    .populate('returnId', 'status reason lockerUserId createdAt');

  if (!session) return next(new AppError('Session not found', 404));
  sendSuccess(res, 200, 'success', { session });
});

// ── GET /camera/return/:returnId ──────────────────────────────────────────────
export const getSessionByReturn = asyncHandler(async (req, res, next) => {
  await connectToDB();

  const session = await cameraSessionModel
    .findOne({ returnId: req.params.returnId, status: 'confirmed' })
    .sort({ createdAt: -1 });

  if (!session) return next(new AppError('No confirmed image found for this return', 404));
  sendSuccess(res, 200, 'success', { session });
});

// ── DELETE /camera/session/:id ────────────────────────────────────────────────
export const deleteSession = asyncHandler(async (req, res, next) => {
  await connectToDB();

  const session = await cameraSessionModel.findById(req.params.id);
  if (!session) return next(new AppError('Session not found', 404));

  if (session.publicId) {
    await deleteImageFromCloud(session.publicId).catch(err =>
      console.warn('[camera] Cloudinary delete failed:', err.message)
    );
  }

  if (session.returnId) {
    await returnModel.findByIdAndUpdate(session.returnId, {
      $unset: { imageUrl: '', imageSessionId: '', imageUploadedAt: '' },
    });
  }

  await session.deleteOne();
  sendSuccess(res, 200, 'success', { message: 'Session deleted' });
});



export const getNextReturn = async (req, res) => {
  await connectToDB();
  const { boxId } = req.query;

  if (!boxId) {
    return res.status(400).json({ msg: 'boxId required' });
  }

  const nextReturn = await returnModel
    .findOne({ status: 'pending' })
    .sort({ createdAt: 1 });

  if (!nextReturn) {
    return res.status(404).json({ msg: 'No pending returns' });
  }

  res.status(200).json({
    returnId: nextReturn._id
  });
};