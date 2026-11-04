import { Schema, model } from 'mongoose';

const userSchema = new Schema(
  {
    email:       { type: String, required: true, unique: true, lowercase: true, trim: true },
    password:    { type: String, select: false },
    firstName:   { type: String, default: '', trim: true },
    lastName:    { type: String, default: '', trim: true },
    phone:       { type: String, default: '', trim: true },
    avatar:      { type: String, default: '' },
    address:     { type: String, default: '', trim: true },
    city:        { type: String, default: '', trim: true },
    governorate: { type: String, default: '', trim: true },
    role:        { type: String, enum: ['user', 'admin'], default: 'user' },
    isVerified:  { type: Boolean, default: false },
    refreshToken:{ type: String, select: false },
    orders: [{ _id: false, orderId: { type: Schema.Types.ObjectId, ref: 'order' } }],
    membershipTier: {
      type: String,
      enum: ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM'],
      default: 'BRONZE',
    },
    totalSpent: { type: Number, default: 0 },
  },
  { timestamps: true }
);

userSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`.trim();
});
userSchema.set('toJSON', { virtuals: true });

export default model('user', userSchema);
