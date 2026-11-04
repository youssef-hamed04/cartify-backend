import { Schema, model } from 'mongoose';

const cameraSessionSchema = new Schema(
  {
    returnId: {
      type: Schema.Types.ObjectId,
      ref: 'return',
      required: true,
      index: true,
    },
    boxId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    // Status flow: uploading → confirmed | failed
    status: {
      type: String,
      enum: ['uploading', 'confirmed', 'failed'],
      default: 'uploading',
      index: true,
    },
    weight: {
      type: Number,
      default: null,
    },

    // Image asset
    imageUrl: { type: String, trim: true },
    publicId: { type: String, trim: true },
    fileSizeBytes: { type: Number, default: 0 },
    format: { type: String, default: 'jpg' },

    // Timing
    capturedAt: { type: Date },
    confirmedAt: { type: Date },

    // Retry tracking
    attemptNumber: { type: Number, default: 1 },
    errorMessage: { type: String, trim: true },

    // Hardware info
    deviceFirmware: { type: String, trim: true },
  },
  { timestamps: true }
);

cameraSessionSchema.index({ boxId: 1, createdAt: -1 });

export default model('cameraSession', cameraSessionSchema);
