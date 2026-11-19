import { propertyTypes, finishing, views, dakahliaLocations, locationError } from '../data/dakahliaLocations.js';
export const realEstateFields = () => ({
  listingType: { type: String, enum: ['sale', 'rent'], required: true },
  propertyType: { type: String, enum: propertyTypes, required: true },
  city: { type: String, enum: dakahliaLocations.map(c => c.slug), required: true },
  district: { type: String, required: true },
  area: { type: Number, min: 15, max: 5000, required: true },
  rooms: { type: Number, min: 0, max: 20, default: 0 },
  bathrooms: { type: Number, min: 0, max: 10, default: 0 },
  floor: { type: Number, min: -1, max: 60, default: 0 },
  hasElevator: { type: Boolean, default: false },
  buildingAge: { type: Number, min: 0, max: 80, default: 0 },
  finishing: { type: String, enum: finishing, default: 'none' },
  furnished: { type: Boolean, default: false },
  view: { type: String, enum: views, default: 'street' },
  price: { type: Number, required: true, min: Number.MIN_VALUE },
});
export function validateLocation(schema) {
  schema.pre('validate', function () {
    const error = locationError(this);
    if (error) this.invalidate('district', error);
  });
}
