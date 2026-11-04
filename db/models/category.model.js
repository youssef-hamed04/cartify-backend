import { Schema, model } from 'mongoose';

const categorySchema = new Schema(
  {
    name:         { type: String, required: true, trim: true, unique: true },
    slug:         { type: String, required: true, trim: true, unique: true, lowercase: true },
    description:  { type: String, trim: true },
    image:        { url: { type: String, trim: true }, publicId: { type: String, trim: true } },
    icon:         { type: String, trim: true },
    bannerText:   { type: String, trim: true },
    productCount: { type: Number, default: 0 },
    isActive:     { type: Boolean, default: true },
    displayOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

categorySchema.index({ slug: 1 });
categorySchema.index({ isActive: 1, displayOrder: 1 });

export default model('category', categorySchema);
