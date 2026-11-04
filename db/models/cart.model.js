import { Schema, model } from 'mongoose';

const cartItemSchema = new Schema(
  {
    productId:     { type: Schema.Types.ObjectId, ref: 'product', required: true },
    quantity:      { type: Number, default: 1, min: 1 },
    color:         { type: String, required: true, trim: true },
    priceSnapshot: { type: Number },
  },
  { _id: false }
);

const cartSchema = new Schema(
  {
    sessionId: { type: String, index: true },
    userId:    { type: Schema.Types.ObjectId, ref: 'user', default: null, index: true },
    items:     [cartItemSchema],
    couponCode:{ type: String, trim: true },
    discount:  { type: Number, default: 0 },
    expiresAt: { type: Date },
  },
  { timestamps: true }
);

cartSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, sparse: true });

export default model('cart', cartSchema);
