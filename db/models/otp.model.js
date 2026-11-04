import { Schema, model } from 'mongoose';

// One-time login codes for the mobile app (email OTP)
const otpSchema = new Schema(
  {
    email:     { type: String, required: true, lowercase: true, trim: true, index: true },
    codeHash:  { type: String, required: true },
    attempts:  { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// MongoDB removes expired codes automatically
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default model('otp', otpSchema);
