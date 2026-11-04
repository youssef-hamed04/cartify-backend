import { Schema, model } from 'mongoose';

const imageSchema = new Schema(
  { url: { type: String, required: true, trim: true }, publicId: { type: String, trim: true } },
  { _id: false }
);

const variantSchema = new Schema(
  {
    color:    { type: String, required: true, trim: true },
    colorHex: { type: String, trim: true },
    images:   [imageSchema],
    stock:    { type: Number, default: 0, min: 0 },
    reserved: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const productSchema = new Schema(
  {
    name:        { type: String, required: true, trim: true, index: true },
    slug:        { type: String, required: true, trim: true, unique: true, lowercase: true },
    description: { type: String, required: true, trim: true },
    price:       { type: Number, required: true, min: 0 },
    discount:    { type: Number, default: 0, min: 0, max: 100 },
    raise:       { type: Number, default: 0 },
    category:    { type: String, required: true, trim: true, index: true },
    brand:       { type: String, trim: true, index: true },
    tags:        [{ type: String, trim: true }],
    variants:    [variantSchema],
    rating: {
      average: { type: Number, default: 0, min: 0, max: 5 },
      count:   { type: Number, default: 0, min: 0 },
    },
    isFeatured: { type: Boolean, default: false },
    hide:       { type: Boolean, default: false },
  },
  { timestamps: true }
);

productSchema.virtual('finalPrice').get(function () {
  const d = (this.price * (this.discount || 0)) / 100;
  const r = (this.price * (this.raise    || 0)) / 100;
  return +(this.price - d + r).toFixed(2);
});

productSchema.virtual('totalStock').get(function () {
  return this.variants.reduce((acc, v) => acc + (v.stock - v.reserved), 0);
});

productSchema.set('toJSON',   { virtuals: true });
productSchema.set('toObject', { virtuals: true });

productSchema.index({ name: 'text', brand: 'text', category: 'text', description: 'text' });
productSchema.index({ category: 1, brand: 1 });
productSchema.index({ price: 1 });
productSchema.index({ isFeatured: 1, hide: 1 });

export default model('product', productSchema);
