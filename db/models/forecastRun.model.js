import { Schema, model } from 'mongoose';

// One run of the demand forecasting model (all horizons at once) and its stored results, so the
// dashboard and the inventory agent read predictions without re-training. The model itself lives in
// the Python AI service; this document records what it predicted and how it was evaluated.
const forecastRowSchema = new Schema(
  {
    productId:              { type: Schema.Types.ObjectId, ref: 'product', required: true },
    productName:            String,
    category:               String,
    branchId:               { type: Schema.Types.ObjectId, ref: 'branch', default: null }, // null = online store
    branchName:             String,
    predictedDemand:        Number,
    low:                    Number,
    high:                   Number,
    dailyRate:              Number,
    recentDailyRate:        Number,
    trend:                  { type: String, enum: ['increasing', 'decreasing', 'stable', 'unknown'] },
    trendPct:               Number,
    stockoutDaysLast28:     Number,
    lowConfidence:          Boolean,
    currentStock:           Number,
    reserved:               Number,
    available:              Number,
    inbound:                Number,
    safetyStock:            Number,
    suggestedReplenishment: Number,
    surplusUnits:           Number,
    excessUnits:            Number,
    daysOfCover:            Number, // null = no demand expected
    shortageRisk:           { type: String, enum: ['high', 'medium', 'low', 'none'] },
  },
  { _id: false }
);

const horizonSchema = new Schema(
  {
    horizonDays:        { type: Number, required: true },
    status:             String, // ok | baseline_only
    selectedModel:      String,
    selectedModelLabel: String,
    selectionRule:      String,
    candidates:         { type: Schema.Types.Mixed, default: [] },
    test:               { type: Schema.Types.Mixed, default: null },
    interval:           { type: Schema.Types.Mixed, default: null },
    featureImportance:  { type: Schema.Types.Mixed, default: [] },
    warnings:           [String],
    results:            [forecastRowSchema],
  },
  { _id: false }
);

const forecastRunSchema = new Schema(
  {
    status:        { type: String, enum: ['running', 'completed', 'failed'], default: 'running', index: true },
    asOf:          { type: Date, required: true },
    dataSource:    { type: String, enum: ['orders', 'synthetic_demo'], required: true },
    isSynthetic:   { type: Boolean, default: false },
    historyDays:   Number,
    seriesCount:   Number,
    serviceVersion: String,
    features:      [String],
    target:        String,
    settings:      { type: Schema.Types.Mixed, default: {} }, // lead time, service level, ...
    horizons:      [horizonSchema],
    error:         String,
    durationMs:    Number,
    createdBy:     { type: Schema.Types.ObjectId, ref: 'user', default: null },
  },
  { timestamps: true }
);

forecastRunSchema.index({ createdAt: -1 });

export default model('forecastRun', forecastRunSchema);
