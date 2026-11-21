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

import mongoose from 'mongoose';
import cameraSessionModel from '../../../db/models/cameraSession.model.js';
import returnModel from '../../../db/models/return.model.js';
import connectToDB from '../../../db/connectionDB.js';
import { AppError, asyncHandler } from '../../utils/error.js';
import { sendSuccess } from '../../utils/response.js';
import { uploadImageToCloud, deleteImageFromCloud } from '../../utils/imageUpload.js';
import { handleImageUpload } from '../../middleware/imagesMulter.js'
import { failedVerification, isVerificationEnabled, verifyReturnDrop } from '../../utils/returnVerification.js';

// Once a return is completed (door opened / first photo stored), the same box may still send
// photos for it for this long, e.g. a retry (CAMERA_UPLOAD_WINDOW_MIN in .env, default 15 minutes).
const uploadWindowMs = () => (parseInt(process.env.CAMERA_UPLOAD_WINDOW_MIN, 10) || 15) * 60 * 1000;

// The return a box photo belongs to: by returnId, or by the locker ID the customer typed on the
// keypad (the newest open return with that ID, or one this box completed a few minutes ago).
const findReturnForUpload = ({ returnId, lockerUserId, boxId }) => {
  if (returnId) return returnModel.findById(returnId);
  return returnModel
    .findOne({
      lockerUserId: String(lockerUserId).trim(),
      $or: [
        { status: 'pending', expiresAt: { $gt: new Date() } },
        { status: 'completed', processedByBox: boxId, completedAt: { $gte: new Date(Date.now() - uploadWindowMs()) } },
      ],
    })
    .sort({ createdAt: -1 });
};

// Why a photo can't be attached to this return, or null when it can.
const uploadRefusal = (returnDoc, boxId) => {
  if (returnDoc.status === 'pending') {
    return returnDoc.expiresAt < new Date() ? 'This return has expired' : null;
  }
  if (returnDoc.status !== 'completed') return `Cannot attach image — return status is "${returnDoc.status}"`;
  if (returnDoc.processedByBox && returnDoc.processedByBox !== boxId) {
    return 'This return was opened at a different box';
  }
  if (!returnDoc.completedAt || Date.now() - returnDoc.completedAt.getTime() > uploadWindowMs()) {
    return 'The photo window for this return has closed';
  }
  return null;
};

// Runs the weight + image check and stores the verdict on the session and its return
const runVerification = async (session, returnDoc, imageBuffer, measuredWeight) => {
  let verification;
  try {
    verification = await verifyReturnDrop({ imageBuffer, measuredWeight, items: returnDoc.items });
    console.log(`[verify] return ${returnDoc._id} → ${verification.verdict} (image ${verification.visual.score}, weight ${verification.weight.passed})`);
  } catch (err) {
    console.error('[verify] check failed:', err.message);
    verification = failedVerification(err);
  }
  await Promise.all([
    cameraSessionModel.findByIdAndUpdate(session._id, { verification }),
    returnModel.findOneAndUpdate({ _id: returnDoc._id, imageSessionId: session._id }, { verification }),
  ]);
  return verification;
};

// ── POST /camera/upload ───────────────────────────────────────────────────────
/**
 * The ESP32-CAM sends the photo it took after the box detected the item on the scale.
 * Full description for the firmware: docs/SMARTBOX_INTEGRATION.md.
 *
 * Headers: X-Device-Key, X-Box-Id (checked by deviceAuth), X-Weight (grams, optional).
 * Which return: X-Locker-User-Id (the ID typed on the keypad) or X-Return-Id.
 *
 * Two body formats:
 *   - raw image/jpeg body; IDs in the headers above, firmware in X-Firmware-Version
 *   - multipart/form-data: file field "image", text fields lockerUserId / returnId / firmwareVersion
 *
 * The first photo for an open return marks it completed (the item is in the box).
 */
export const uploadImage = asyncHandler(async (req, res, next) => {
  await connectToDB();

  let imageBuffer;
  let returnId;
  let lockerUserId;
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
    lockerUserId = req.body.lockerUserId;
    firmwareVersion = req.body.firmwareVersion || null;

  } else if (contentType.includes('image/jpeg') || contentType.includes('image/jpg')) {
    // ── Raw JPEG body (matches original ESP32 firmware exactly) ──────────────
    imageBuffer = req.body;   // raw Buffer when express.raw() is applied to this route
    returnId = req.headers['x-return-id'];
    lockerUserId = req.headers['x-locker-user-id'];
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

  // ── Find the return ───────────────────────────────────────────────────────
  if (!returnId && !lockerUserId) {
    return next(new AppError('Send X-Locker-User-Id (the ID typed on the keypad) or X-Return-Id', 400));
  }
  if (returnId && !mongoose.isValidObjectId(returnId)) return next(new AppError('Invalid return ID', 400));

  const returnDoc = await findReturnForUpload({ returnId, lockerUserId, boxId });
  if (!returnDoc) {
    return next(new AppError(returnId ? 'Return request not found' : 'No open return for this locker ID', 404));
  }
  const refusal = uploadRefusal(returnDoc, boxId);
  if (refusal) return next(new AppError(refusal, 409));
  returnId = String(returnDoc._id);
  const completesReturn = returnDoc.status === 'pending';

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
  // The box only sends a photo after the item was detected on the scale, so the first photo
  // for an open return also completes it (the box checks the code offline and can't report it).
  await returnModel.findByIdAndUpdate(returnId, {
    $set: {
      imageUrl: cloudResult.url,
      imageSessionId: session._id,
      imageUploadedAt: new Date(),
      weight: weight ? Number(weight) : null,
      verification: isVerificationEnabled() ? { verdict: 'processing', reasons: [] } : null,
      ...(completesReturn ? { status: 'completed', completedAt: new Date(), processedByBox: boxId } : {}),
    },
  });

  sendSuccess(res, 200, 'success', {
    sessionId: session._id,
    returnId,
    imageUrl: cloudResult.url,
  });

  // The box doesn't wait for the check; the verdict is saved when it finishes
  if (isVerificationEnabled()) {
    runVerification(session, returnDoc, imageBuffer, weight ? Number(weight) : null);
  }
});

// ── POST /camera/session/:id/verify (admin) ───────────────────────────────────
// Re-runs the check on a stored photo, e.g. after setting product weights.
export const reverifySession = asyncHandler(async (req, res, next) => {
  await connectToDB();
  const session = await cameraSessionModel.findById(req.params.id);
  if (!session?.imageUrl) return next(new AppError('Session or image not found', 404));
  const returnDoc = await returnModel.findById(session.returnId);
  if (!returnDoc) return next(new AppError('Return request not found', 404));

  const image = await fetch(session.imageUrl);
  if (!image.ok) return next(new AppError('Could not download the stored image', 502));
  const imageBuffer = Buffer.from(await image.arrayBuffer());

  const verification = await runVerification(session, returnDoc, imageBuffer, session.weight);
  sendSuccess(res, 200, 'success', { verification });
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



// ── GET /camera/next-return (SmartBox) ────────────────────────────────────────
// The return this box opened most recently, while its photo window is still open.
// /returns/validate-code already sends the returnId; this is a fallback if the box lost it.
export const getNextReturn = asyncHandler(async (req, res) => {
  await connectToDB();
  const nextReturn = await returnModel
    .findOne({
      processedByBox: req.boxId,
      status: 'completed',
      completedAt: { $gte: new Date(Date.now() - uploadWindowMs()) },
    })
    .sort({ completedAt: -1 });

  if (!nextReturn) {
    return res.status(404).json({ msg: 'No return is waiting for a photo at this box' });
  }
  res.status(200).json({ returnId: nextReturn._id });
});