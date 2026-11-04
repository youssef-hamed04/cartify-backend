import { Schema, model } from 'mongoose';

// A physical Cartify SmartBox return locker
const lockerSchema = new Schema(
  {
    boxId:     { type: String, required: true, unique: true, trim: true }, // matches the X-Box-Id the hardware sends
    name:      { type: String, required: true, trim: true },
    address:   { type: String, required: true, trim: true },
    city:      { type: String, trim: true, default: '' },
    location:  {
      lat: { type: Number, required: true, min: -90, max: 90 },
      lng: { type: Number, required: true, min: -180, max: 180 },
    },
    status:    { type: String, enum: ['available', 'busy', 'maintenance'], default: 'available', index: true },
    hours:     { type: String, trim: true, default: '24/7' },
    freeSlots: { type: Number, default: 0, min: 0 },
    isActive:  { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

export default model('locker', lockerSchema);
