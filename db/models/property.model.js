import { Schema, model } from 'mongoose';
import { realEstateFields, validateLocation } from './realEstateFields.js';
import { amenities } from '../data/dakahliaLocations.js';
const schema = new Schema({
  ...realEstateFields(),
  owner: { type: Schema.Types.ObjectId, ref: 'user', required: true },
  title: { type: String, required: true, trim: true, minlength: 5, maxlength: 120 },
  description: { type: String, maxlength: 3000, default: '' },
  address: { type: String, maxlength: 500 },
  amenities: [{ type: String, enum: amenities }],
  images: { type: [{ _id: false, url: String, publicId: String }], validate: v => v.length <= 8 },
  contactPhone: { type: String, required: true, match: /^(010|011|012|015)[0-9]{8}$/ },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'sold', 'rented', 'archived'], default: 'pending' },
  rejectionReason: String,
  reviewedBy: { type: Schema.Types.ObjectId, ref: 'user' },
  reviewedAt: Date,
  estimate: { price: Number, pricePerM2: Number, low: Number, high: Number, method: String, model: String,
    verdict: { type: String, enum: ['below_market', 'fair', 'above_market'] }, diffPercent: Number, computedAt: Date },
  views: { type: Number, default: 0, min: 0 },
  isDemo: { type: Boolean, default: false },
}, { timestamps: true, optimisticConcurrency: true });
validateLocation(schema);
schema.index({ status: 1, listingType: 1, city: 1, district: 1 });
schema.index({ owner: 1, createdAt: -1 });
export default model('property', schema, 'properties');
