// Tools of the Cartify Shopping Assistant. Each one calls the existing public/customer REST API
// with the customer's own credentials, then trims the response to what the model needs.
// Product cards, comparison tables, cart and order cards are returned to the UI as structured
// "blocks" built from these API responses — never from model-written text.
import { randomUUID } from 'crypto';
import { callApi, ToolError } from './internalApi.js';
import { objectIdSchema } from './toolSchema.js';

const CURRENCY = 'USD ($), as listed in the store';
const ACTION_TTL_MS = 15 * 60_000;
const productId = objectIdSchema('Product id (24 hex characters) from an earlier tool result');
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const available = (v) => Math.max(0, (v.stock || 0) - (v.reserved || 0));
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');

export function compactProduct(p, { long = false } = {}) {
  const variants = p.variants || [];
  return {
    id: p._id,
    name: p.name,
    brand: p.brand || null,
    category: p.category,
    price: p.finalPrice,
    ...(p.discount > 0 ? { listPrice: p.price, discountPct: p.discount } : {}),
    rating: p.rating?.average ?? null,
    reviews: p.rating?.count ?? 0,
    inStock: variants.some((v) => available(v) > 0),
    colors: variants.map((v) => ({ color: v.color, available: available(v) })),
    ...(p.tags?.length ? { tags: p.tags } : {}),
    description: clip(p.description, long ? 1200 : 220),
  };
}

// Data for one product card in the chat (same fields the store's product cards show).
export function cardData(p) {
  const variants = p.variants || [];
  const first = variants.find((v) => available(v) > 0) || variants[0];
  return {
    id: p._id, name: p.name, brand: p.brand || null, category: p.category,
    price: p.finalPrice, oldPrice: p.discount > 0 ? p.price : null, discount: p.discount || 0,
    rating: p.rating?.average || 0, reviews: p.rating?.count || 0,
    image: first?.images?.[0]?.url || variants[0]?.images?.[0]?.url || '',
    defaultColor: first?.color || null, colors: variants.map((v) => v.color), variantCount: variants.length,
    inStock: variants.some((v) => available(v) > 0),
  };
}

const getProduct = async (api, id) => (await callApi(api, 'GET', `/products/${id}`)).product;

// Resolve a product name (as the customer wrote it) to one catalog product via the public search API:
// exact name first, then the closest containing match. Returns null when nothing matches.
async function findByName(api, name) {
  const sq = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const res = await callApi(api, 'GET', '/products', { query: { search: name, limit: 10 } }).catch(() => null);
  const list = res?.products || [];
  const q = sq(name);
  const hit = list.find((p) => sq(p.name) === q) || list.find((p) => sq(p.name).includes(q) || q.includes(sq(p.name)));
  return hit ? getProduct(api, hit._id).catch(() => hit) : null;
}

// Products returned by tools during this turn, so the products the reply recommends can be shown
// as real catalog cards even if the model does not call show_products itself.
const remember = (ctx, products) => {
  if (!ctx.seen) return;
  for (const p of products) if (p?._id) ctx.seen.set(String(p._id), p);
};

const STATUS_LABEL = { placed: 'Placed', confirmed: 'Confirmed', shipping: 'On the way', delivered: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded' };
const compactOrder = (o) => ({
  orderNumber: o.randomId,
  placedAt: o.createdAt,
  status: o.status,
  statusLabel: STATUS_LABEL[o.status] || o.status,
  total: o.totalPrice,
  itemCount: (o.products || []).reduce((a, i) => a + (i.quantity || 0), 0),
  items: (o.products || []).map((i) => `${i.name} (${i.color}) × ${i.quantity}`),
});

export const shoppingTools = [
  {
    name: 'get_catalog_overview',
    description: 'List the store categories (with product counts) and brands. Use it to map a customer request to a category name before searching.',
    input_schema: obj({}),
    handler: async (_input, { api }) => {
      const [c, b] = await Promise.all([callApi(api, 'GET', '/products/categories'), callApi(api, 'GET', '/products/brands')]);
      return { data: { categories: c.categories, brands: b.brands.map((x) => x.brand), currency: CURRENCY } };
    },
  },
  {
    name: 'search_products',
    description: 'Search the live Cartify catalog. Each keyword is matched literally against product name, brand, category and description, and the results of all keywords are merged (a product matching more keywords ranks higher). Prices are final selling prices in $. Returns at most `limit` products.',
    input_schema: obj({
      keywords: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 5, description: 'Short keywords or synonyms, e.g. ["laptop", "notebook"]. Omit to browse by category/brand only.' },
      category: { type: 'string', maxLength: 60, description: 'Exact category name, e.g. "Electronics"' },
      brand: { type: 'string', maxLength: 60 },
      minPrice: { type: 'number', minimum: 0, description: 'Minimum final price in $' },
      maxPrice: { type: 'number', minimum: 0, description: 'Maximum final price in $ (the customer budget)' },
      color: { type: 'string', maxLength: 40 },
      inStockOnly: { type: 'boolean', default: true },
      sort: { type: 'string', enum: ['relevance', 'price_asc', 'price_desc', 'rating', 'newest'], default: 'relevance' },
      limit: { type: 'integer', minimum: 1, maximum: 10, default: 6 },
    }),
    handler: async ({ keywords = [], category, brand, minPrice, maxPrice, color, inStockOnly = true, sort = 'relevance', limit = 6 }, ctx) => {
      const { api } = ctx;
      const isArabic = (t) => /[\u0600-\u06FF]/.test(t);
      const allTerms = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))];
      if (allTerms.length && allTerms.every(isArabic)) {
        throw new ToolError('The catalog is in English. Call search_products again with ENGLISH keywords (for example "سماعات" -> "headphones", "ساعة ذكية" -> "smart watch").');
      }
      const terms = allTerms.filter((t) => !isArabic(t));
      const notes = [];
      const apiSort = sort === 'relevance' ? 'rating' : sort;
      const fetchSlice = (q, search) => callApi(api, 'GET', '/products', { query: { ...q, search, sort: apiSort, limit: 100 } });
      // A brand/category/colour filter that matches nothing (e.g. brand "Ghost Audio" vs "Ghost") is dropped.
      let filters = { category, brand, color };
      let all = await fetchSlice(filters);
      for (const key of ['brand', 'color', 'category']) {
        if (!all.products.length && filters[key]) {
          notes.push(`No products for ${key} "${filters[key]}", so that filter was ignored.`);
          filters = { ...filters, [key]: undefined };
          all = await fetchSlice(filters);
        }
      }
      // 1) the store's own search (literal text match), one call per keyword
      const pages = await Promise.all((terms.length ? terms : [null]).map((t) => fetchSlice(filters, t || undefined)));
      // 2) plus looser matches: ignoring spaces/hyphens ("smartwatch" = "Smart Watch") and word by word
      //    with simple singulars ("wireless headphones" -> "wireless", "headphone")
      const norm = (t) => String(t || '').toLowerCase();
      const squash = (t) => norm(t).replace(/[\s\-_]+/g, '');
      const stem = (w) => (w.length > 4 ? w.replace(/(es|s)$/, '') : w);
      const textOf = (p) => norm(`${p.name} ${p.brand} ${p.category} ${(p.tags || []).join(' ')} ${p.description}`);
      terms.forEach((t, i) => {
        const words = norm(t).split(/\s+/).filter((w) => w.length >= 3).map(stem);
        // every word of a 1-2 word phrase ("smart watch" must not match a "Smart Lens Camera"),
        // all but one word of a longer phrase
        const need = words.length <= 2 ? words.length : words.length - 1;
        const scored = all.products.map((p) => {
          const tx = textOf(p);
          const whole = squash(tx).includes(squash(stem(t)));
          const hits = words.filter((w) => tx.includes(w)).length;
          return { p, score: whole ? words.length + 1 : hits };
        }).filter((m) => m.score > 0 && m.score >= need).sort((a, b) => b.score - a.score);
        const seenIds = new Set(pages[i].products.map((p) => String(p._id)));
        pages[i] = { products: [...pages[i].products, ...scored.map((m) => m.p).filter((p) => !seenIds.has(String(p._id)))] };
      });
      const merged = new Map();
      pages.forEach((page) => page.products.forEach((p, i) => {
        const hit = merged.get(p._id) || { p, hits: 0, rank: i };
        hit.hits += 1;
        hit.rank = Math.min(hit.rank, i);
        merged.set(p._id, hit);
      }));
      let list = [...merged.values()].filter(({ p }) =>
        (minPrice === undefined || p.finalPrice >= minPrice) && (maxPrice === undefined || p.finalPrice <= maxPrice) &&
        (!inStockOnly || (p.variants || []).some((v) => available(v) > 0)));
      const by = {
        relevance: (a, b) => b.hits - a.hits || (b.p.rating?.average || 0) - (a.p.rating?.average || 0),
        price_asc: (a, b) => a.p.finalPrice - b.p.finalPrice,
        price_desc: (a, b) => b.p.finalPrice - a.p.finalPrice,
        rating: (a, b) => (b.p.rating?.average || 0) - (a.p.rating?.average || 0),
        newest: (a, b) => a.rank - b.rank,
      };
      list.sort(by[sort]);
      remember(ctx, list.slice(0, limit).map(({ p }) => p));
      return {
        data: {
          currency: CURRENCY, totalMatches: list.length, returned: Math.min(limit, list.length),
          appliedFilters: { keywords: terms, ...filters, minPrice, maxPrice, inStockOnly },
          products: list.slice(0, limit).map(({ p }) => compactProduct(p)),
          ...(notes.length ? { notes } : {}),
          ...(list.length ? {} : { hint: 'Nothing matched. Try other keywords, a category, or a wider budget.' }),
        },
      };
    },
  },
  {
    name: 'get_product_details',
    description: 'Full details of one product: description, price, colours with stock, rating and the latest reviews.',
    input_schema: obj({ productId }, ['productId']),
    handler: async ({ productId: id }, ctx) => {
      const { api } = ctx;
      const [p, r] = await Promise.all([getProduct(api, id), callApi(api, 'GET', `/products/${id}/reviews`, { query: { limit: 3 } }).catch(() => ({ reviews: [] }))]);
      remember(ctx, [p]);
      return {
        data: {
          currency: CURRENCY, product: compactProduct(p, { long: true }),
          latestReviews: (r.reviews || []).map((x) => ({ rating: x.rating, title: clip(x.title, 80), text: clip(x.body, 240), verifiedPurchase: !!x.isVerifiedPurchase })),
        },
      };
    },
  },
  {
    name: 'compare_products',
    description: 'Compare 2 to 4 products side by side (price, discount, rating, brand, category, colours in stock, description). The customer sees the comparison as a table. Pass productIds from an earlier tool result, or productNames (exact catalog names) when you have no ids yet.',
    input_schema: obj({
      productIds: { type: 'array', items: productId, minItems: 2, maxItems: 4, uniqueItems: true },
      productNames: { type: 'array', items: { type: 'string', minLength: 2, maxLength: 120 }, minItems: 2, maxItems: 4, uniqueItems: true, description: 'Product names as the customer or an earlier tool result wrote them' },
    }),
    handler: async ({ productIds, productNames }, ctx) => {
      const { api } = ctx;
      if (!productIds?.length && !productNames?.length) throw new ToolError('Pass productIds (from search_products) or productNames');
      const products = productIds?.length
        ? await Promise.all(productIds.map((id) => getProduct(api, id).catch(() => null)))
        : await Promise.all(productNames.map((n) => findByName(api, n)));
      const asked = productIds?.length ? productIds : productNames;
      const found = products.filter(Boolean);
      if (found.length < 2) {
        throw new ToolError(productIds?.length
          ? 'These product ids are not in the catalog. Never invent ids: call search_products with the product names first and use the ids it returns.'
          : `Could not find at least two of these products: ${asked.join(', ')}. Call search_products to find the exact names.`);
      }
      remember(ctx, found);
      const rows = found.map((p) => ({ ...compactProduct(p, { long: true }), card: cardData(p) }));
      return {
        data: { currency: CURRENCY, products: rows.map(({ card, ...r }) => r), missing: asked.filter((_, i) => !products[i]) },
        block: { type: 'comparison', products: rows.map((r) => ({ ...r.card, inStockColors: r.colors.filter((c) => c.available > 0).map((c) => c.color), description: clip(r.description, 160) })) },
      };
    },
  },
  {
    name: 'check_product_availability',
    description: 'Check if a product (optionally a specific colour and quantity) can be ordered now.',
    input_schema: obj({ productId, color: { type: 'string', maxLength: 40 }, quantity: { type: 'integer', minimum: 1, maximum: 50, default: 1 } }, ['productId']),
    handler: async ({ productId: id, color, quantity = 1 }, { api }) => {
      const p = await getProduct(api, id);
      const colors = (p.variants || []).map((v) => ({ color: v.color, available: available(v) }));
      const chosen = color ? colors.find((c) => c.color.toLowerCase() === color.toLowerCase()) : null;
      return {
        data: {
          product: p.name, requested: { color: chosen?.color || color || null, quantity },
          canOrder: chosen ? chosen.available >= quantity : colors.some((c) => c.available >= quantity),
          ...(color && !chosen ? { note: `"${color}" is not a colour of this product` } : {}),
          colors,
        },
      };
    },
  },
  {
    name: 'get_cart',
    description: "Show the customer's current cart: items, quantities, prices and subtotal.",
    input_schema: obj({}),
    handler: async (_input, { api }) => {
      const res = await callApi(api, 'GET', '/cart');
      const items = (res.cart?.items || []).filter((i) => i.productId).map((i) => ({
        productId: i.productId._id, name: i.productId.name, color: i.color, quantity: i.quantity, unitPrice: i.productId.finalPrice,
        lineTotal: +(i.productId.finalPrice * i.quantity).toFixed(2), image: cardData(i.productId).image,
      }));
      const data = { currency: CURRENCY, items: items.map(({ image, ...x }) => x), totalQuantity: res.totalQuantity, subtotal: res.subtotal, note: 'Shipping is added at checkout depending on the governorate.' };
      return { data, block: { type: 'cart', items, totalQuantity: res.totalQuantity, subtotal: res.subtotal } };
    },
  },
  {
    name: 'add_to_cart',
    description: 'Prepare adding a product to the cart. Nothing is added yet: the customer sees a confirmation card and must press Confirm. Use only after the customer asked to add it. A colour is required when the product has several.',
    input_schema: obj({ productId, color: { type: 'string', maxLength: 40, description: 'One of the product colours' }, quantity: { type: 'integer', minimum: 1, maximum: 10, default: 1 } }, ['productId']),
    handler: async ({ productId: id, color, quantity = 1 }, { api, conversation }) => {
      const p = await getProduct(api, id);
      const variants = p.variants || [];
      let variant = color ? variants.find((v) => v.color.toLowerCase() === color.toLowerCase()) : variants.length === 1 ? variants[0] : null;
      if (!variant) throw new ToolError(color ? `"${color}" is not available for ${p.name}. Colours: ${variants.map((v) => v.color).join(', ')}` : `Ask the customer to choose a colour: ${variants.map((v) => v.color).join(', ')}`);
      if (available(variant) < quantity) throw new ToolError(`Only ${available(variant)} of ${p.name} (${variant.color}) available`);
      const actionId = randomUUID();
      const summary = `Add ${quantity} × ${p.name} (${variant.color}) to the cart — $${(p.finalPrice * quantity).toFixed(2)}`;
      conversation.pendingActions.forEach((a) => { if (a.status === 'pending' && a.type === 'add_to_cart') a.status = 'expired'; });
      conversation.pendingActions.push({ actionId, type: 'add_to_cart', payload: { productId: id, productName: p.name, color: variant.color, quantity }, summary, expiresAt: new Date(Date.now() + ACTION_TTL_MS) });
      return {
        data: { status: 'awaiting_customer_confirmation', actionId, summary, note: 'NOT added yet. Say that you prepared it and that the customer must press Confirm on the card to add it. Never say it was added.' },
        block: { type: 'confirm_action', actionId, kind: 'add_to_cart', title: 'Add to cart?', summary, product: cardData(p), color: variant.color, quantity, lineTotal: +(p.finalPrice * quantity).toFixed(2) },
      };
    },
  },
  {
    name: 'get_my_orders',
    description: "List the customer's own recent orders (newest first) with status and totals. Returns only orders of the person in this chat.",
    input_schema: obj({ limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 }, status: { type: 'string', enum: ['placed', 'confirmed', 'shipping', 'delivered', 'cancelled', 'refunded'] } }),
    handler: async ({ limit = 5, status }, { api }) => {
      const res = await callApi(api, 'GET', '/orders/my', { query: { limit: 50 } });
      const orders = (res.orders || []).filter((o) => !status || o.status === status).slice(0, limit).map(compactOrder);
      return { data: { signedIn: !!api.user, totalOrders: res.total, orders, ...(orders.length ? {} : { note: api.user ? 'No orders found in this account.' : 'No orders in this guest session. Orders placed while signed in need the customer to sign in.' }) } };
    },
  },
  {
    name: 'track_order',
    description: 'Get the status and history of one of the customer\'s own orders by its order number (the 6-character code shown on the order, e.g. "A1B2C3").',
    input_schema: obj({ orderNumber: { type: 'string', minLength: 4, maxLength: 12 } }, ['orderNumber']),
    handler: async ({ orderNumber }, { api }) => {
      const code = orderNumber.replace(/^#/, '').trim().toUpperCase();
      const mine = await callApi(api, 'GET', '/orders/my', { query: { limit: 50 } });
      const hit = (mine.orders || []).find((o) => String(o.randomId).toUpperCase() === code);
      if (!hit) return { data: { found: false, orderNumber: code, note: `No order #${code} in ${api.user ? 'this account' : 'this guest session'}. Check the number${api.user ? '' : ' or sign in'}.` } };
      const { order: o } = await callApi(api, 'GET', `/orders/${hit._id}`);
      const data = {
        found: true, ...compactOrder(o), orderId: o._id,
        history: (o.statusHistory || []).map((h) => ({ status: h.status, label: STATUS_LABEL[h.status] || h.status, at: h.changedAt })),
        trackingNumber: o.trackingNumber || null, paymentMethod: o.paymentMethod, isPaid: !!o.isPaid,
        shipping: { city: o.city, governorate: o.governorate, cost: o.shippingCost },
      };
      return { data, block: { type: 'order', order: data } };
    },
  },
  {
    name: 'get_shopping_profile',
    description: "The customer's own purchase history (categories, brands) and wishlist, to personalise recommendations. Only this customer's data.",
    input_schema: obj({}),
    handler: async (_input, { api }) => {
      const [orders, wish] = await Promise.all([
        callApi(api, 'GET', '/orders/my', { query: { limit: 20 } }).catch(() => ({ orders: [] })),
        callApi(api, 'GET', '/wishlist').catch(() => ({ wishList: { items: [] } })),
      ]);
      const ids = [...new Set((orders.orders || []).flatMap((o) => (o.products || []).map((i) => String(i.productId?._id || i.productId))))].slice(0, 10);
      const bought = (await Promise.all(ids.map((id) => getProduct(api, id).catch(() => null)))).filter(Boolean);
      const count = (arr) => Object.entries(arr.reduce((m, k) => ({ ...m, [k]: (m[k] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1]).map(([k]) => k);
      return {
        data: {
          signedIn: !!api.user, orders: (orders.orders || []).length,
          recentPurchases: bought.map((p) => ({ id: p._id, name: p.name, category: p.category, brand: p.brand })),
          topCategories: count(bought.map((p) => p.category)).slice(0, 3), topBrands: count(bought.map((p) => p.brand).filter(Boolean)).slice(0, 3),
          wishlist: (wish.wishList?.items || []).filter((i) => i.productId?._id).slice(0, 10).map((i) => ({ id: i.productId._id, name: i.productId.name, category: i.productId.category, price: i.productId.finalPrice })),
        },
      };
    },
  },
  {
    name: 'show_products',
    description: 'Display product cards to the customer for the products you recommend (ids from earlier tool results, best first). Call this whenever you recommend specific products.',
    input_schema: obj({ productIds: { type: 'array', items: productId, minItems: 1, maxItems: 6, uniqueItems: true }, title: { type: 'string', maxLength: 60, description: 'Optional short heading, e.g. "Laptops under $1,100"' } }, ['productIds']),
    handler: async ({ productIds, title }, { api }) => {
      const products = await Promise.all(productIds.map((id) => getProduct(api, id).catch(() => null)));
      const found = products.filter(Boolean);
      const cards = found.map(cardData);
      if (!cards.length) throw new ToolError('None of these products exist');
      // `fullProducts` are the catalog objects as GET /products/:id returns them, so the mobile app
      // can render its existing ProductCard component unchanged.
      return { data: { shown: cards.length, missing: productIds.filter((id, i) => !products[i]) }, block: { type: 'products', title: title || null, products: cards, fullProducts: found } };
    },
  },
];
