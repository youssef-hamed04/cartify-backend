import { Schema, model } from 'mongoose';

// Stock of one product at one branch. `reserved` holds units promised to approved transfers
// (and, later, branch orders); available = quantity - reserved. updatedAt is the "last updated" time.
const branchInventorySchema = new Schema(
  {
    branchId:    { type: Schema.Types.ObjectId, ref: 'branch', required: true, index: true },
    productId:   { type: Schema.Types.ObjectId, ref: 'product', required: true, index: true },
    quantity:    { type: Number, default: 0, min: 0 },
    reserved:    { type: Number, default: 0, min: 0 },
    safetyStock: { type: Number, default: null, min: 0 }, // manual override; null = computed from the forecast
  },
  { timestamps: true }
);

branchInventorySchema.index({ branchId: 1, productId: 1 }, { unique: true });

branchInventorySchema.virtual('available').get(function () {
  return Math.max(0, (this.quantity || 0) - (this.reserved || 0));
});
branchInventorySchema.set('toJSON', { virtuals: true });
branchInventorySchema.set('toObject', { virtuals: true });

export default model('branchInventory', branchInventorySchema);
