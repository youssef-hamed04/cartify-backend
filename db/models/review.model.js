import { Schema, model } from 'mongoose';

const reviewSchema = new Schema(
  {
    productId:          { type: Schema.Types.ObjectId, ref: 'product', required: true, index: true },
    userId:             { type: Schema.Types.ObjectId, ref: 'user',    required: true },
    orderId:            { type: Schema.Types.ObjectId, ref: 'order' },
    rating:             { type: Number, required: true, min: 1, max: 5 },
    title:              { type: String, trim: true, maxlength: 100 },
    body:               { type: String, trim: true, maxlength: 2000 },
    isVerifiedPurchase: { type: Boolean, default: false },
    helpfulVotes:       { type: Number, default: 0 },
  },
  { timestamps: true }
);

reviewSchema.index({ productId: 1, userId: 1 }, { unique: true });

export default model('review', reviewSchema);
