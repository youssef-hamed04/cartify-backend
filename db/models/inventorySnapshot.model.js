import { Schema, model } from 'mongoose';

// Daily stock level per product and location, recorded going forward so the forecasting model can
// tell real "no demand" days from days when the item was sold out. branchId null = online store
// (product variant stock).
const inventorySnapshotSchema = new Schema(
  {
    date:      { type: Date, required: true },  // UTC day
    branchId:  { type: Schema.Types.ObjectId, ref: 'branch', default: null },
    productId: { type: Schema.Types.ObjectId, ref: 'product', required: true },
    onHand:    { type: Number, required: true, min: 0 },
    reserved:  { type: Number, default: 0, min: 0 },
  },
  { versionKey: false }
);

inventorySnapshotSchema.index({ date: 1, branchId: 1, productId: 1 }, { unique: true });
inventorySnapshotSchema.index({ productId: 1, branchId: 1, date: 1 });

export default model('inventorySnapshot', inventorySnapshotSchema);
