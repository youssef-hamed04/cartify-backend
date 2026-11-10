import { Schema, model } from 'mongoose';

// A physical Cartify store / stock location. The online store is not a branch:
// its stock stays on product.variants (existing behaviour) and it appears as "Online store" in reports.
const branchSchema = new Schema(
  {
    code:     { type: String, required: true, unique: true, trim: true, uppercase: true }, // e.g. MNS-UNI
    name:     { type: String, required: true, trim: true },
    address:  { type: String, required: true, trim: true },
    city:     { type: String, trim: true, default: '' },
    location: {
      lat: { type: Number, min: -90, max: 90 },
      lng: { type: Number, min: -180, max: 180 },
    },
    status:   { type: String, enum: ['active', 'inactive', 'maintenance'], default: 'active', index: true },
    isDemo:   { type: Boolean, default: false }, // created by the AI demo seeder (npm run seed:ai-demo)
  },
  { timestamps: true }
);

export default model('branch', branchSchema);
