/**
 * SmartBox drop-off check: is the item in the box the product being returned?
 *
 *  1. Weight  — box reading vs. the product variants' weight × quantity.
 *  2. Image   — CLIP (open-source, runs locally on the CPU via transformers.js) scores the
 *               box photo against the returned product's name and a set of distractors
 *               (other catalog products, an empty box…). No API key, no per-call cost.
 *
 * The verdict is advisory ("match" or "review"); an admin still decides on refunds.
 * Set AI_VERIFY=off to disable. The model (~150 MB) downloads once into .cache/models.
 */
import { env, pipeline, RawImage } from '@huggingface/transformers';
import productModel from '../../db/models/product.model.js';

const MODEL = process.env.AI_VISION_MODEL || 'Xenova/clip-vit-base-patch32';
const VISUAL_PASS = 0.5;          // probability the photo shows the expected product
const WEIGHT_TOLERANCE = 0.2;     // ±20 %…
const WEIGHT_MIN_TOLERANCE = 25;  // …but never tighter than ±25 g (sensor noise, packaging)
const GENERIC_DISTRACTORS = ['an empty box', "a person's hand", 'a crumpled piece of paper'];

env.cacheDir = process.env.AI_MODEL_CACHE || './.cache/models';

export const isVerificationEnabled = () => process.env.AI_VERIFY !== 'off';

let classifierPromise = null;
const getClassifier = () => {
  classifierPromise ??= pipeline('zero-shot-image-classification', MODEL, { dtype: 'q8' }).catch((err) => {
    classifierPromise = null; // allow a retry on the next drop-off
    throw err;
  });
  return classifierPromise;
};

// Load the model at startup so the first drop-off isn't slow
export const warmUpVerification = () => {
  if (!isVerificationEnabled()) return;
  const t0 = Date.now();
  getClassifier()
    .then(() => console.log(`🧠  Return verification model ready (${MODEL}, ${Date.now() - t0} ms)`))
    .catch((err) => console.warn('🧠  Return verification model failed to load:', err.message));
};

const checkWeight = (measured, expected) => {
  if (measured == null || Number.isNaN(measured) || expected == null) {
    return { measured: measured ?? null, expected, tolerance: null, passed: null };
  }
  const tolerance = Math.max(expected * WEIGHT_TOLERANCE, WEIGHT_MIN_TOLERANCE);
  return { measured, expected, tolerance: Math.round(tolerance), passed: Math.abs(measured - expected) <= tolerance };
};

// Sum of variant weights × quantity; null when any returned variant has no weight set
const expectedWeightFor = (items, products) => {
  let total = 0;
  for (const item of items) {
    const product = products.find((p) => p._id.toString() === item.productId.toString());
    const variant = product?.variants.find((v) => v.color.toLowerCase() === String(item.color).toLowerCase());
    if (!variant?.weight) return null;
    total += variant.weight * item.quantity;
  }
  return total;
};

// Other catalog products (different categories) make the image check meaningful:
// CLIP must prefer the returned product over plausible alternatives, not just over nothing.
const distractorLabels = async (products) => {
  const categories = [...new Set(products.map((p) => p.category))];
  const others = await productModel
    .find({ category: { $nin: categories }, hide: false })
    .select('name category')
    .sort({ 'rating.count': -1 })
    .limit(30)
    .lean();
  const onePerCategory = [];
  const seen = new Set();
  for (const p of others) {
    if (!seen.has(p.category)) { seen.add(p.category); onePerCategory.push(p.name); }
  }
  return [...onePerCategory, ...GENERIC_DISTRACTORS];
};

/**
 * @param {{ imageBuffer: Buffer, measuredWeight: number|null, items: {productId, name, color, quantity}[] }} input
 * @returns verification object matching db/models/verification.schema.js
 */
export async function verifyReturnDrop({ imageBuffer, measuredWeight, items }) {
  const started = Date.now();
  const productIds = items.map((i) => i.productId);
  const products = await productModel.find({ _id: { $in: productIds } }).select('name category variants').lean();

  const weight = checkWeight(measuredWeight, expectedWeightFor(items, products));

  const expected = [...new Set(items.map((i) => products.find((p) => p._id.toString() === i.productId.toString())?.name || i.name))];
  const labels = [...expected, ...(await distractorLabels(products))];

  const classifier = await getClassifier();
  const image = await RawImage.fromBlob(new Blob([imageBuffer]));
  const ranked = await classifier(image, labels, { hypothesis_template: 'a photo of {}' });

  const score = ranked.filter((r) => expected.includes(r.label)).reduce((sum, r) => sum + r.score, 0);
  const visual = {
    score: +score.toFixed(3),
    passed: score >= VISUAL_PASS,
    topLabel: ranked[0]?.label ?? null,
    labels: ranked.slice(0, 5).map((r) => ({ label: r.label, score: +r.score.toFixed(3) })),
  };

  const reasons = [];
  if (!visual.passed) reasons.push(`Photo looks more like "${visual.topLabel}" than the returned product`);
  if (weight.passed === false) reasons.push(`Weight ${weight.measured} g, expected about ${weight.expected} g`);
  if (weight.passed === null) reasons.push(weight.expected == null ? 'No product weight set, weight not checked' : 'Box sent no weight reading');

  return {
    verdict: visual.passed && weight.passed !== false ? 'match' : 'review',
    reasons,
    visual,
    weight,
    model: MODEL,
    durationMs: Date.now() - started,
    checkedAt: new Date(),
    error: null,
  };
}

export const failedVerification = (err) => ({
  verdict: 'error',
  reasons: ['Automatic check failed, review manually'],
  model: MODEL,
  checkedAt: new Date(),
  error: err.message,
});
