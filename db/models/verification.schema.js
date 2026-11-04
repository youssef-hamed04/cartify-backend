import { Schema } from 'mongoose';

// Result of the SmartBox drop-off check (weight + CLIP image check), stored on the
// camera session and copied onto the return request.
export const verificationSchema = new Schema(
  {
    // processing → match | review | error
    verdict: { type: String, enum: ['processing', 'match', 'review', 'error'], required: true },
    reasons: [{ type: String }],

    visual: {
      score: { type: Number, default: null },        // 0–1 probability the photo shows the returned product
      passed: { type: Boolean, default: null },
      topLabel: { type: String, default: null },     // what CLIP thinks the photo shows most
      labels: [{ _id: false, label: String, score: Number }],
    },

    weight: {
      measured: { type: Number, default: null },     // grams, from the box
      expected: { type: Number, default: null },     // grams, from product variants × quantity
      tolerance: { type: Number, default: null },
      passed: { type: Boolean, default: null },      // null = could not be checked
    },

    model: { type: String, default: null },
    durationMs: { type: Number, default: null },
    checkedAt: { type: Date, default: null },
    error: { type: String, default: null },
  },
  { _id: false }
);
