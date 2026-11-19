import { Schema, model } from 'mongoose';
import { realEstateFields, validateLocation } from './realEstateFields.js';
const schema = new Schema({
  ...realEstateFields(),
  pricePerM2: { type: Number, required: true, min: Number.MIN_VALUE },
  transactionDate: { type: Date, required: true },
  source: { type: String, enum: ['synthetic_demo', 'listing'], required: true },
  listingId: { type: Schema.Types.ObjectId, ref: 'property' },
});
validateLocation(schema);
schema.index({ listingType: 1, city: 1, district: 1 });
schema.index({ listingId: 1 }, { unique: true, partialFilterExpression: { listingId: { $type: 'objectId' } } });
export default model('realEstateMarket', schema, 'realestatemarkets');
