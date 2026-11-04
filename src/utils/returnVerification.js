/**
 * SmartBox drop-off check: is the item in the box the product being returned?
 *
 *  1. Weight  — box reading vs. the product variants' weight × quantity.
 *  2. Photo   — CLIP image embeddings: the box photo is compared with the catalog photos of the
 *               returned variant, other colours of it, and similar products. This tells apart
 *               look-alike products and colours. Catalog embeddings are cached in MongoDB.
 *  3. Label   — CLIP also scores the photo against the product's name and generic distractors
 *               (an empty box, a hand…). Used alone when the product has no photos.
 *
 * Everything runs locally on the CPU via transformers.js: no API key, no per-call cost.
 * The verdict is advisory ("match" or "review"); an admin still decides on refunds.
 * Set AI_VERIFY=off to disable. The model (~240 MB) downloads once into .cache/models.
 */
import { env, pipeline, AutoProcessor, CLIPVisionModelWithProjection, RawImage } from '@huggingface/transformers';
import imageEmbeddingModel from '../../db/models/imageEmbedding.model.js';
import productModel from '../../db/models/product.model.js';

const MODEL = process.env.AI_VISION_MODEL || 'Xenova/clip-vit-base-patch32';
const VISUAL_PASS = 0.5;          // probability the photo shows the expected product
const PHOTO_PASS = 0.5;           // share of photo-match probability on the returned variant
const PHOTO_MIN_SIMILARITY = 0.7; // below this the photo resembles no catalog photo (tuned on simulated box photos: empty box ≤ 0.68, right item ≥ 0.71)
const PHOTO_SURE_SIMILARITY = 0.75; // needed to overrule the label check saying "empty box" / "hand"
const PHOTO_SCALE = 100;         // CLIP's logit scale, turns cosine similarities into probabilities
const PHOTO_DISTRACTORS = 15;     // other catalog products compared (same category first)
const IMAGES_PER_ITEM = 3;        // catalog photos used per variant
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

let visionPromise = null;
const getVision = () => {
  visionPromise ??= Promise.all([
    AutoProcessor.from_pretrained(MODEL),
    CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: 'q8' }),
  ]).catch((err) => {
    visionPromise = null;
    throw err;
  });
  return visionPromise;
};

const embedImage = async (image) => {
  const [processor, vision] = await getVision();
  const { image_embeds } = await vision(await processor(image));
  const vector = Array.from(image_embeds.data);
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  return vector.map((x) => x / norm);
};

const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);

// url → Promise<vector | null>, backed by the ImageEmbedding collection across restarts
const embeddings = new Map();
const embeddingForUrl = (url) => {
  if (!embeddings.has(url)) {
    const job = (async () => {
      const cached = await imageEmbeddingModel.findOne({ url, model: MODEL }).select('vector').lean();
      if (cached) return cached.vector;
      const vector = await embedImage(await RawImage.fromURL(url));
      await imageEmbeddingModel.updateOne({ url, model: MODEL }, { vector }, { upsert: true });
      return vector;
    })().catch((err) => {
      embeddings.delete(url); // retry next time
      console.warn(`🧠  Could not embed ${url}: ${err.message}`);
      return null;
    });
    embeddings.set(url, job);
  }
  return embeddings.get(url);
};

const variantUrls = (variant) => (variant?.images || []).map((i) => i.url).filter(Boolean).slice(0, IMAGES_PER_ITEM);

// Pre-compute catalog photo embeddings so a drop-off only has to encode the box photo
export const indexProductImages = async (product) => {
  if (!isVerificationEnabled()) return 0;
  const vectors = await Promise.all(product.variants.flatMap(variantUrls).map(embeddingForUrl));
  return vectors.filter(Boolean).length;
};

// Load the models at startup so the first drop-off isn't slow, then index the catalog photos
export const warmUpVerification = () => {
  if (!isVerificationEnabled()) return;
  const t0 = Date.now();
  Promise.all([getClassifier(), getVision()])
    .then(async () => {
      console.log(`🧠  Return verification model ready (${MODEL}, ${Date.now() - t0} ms)`);
      const products = await productModel.find({ hide: false }).select('variants').lean();
      let count = 0;
      for (const product of products) count += await indexProductImages(product);
      console.log(`🧠  Indexed ${count} catalog photos for the SmartBox photo match (${Date.now() - t0} ms)`);
    })
    .catch((err) => console.warn('🧠  Return verification model failed to load:', err.message));
};

const checkWeight = (measured, expected) => {
  if (measured == null || Number.isNaN(measured) || expected == null) {
    return { measured: measured ?? null, expected, tolerance: null, passed: null };
  }
  const tolerance = Math.max(expected * WEIGHT_TOLERANCE, WEIGHT_MIN_TOLERANCE);
  return { measured, expected, tolerance: Math.round(tolerance), passed: Math.abs(measured - expected) <= tolerance };
};

const findProduct = (products, item) => products.find((p) => p._id.toString() === item.productId.toString());
const findVariant = (product, color) =>
  product?.variants.find((v) => v.color.toLowerCase() === String(color).toLowerCase());

// Sum of variant weights × quantity; null when any returned variant has no weight set
const expectedWeightFor = (items, products) => {
  let total = 0;
  for (const item of items) {
    const variant = findVariant(findProduct(products, item), item.color);
    if (!variant?.weight) return null;
    total += variant.weight * item.quantity;
  }
  return total;
};

// Other catalog products (different categories) make the label check meaningful:
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

// Who the box photo is compared with: the returned variants (expected), the other colours of
// those products, and other catalog products — look-alikes from the same category first.
const photoCandidates = async (items, products) => {
  const expected = [];
  const others = [];
  const expectedUrls = new Set();

  for (const item of items) {
    const product = findProduct(products, item);
    if (!product) continue;
    const variant = findVariant(product, item.color);
    const urls = variantUrls(variant).length ? variantUrls(variant) : product.variants.flatMap(variantUrls).slice(0, IMAGES_PER_ITEM);
    if (!urls.length) continue;
    urls.forEach((u) => expectedUrls.add(u));
    expected.push({ label: variant ? `${product.name} (${variant.color})` : product.name, urls, expected: true });
  }

  for (const product of products) {
    for (const v of product.variants) {
      const label = `${product.name} (${v.color})`;
      const urls = variantUrls(v).filter((u) => !expectedUrls.has(u)); // same photo for two colours tells nothing
      if (urls.length && !expected.some((c) => c.label === label)) others.push({ label, urls });
    }
  }

  const categories = new Set(products.map((p) => p.category));
  const pool = await productModel
    .find({ _id: { $nin: products.map((p) => p._id) }, hide: false })
    .select('name category variants')
    .sort({ 'rating.count': -1 })
    .lean();
  pool.sort((a, b) => categories.has(b.category) - categories.has(a.category)); // stable: keeps popularity order
  for (const product of pool) {
    if (others.length >= PHOTO_DISTRACTORS) break;
    const url = product.variants.flatMap(variantUrls).find((u) => !expectedUrls.has(u));
    if (url) others.push({ label: product.name, urls: [url] });
  }

  return { expected, others };
};

const photoMatch = async (boxVector, items, products) => {
  const none = { score: null, passed: null, similarity: null, closest: null, compared: 0 };
  const { expected, others } = await photoCandidates(items, products);
  if (!expected.length) return none;

  const scored = (
    await Promise.all(
      [...expected, ...others].map(async (c) => {
        const vectors = (await Promise.all(c.urls.map(embeddingForUrl))).filter(Boolean);
        return vectors.length ? { ...c, sim: Math.max(...vectors.map((v) => dot(v, boxVector))) } : null;
      })
    )
  ).filter(Boolean);
  if (!scored.some((c) => c.expected)) return none;

  // Softmax over best-photo similarities, like CLIP's own zero-shot scoring
  const top = Math.max(...scored.map((c) => c.sim));
  const weights = scored.map((c) => Math.exp(PHOTO_SCALE * (c.sim - top)));
  const total = weights.reduce((a, b) => a + b, 0);
  const score = scored.reduce((sum, c, i) => sum + (c.expected ? weights[i] : 0), 0) / total;
  const similarity = Math.max(...scored.filter((c) => c.expected).map((c) => c.sim));

  return {
    score: +score.toFixed(3),
    passed: score >= PHOTO_PASS && similarity >= PHOTO_MIN_SIMILARITY,
    similarity: +similarity.toFixed(3),
    closest: scored.find((c) => c.sim === top).label,
    compared: scored.length,
  };
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

  const expected = [...new Set(items.map((i) => findProduct(products, i)?.name || i.name))];
  const labels = [...expected, ...(await distractorLabels(products))];

  const classifier = await getClassifier();
  const image = await RawImage.fromBlob(new Blob([imageBuffer]));
  const [ranked, boxVector] = await Promise.all([
    classifier(image, labels, { hypothesis_template: 'a photo of {}' }),
    embedImage(image),
  ]);

  const score = ranked.filter((r) => expected.includes(r.label)).reduce((sum, r) => sum + r.score, 0);
  const visual = {
    score: +score.toFixed(3),
    passed: score >= VISUAL_PASS,
    topLabel: ranked[0]?.label ?? null,
    labels: ranked.slice(0, 5).map((r) => ({ label: r.label, score: +r.score.toFixed(3) })),
  };

  const photo = await photoMatch(boxVector, items, products);

  // The photo match decides when the product has catalog photos; the label check covers the
  // rest, and always catches an empty box or a hand in front of the camera.
  const photoSure = photo.passed === true && photo.similarity >= PHOTO_SURE_SIMILARITY;
  const notAnItem = GENERIC_DISTRACTORS.includes(visual.topLabel) && !photoSure;
  const imagePassed = !notAnItem && (photo.passed ?? visual.passed);

  const reasons = [];
  if (notAnItem) reasons.push(`Photo looks like ${visual.topLabel}`);
  else if (photo.passed === false && photo.score >= PHOTO_PASS) reasons.push(`Photo doesn't clearly show the returned item (similarity ${photo.similarity})`);
  else if (photo.passed === false) reasons.push(`Photo looks closer to "${photo.closest}" than to the returned item`);
  else if (photo.passed === null && !visual.passed) reasons.push(`Photo looks more like "${visual.topLabel}" than the returned product`);
  if (photo.passed === null) reasons.push('No catalog photo to compare with, checked by product name only');
  if (weight.passed === false) reasons.push(`Weight ${weight.measured} g, expected about ${weight.expected} g`);
  if (weight.passed === null) reasons.push(weight.expected == null ? 'No product weight set, weight not checked' : 'Box sent no weight reading');

  return {
    verdict: imagePassed && weight.passed !== false ? 'match' : 'review',
    reasons,
    visual,
    photo,
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
