import { Schema, model } from 'mongoose';

// A proposal from the inventory intelligence engine (rules over the demand forecast) or the
// inventory agent. It changes nothing on its own: approving it creates a stock movement that still
// has to be completed by an admin.
const aiRecommendationSchema = new Schema(
  {
    type:                { type: String, enum: ['stock_transfer', 'replenishment', 'excess_stock'], required: true, index: true },
    productId:           { type: Schema.Types.ObjectId, ref: 'product', required: true, index: true },
    sourceBranchId:      { type: Schema.Types.ObjectId, ref: 'branch', default: null },
    destinationBranchId: { type: Schema.Types.ObjectId, ref: 'branch', default: null },
    affectedBranches:    [{ type: Schema.Types.ObjectId, ref: 'branch' }],
    suggestedAction: {
      action:   { type: String, required: true }, // e.g. "transfer", "reorder", "hold / promote"
      quantity: { type: Number, default: 0, min: 0 },
    },
    reasoning:  { type: String, required: true, trim: true }, // deterministic, evidence-based explanation
    evidence:   { type: Schema.Types.Mixed, default: {} },     // the numbers the reasoning is based on
    priority:   { type: String, enum: ['high', 'medium', 'low'], default: 'medium', index: true },
    status:     { type: String, enum: ['pending', 'approved', 'rejected', 'superseded'], default: 'pending', index: true },
    source:     { type: String, enum: ['rules_engine', 'inventory_agent'], default: 'rules_engine' },
    horizonDays:     { type: Number, default: 30 },
    forecastRunId:   { type: Schema.Types.ObjectId, ref: 'forecastRun', default: null },
    isSyntheticData: { type: Boolean, default: false }, // true when based on the synthetic demo dataset
    createdBy:       { type: Schema.Types.ObjectId, ref: 'user', default: null },
    reviewedBy:      { type: Schema.Types.ObjectId, ref: 'user', default: null },
    reviewedAt:      { type: Date, default: null },
    reviewNote:      { type: String, trim: true, maxlength: 500 },
    stockMovementId: { type: Schema.Types.ObjectId, ref: 'stockMovement', default: null },
  },
  { timestamps: true }
);

aiRecommendationSchema.index({ createdAt: -1 });

export default model('aiRecommendation', aiRecommendationSchema);
