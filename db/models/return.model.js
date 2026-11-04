import { Schema, model } from 'mongoose';

const returnSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'user', default: null },
    orderId: { type: Schema.Types.ObjectId, ref: 'order', default: null },
    sessionId: { type: String, default: null },

    items: [
      {
        _id: false,
        productId: { type: Schema.Types.ObjectId, ref: 'product', required: true },
        name: { type: String, required: true },
        color: { type: String, required: true, trim: true },
        quantity: { type: Number, required: true, min: 1 },
      },
    ],
    weight: {
      type: Number,
      default: null,
    },
    reason: {
      type: String,
      enum: ['defective', 'wrong_size', 'changed_mind', 'wrong_item', 'other'],
      required: true,
    },
    notes: { type: String, trim: true, maxlength: 1000 },

    lockerUserId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    unlockCode: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    expiresAt: { type: Date, required: true, index: true },

    status: {
      type: String,
      enum: ['pending', 'completed', 'expired', 'denied'],
      default: 'pending',
      index: true,
    },

    processedByBox: { type: String, default: null },
    completedAt: { type: Date, default: null },

    // Camera image
    imageUrl: { type: String, default: null },
    imageSessionId: { type: Schema.Types.ObjectId, ref: 'cameraSession', default: null },
    imageUploadedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export default model('return', returnSchema);
