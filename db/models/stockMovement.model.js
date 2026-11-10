import { Schema, model } from 'mongoose';

// Stock moving between branches (transfer), arriving from a supplier (replenishment) or a manual
// stock count correction (adjustment). Transfers and replenishments only change inventory when an
// admin approves and then completes them; nothing here is executed automatically.
//
//   requested ──approve──▶ approved ──complete──▶ completed
//       │                     │
//       └──reject──▶ rejected └──cancel──▶ cancelled
const MOVEMENT_STATUSES = ['requested', 'approved', 'completed', 'rejected', 'cancelled'];

const stockMovementSchema = new Schema(
  {
    movementNumber:      { type: Number, required: true, unique: true },
    type:                { type: String, enum: ['transfer', 'replenishment', 'adjustment'], required: true, index: true },
    productId:           { type: Schema.Types.ObjectId, ref: 'product', required: true, index: true },
    sourceBranchId:      { type: Schema.Types.ObjectId, ref: 'branch', default: null }, // null = supplier
    destinationBranchId: { type: Schema.Types.ObjectId, ref: 'branch', default: null },
    quantity:            { type: Number, required: true, min: 1 },
    delta:               { type: Number, default: null }, // adjustments only: signed change applied
    status:              { type: String, enum: MOVEMENT_STATUSES, default: 'requested', index: true },
    reason:              { type: String, trim: true, maxlength: 500 },
    recommendationId:    { type: Schema.Types.ObjectId, ref: 'aiRecommendation', default: null },
    requestedBy:         { type: Schema.Types.ObjectId, ref: 'user', default: null },
    requestedVia:        { type: String, enum: ['dashboard', 'inventory_agent', 'recommendation', 'api', 'demo_seed'], default: 'api' },
    approvedBy:          { type: Schema.Types.ObjectId, ref: 'user', default: null },
    approvedAt:          { type: Date, default: null },
    completedBy:         { type: Schema.Types.ObjectId, ref: 'user', default: null },
    completedAt:         { type: Date, default: null },
    rejectedBy:          { type: Schema.Types.ObjectId, ref: 'user', default: null },
    rejectionReason:     { type: String, trim: true, maxlength: 500 },
    statusHistory: [
      { _id: false, status: String, changedAt: { type: Date, default: Date.now }, by: { type: Schema.Types.ObjectId, ref: 'user' }, note: String },
    ],
    isDemo:              { type: Boolean, default: false },
  },
  { timestamps: true }
);

stockMovementSchema.index({ createdAt: -1 });
stockMovementSchema.index({ sourceBranchId: 1, status: 1 });
stockMovementSchema.index({ destinationBranchId: 1, status: 1 });

export { MOVEMENT_STATUSES };
export default model('stockMovement', stockMovementSchema);
