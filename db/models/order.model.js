import { Schema, model } from 'mongoose';

const orderItemSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'product', required: true },
    name: { type: String, required: true },
    color: { type: String, required: true, trim: true },
    imageUrl: { type: String },
    quantity: { type: Number, default: 1, min: 1 },
    unitPrice: { type: Number, required: true },
    isRefundRequested: { type: Boolean, default: false },

  },
  { _id: false }
);

const orderSchema = new Schema(
  {
    sessionId: { type: String },
    userId: { type: Schema.Types.ObjectId, ref: 'user', default: null },
    orderNumber: { type: Number, required: true, unique: true },
    randomId: { type: String, required: true },
    products: [orderItemSchema],
    subtotal: { type: Number, required: true },
    shippingCost: { type: Number, default: 0 },
    couponDiscount: { type: Number, default: 0 },
    totalPrice: { type: Number, required: true },
    status: {
      type: String,
      enum: ['placed', 'confirmed', 'shipping', 'delivered', 'cancelled', 'refunded'],
      default: 'placed',
      index: true,
    },
    statusHistory: [
      { _id: false, status: String, changedAt: { type: Date, default: Date.now }, note: String },
    ],
    email: { type: String, required: true },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    address: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    governorate: { type: String, required: true, trim: true },
    paymentMethod: {
      type: String,
      enum: ['cash', 'credit_card', 'instaPay', 'vodafoneCash'],
      default: 'cash',
    },
    isPaid: { type: Boolean, default: false },
    paidAt: { type: Date },
    trackingNumber: { type: String, trim: true },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

orderSchema.index({ email: 1 });
orderSchema.index({ randomId: 1 });
orderSchema.index({ createdAt: -1 });

export default model('order', orderSchema);
