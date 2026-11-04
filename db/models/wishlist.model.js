import { Schema, model } from 'mongoose';

const wishlistSchema = new Schema(
  {
    sessionId: { type: String, index: true },
    userId:    { type: Schema.Types.ObjectId, ref: 'user', default: null, index: true },
    items: [
      {
        _id:       false,
        productId: { type: Schema.Types.ObjectId, ref: 'product', required: true },
        addedAt:   { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

export default model('wishlist', wishlistSchema);
