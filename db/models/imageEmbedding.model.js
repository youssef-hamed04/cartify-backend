import { Schema, model } from 'mongoose';

// CLIP embedding of a product photo, cached so the SmartBox photo match doesn't re-download
// and re-encode catalog images on every drop-off. Keyed by image URL + model.
const imageEmbeddingSchema = new Schema(
  {
    url:    { type: String, required: true, trim: true },
    model:  { type: String, required: true },
    vector: { type: [Number], required: true }, // L2-normalised
  },
  { timestamps: true }
);

imageEmbeddingSchema.index({ url: 1, model: 1 }, { unique: true });

const imageEmbeddingModel = model('ImageEmbedding', imageEmbeddingSchema);
export default imageEmbeddingModel;
