/**
 * Cartify Database Seeder
 * Run: npm run seed
 */

import 'dotenv/config';
import mongoose      from 'mongoose';
import bcrypt        from 'bcryptjs';
import productModel  from './models/product.model.js';
import categoryModel from './models/category.model.js';
import userModel     from './models/user.model.js';
import counterModel  from './models/counter.model.js';

const DB_URI = process.env.DB_URL || process.env.DB_URL_ONLINE;

const slugify = (t = '') =>
  t.toLowerCase().replace(/&/g,'and').replace(/[^a-z0-9\s-]/g,'').trim().replace(/\s+/g,'-').replace(/-+/g,'-');

// ── CATEGORIES ────────────────────────────────────────────────────────────────
const CATEGORIES = [
  { name:'Electronics',    description:'High-performance gadgets.',                     icon:'fa-solid fa-microchip', displayOrder:1 },
  { name:'Fashion',        description:'Contemporary apparel and footwear.',            icon:'fa-solid fa-shirt',     displayOrder:2 },
  { name:'Home & Living',  description:'Furniture, lighting, and décor.',               icon:'fa-solid fa-house',     displayOrder:3 },
  { name:'Beauty',         description:'Makeup, skincare, and fine fragrances.',        icon:'fa-solid fa-spa',       displayOrder:4 },
  { name:'Accessories',    description:'Jewellery, eyewear, and everyday essentials.', icon:'fa-solid fa-gem',       displayOrder:5 },
  { name:'School Supplies',description:'Stationery, tools, and creative supplies.',     icon:'fa-solid fa-book',      displayOrder:6 },
];

// ── PRODUCTS ──────────────────────────────────────────────────────────────────
const img = (id) => `https://images.unsplash.com/photo-${id}?q=80&w=800`;

const PRODUCTS = [
  // ── Electronics ─────────────────────────────────────────────────────────
  { name:'Sonic Pro Wireless v2',      price:299, category:'Electronics', brand:'Soundcore',  discount:0,  raise:20, isFeatured:true,  rating:{average:4.5,count:128},  variants:[{color:'Black',colorHex:'#1a1a1a',stock:50,reserved:0,images:[{url:img('1505740420928-5e560c06d30e')}]},{color:'White',colorHex:'#ffffff',stock:30,reserved:0,images:[{url:img('1505740420928-5e560c06d30e')}]}], description:'Pro-grade wireless headphones with ANC and 40-hour battery.' },
  { name:'Smart Watch Series X',       price:449, category:'Electronics', brand:'TechVision', discount:0,  raise:20, isFeatured:true,  rating:{average:4.8,count:85},   variants:[{color:'Midnight Blue',colorHex:'#1a237e',stock:40,reserved:0,images:[{url:img('1546868871-7041f2a55e12')}]}],                                                                                                                                 description:'Advanced smartwatch with health tracking and GPS.' },
  { name:'Smart Lens Camera',          price:189, category:'Electronics', brand:'Lumix',      discount:0,  raise:20, isFeatured:false, rating:{average:4.7,count:210},  variants:[{color:'Black',colorHex:'#1a1a1a',stock:35,reserved:0,images:[{url:img('1516035069371-29a1b244cc32')}]}],                                                                                                                                 description:'Compact mirrorless camera with 24 MP sensor and 4K video.' },
  { name:'Soundcore R50i',             price:89,  category:'Electronics', brand:'Soundcore',  discount:0,  raise:20, isFeatured:false, rating:{average:4.6,count:94},   variants:[{color:'White',colorHex:'#ffffff',stock:60,reserved:0,images:[{url:img('1590658268037-6bf12165a8df')}]},{color:'Black',colorHex:'#1a1a1a',stock:45,reserved:0,images:[{url:img('1590658268037-6bf12165a8df')}]}],                          description:'True wireless earbuds with 30-hour playtime.' },
  { name:'PlayStation 5',              price:499, category:'Electronics', brand:'Sony',       discount:0,  raise:15, isFeatured:true,  rating:{average:5.0,count:4100}, variants:[{color:'White',colorHex:'#f5f5f5',stock:15,reserved:0,images:[{url:img('1606144042614-b2417e99c4e3')}]}],                                                                                                                                 description:'Next-gen gaming console with ultra-high speed SSD.' },
  { name:'Vision Curve Monitor',       price:399, category:'Electronics', brand:'Samsung',    discount:0,  raise:20, isFeatured:false, rating:{average:4.8,count:850},  variants:[{color:'Black',colorHex:'#1a1a1a',stock:20,reserved:0,images:[{url:img('1527443224154-c4a573d5f5ef')}]}],                                                                                                                                 description:'32" curved gaming monitor, 165 Hz, 1 ms response.' },
  { name:'Nexus Smartphone Z',         price:899, category:'Electronics', brand:'Nexus',      discount:5,  raise:20, isFeatured:true,  rating:{average:4.5,count:3100}, variants:[{color:'Phantom Black',colorHex:'#2c2c2c',stock:30,reserved:0,images:[{url:img('1511707171634-5f897ff02aa9')}]},{color:'Pearl White',colorHex:'#f8f8f8',stock:20,reserved:0,images:[{url:img('1511707171634-5f897ff02aa9')}]}],           description:'Flagship smartphone with 200 MP camera and Snapdragon 8 Gen 3.' },
  { name:'Sky-View Drone 4K',          price:1299,category:'Electronics', brand:'DJI',        discount:0,  raise:15, isFeatured:false, rating:{average:4.8,count:520},  variants:[{color:'Grey',colorHex:'#808080',stock:12,reserved:0,images:[{url:img('1473968512647-3e447244af8f')}]}],                                                                                                                                 description:'Professional drone with 4K camera and 30-min flight time.' },
  { name:'Zenith Air 13" M3',          price:1099,category:'Electronics', brand:'Zenith',     discount:0,  raise:20, isFeatured:true,  rating:{average:4.9,count:920},  variants:[{color:'Silver',colorHex:'#c0c0c0',stock:18,reserved:0,images:[{url:img('1496181133206-80ce9b88a853')}]},{color:'Midnight',colorHex:'#2c2c2c',stock:10,reserved:0,images:[{url:img('1496181133206-80ce9b88a853')}]}],                    description:'Ultra-thin laptop with M3 chip and 18-hour battery.' },
  { name:'Ghost Audio Elite',          price:159, category:'Electronics', brand:'Ghost',      discount:0,  raise:20, isFeatured:false, rating:{average:4.9,count:1100}, variants:[{color:'Black',colorHex:'#1a1a1a',stock:40,reserved:0,images:[{url:img('1484704849700-f032a568e944')}]}],                                                                                                                                 description:'Studio-quality over-ear headphones with Hi-Res certification.' },
  { name:'Pro Sound Wireless Headphone',price:149,category:'Electronics', brand:'Soundcore',  discount:0,  raise:20, isFeatured:true,  rating:{average:4.5,count:740},  variants:[{color:'Midnight Blue',colorHex:'#1a237e',stock:55,reserved:0,images:[{url:img('1505740420928-5e560c06d30e')}]},{color:'Pearl White',colorHex:'#f8f8f8',stock:35,reserved:0,images:[{url:img('1505740420928-5e560c06d30e')}]},{color:'Purple',colorHex:'#c9b8e8',stock:20,reserved:0,images:[{url:img('1505740420928-5e560c06d30e')}]}], description:'ANC headphones with 40-hour battery and spatial audio.' },
  { name:'Mini Projector 4K',          price:199, category:'Electronics', brand:'ViewSonic',  discount:0,  raise:20, isFeatured:false, rating:{average:4.8,count:230},  variants:[{color:'White',colorHex:'#ffffff',stock:22,reserved:0,images:[{url:img('1526040652367-ac003a0475fe')}]}],                                                                                                                                 description:'Portable 4K projector with 1000 lumens and built-in speaker.' },

  // ── Fashion ──────────────────────────────────────────────────────────────
  { name:'Basic Shirt',                price:29,  category:'Fashion', brand:'Basics Co.',  discount:0,  raise:25, isFeatured:false, rating:{average:4.5,count:128},  variants:[{color:'White',colorHex:'#ffffff',stock:100,reserved:0,images:[{url:img('1521572163474-6864f9cf17ab')}]},{color:'Black',colorHex:'#1a1a1a',stock:80,reserved:0,images:[{url:img('1521572163474-6864f9cf17ab')}]},{color:'Navy',colorHex:'#1a237e',stock:60,reserved:0,images:[{url:img('1521572163474-6864f9cf17ab')}]}], description:'Premium 100% cotton basic shirt for everyday wear.' },
  { name:'Nike Air Max',               price:499, category:'Fashion', brand:'Nike',        discount:0,  raise:15, isFeatured:true,  rating:{average:5.0,count:2451}, variants:[{color:'White/Red',colorHex:'#ff0000',stock:30,reserved:0,images:[{url:img('1542291026-7eec264c27ff')}]},{color:'Black/White',colorHex:'#1a1a1a',stock:25,reserved:0,images:[{url:img('1542291026-7eec264c27ff')}]}],           description:'Iconic running shoes with Air Max cushioning.' },
  { name:'Elite Scarf',                price:59,  category:'Fashion', brand:'LuxWear',     discount:0,  raise:25, isFeatured:false, rating:{average:4.5,count:84},   variants:[{color:'Camel',colorHex:'#c19a6b',stock:40,reserved:0,images:[{url:img('1520903920243-00d872a2d1c9')}]},{color:'Beige',colorHex:'#f5f5dc',stock:35,reserved:0,images:[{url:img('1520903920243-00d872a2d1c9')}]}],                   description:'Luxurious cashmere blend scarf.' },
  { name:'Leather Jacket',             price:79,  category:'Fashion', brand:'Moto Elite',  discount:39, raise:0,  isFeatured:true,  rating:{average:5.0,count:412},  variants:[{color:'Black',colorHex:'#1a1a1a',stock:20,reserved:0,images:[{url:img('1551028719-00167b16eac5')}]},{color:'Brown',colorHex:'#8B4513',stock:15,reserved:0,images:[{url:img('1551028719-00167b16eac5')}]}],                         description:'Classic genuine leather jacket with slim fit design.' },
  { name:"LEVI'S Classic Shirt",       price:159, category:'Fashion', brand:"LEVI'S",      discount:0,  raise:20, isFeatured:false, rating:{average:4.5,count:3100}, variants:[{color:'Denim Blue',colorHex:'#6699cc',stock:50,reserved:0,images:[{url:img('1602810318383-e386cc2a3ccf')}]}],                                                                                                                     description:"Authentic Levi's western shirt with iconic yoke detailing." },
  { name:'Jack & Jones Shirt',         price:129, category:'Fashion', brand:'Jack & Jones',discount:0,  raise:20, isFeatured:false, rating:{average:4.8,count:520},  variants:[{color:'White',colorHex:'#ffffff',stock:45,reserved:0,images:[{url:img('1607345366928-199ea26cfe3e')}]},{color:'Blue',colorHex:'#0000ff',stock:30,reserved:0,images:[{url:img('1607345366928-199ea26cfe3e')}]}],                     description:'Slim fit premium cotton shirt.' },
  { name:'Adidas Running Shoes',       price:249, category:'Fashion', brand:'Adidas',      discount:0,  raise:15, isFeatured:true,  rating:{average:4.9,count:1100}, variants:[{color:'Black/White',colorHex:'#1a1a1a',stock:30,reserved:0,images:[{url:img('1542291026-7eec264c27ff')}]},{color:'Grey',colorHex:'#808080',stock:20,reserved:0,images:[{url:img('1542291026-7eec264c27ff')}]}],                    description:'Lightweight Adidas running shoes with Boost midsole technology.' },
  { name:'Adidas All-White Classic',   price:199, category:'Fashion', brand:'Adidas',      discount:0,  raise:15, isFeatured:false, rating:{average:4.5,count:740},  variants:[{color:'White',colorHex:'#ffffff',stock:40,reserved:0,images:[{url:img('1560769629-975ec94e6a86')}]}],                                                                                                                              description:'Timeless all-white Adidas Stan Smith sneakers.' },

  // ── Home & Living ─────────────────────────────────────────────────────────
  { name:'Decorative Ceramic Vase Trio',price:450,category:'Home & Living', brand:'ArtHouse',   discount:0,  raise:20, isFeatured:false, rating:{average:4.5,count:42},   variants:[{color:'Cream White',colorHex:'#fffdd0',stock:25,reserved:0,images:[{url:img('1612600636169-7f4c7f1024f7')}]},{color:'Terracotta',colorHex:'#e2725b',stock:20,reserved:0,images:[{url:img('1612600636169-7f4c7f1024f7')}]}], description:'Elegant set of 3 ceramic vases for modern interiors.' },
  { name:'Scandinavian Living Room Set',price:885,category:'Home & Living', brand:'Nordic Home', discount:0,  raise:15, isFeatured:true,  rating:{average:5.0,count:156},  variants:[{color:'Natural Oak',colorHex:'#d2a679',stock:8, reserved:0,images:[{url:img('1555041469-a586c61ea9bc')}]},{color:'Grey',colorHex:'#808080',stock:5,reserved:0,images:[{url:img('1555041469-a586c61ea9bc')}]}],              description:'4-piece Scandinavian furniture set with natural oak finish.' },
  { name:'Modern Pleated Floor Lamp',  price:120, category:'Home & Living', brand:'Lumière',    discount:0,  raise:20, isFeatured:false, rating:{average:4.5,count:89},   variants:[{color:'Beige',colorHex:'#f5f5dc',stock:30,reserved:0,images:[{url:img('1540932239986-30128078f3c5')}]},{color:'Black',colorHex:'#1a1a1a',stock:25,reserved:0,images:[{url:img('1540932239986-30128078f3c5')}]}],              description:'Contemporary floor lamp with adjustable pleated shade.' },
  { name:'Minimalist Floating Shelf Set',price:45,category:'Home & Living', brand:'WoodCraft',  discount:31, raise:0,  isFeatured:false, rating:{average:5.0,count:310},  variants:[{color:'Walnut',colorHex:'#773f1a',stock:50,reserved:0,images:[{url:img('1555041469-a586c61ea9bc')}]},{color:'White',colorHex:'#ffffff',stock:40,reserved:0,images:[{url:img('1555041469-a586c61ea9bc')}]}],                  description:'Set of 3 walnut-finish floating shelves.' },
  { name:'Gaming Setup Bundle',        price:999, category:'Home & Living', brand:'GameZone',   discount:0,  raise:15, isFeatured:false, rating:{average:5.0,count:3300}, variants:[{color:'Black',colorHex:'#1a1a1a',stock:10,reserved:0,images:[{url:img('1593305841991-05c297ba4575')}]}],                                                                                                                     description:'Complete gaming desk setup with RGB lighting.' },
  { name:'White Ceramic Vases Set',    price:99,  category:'Home & Living', brand:'Ceramic Arts',discount:0, raise:20, isFeatured:false, rating:{average:4.8,count:230},  variants:[{color:'White',colorHex:'#ffffff',stock:35,reserved:0,images:[{url:img('1612600636169-7f4c7f1024f7')}]}],                                                                                                                     description:'Set of 3 hand-thrown white ceramic vases.' },

  // ── Beauty ───────────────────────────────────────────────────────────────
  { name:'Skincare Essential Set',     price:850, category:'Beauty', brand:'GlowLab',     discount:0,  raise:20, isFeatured:true,  rating:{average:4.5,count:128},  variants:[{color:'Normal Skin',colorHex:'#fde8d0',stock:30,reserved:0,images:[{url:img('1596462502278-27bfdc403348')}]},{color:'Oily Skin',colorHex:'#fde8d0',stock:25,reserved:0,images:[{url:img('1596462502278-27bfdc403348')}]}],           description:'Complete 5-step skincare routine.' },
  { name:'Pure Glow Skincare Set',     price:220, category:'Beauty', brand:'Pure Glow',   discount:0,  raise:20, isFeatured:true,  rating:{average:5.0,count:2451}, variants:[{color:'All Skin Types',colorHex:'#fde8d0',stock:45,reserved:0,images:[{url:img('1556228720-195a672e8a03')}]}],                                                                                                                     description:'Vitamin C-enriched skincare set for radiant skin.' },
  { name:'Minimal Luxe Essence',       price:145, category:'Beauty', brand:'Maison Luxe', discount:0,  raise:25, isFeatured:false, rating:{average:4.5,count:84},   variants:[{color:'50ml',colorHex:'#d4af37',stock:40,reserved:0,images:[{url:img('1541643600914-78b084683702')}]},{color:'100ml',colorHex:'#d4af37',stock:30,reserved:0,images:[{url:img('1541643600914-78b084683702')}]}],                     description:'Lightweight French perfume with jasmine and sandalwood notes.' },
  { name:'Pure Balance Face Cream',    price:65,  category:'Beauty', brand:'Pure Balance', discount:24, raise:0,  isFeatured:false, rating:{average:5.0,count:310},  variants:[{color:'Normal',colorHex:'#fde8d0',stock:60,reserved:0,images:[{url:img('1598440947619-2c35fc9aa908')}]}],                                                                                                                         description:'Oil-free hydrating face cream with hyaluronic acid.' },
  { name:'Portable Blackhead Remover', price:19,  category:'Beauty', brand:'SkinTech',    discount:0,  raise:20, isFeatured:false, rating:{average:5.0,count:3300}, variants:[{color:'White',colorHex:'#ffffff',stock:80,reserved:0,images:[{url:img('1620916566398-39f1143ab7be')}]},{color:'Pink',colorHex:'#ffb6c1',stock:70,reserved:0,images:[{url:img('1620916566398-39f1143ab7be')}]}],                    description:'Electric blackhead remover with 4 suction heads.' },
  { name:'Dove Beauty Bar Soap',       price:49,  category:'Beauty', brand:'Dove',        discount:0,  raise:20, isFeatured:false, rating:{average:5.0,count:1100}, variants:[{color:'Original',colorHex:'#fffff0',stock:120,reserved:0,images:[{url:img('1600857544200-b2f468e4e6e3')}]}],                                                                                                                      description:'Dove Beauty Bar with ¼ moisturising cream.' },

  // ── Accessories ───────────────────────────────────────────────────────────
  { name:'Elegant Gold Necklace',      price:58,  category:'Accessories', brand:'GoldArt',    discount:0,  raise:30, isFeatured:true,  rating:{average:4.5,count:42},   variants:[{color:'Gold',colorHex:'#ffd700',stock:50,reserved:0,images:[{url:img('1515562141207-7a88fb7ce338')}]},{color:'Rose Gold',colorHex:'#b76e79',stock:40,reserved:0,images:[{url:img('1515562141207-7a88fb7ce338')}]}],              description:'18K gold-plated necklace with cubic zirconia pendant.' },
  { name:'Luxury Diamond Earrings',    price:85,  category:'Accessories', brand:'DiamondLux', discount:0,  raise:30, isFeatured:true,  rating:{average:5.0,count:156},  variants:[{color:'Silver',colorHex:'#c0c0c0',stock:40,reserved:0,images:[{url:img('1535632066927-ab7c9ab60908')}]},{color:'Gold',colorHex:'#ffd700',stock:35,reserved:0,images:[{url:img('1535632066927-ab7c9ab60908')}]}],                description:'Sterling silver earrings with lab-grown diamond studs.' },
  { name:'Golden Ring Set',            price:50,  category:'Accessories', brand:'RingCraft',  discount:0,  raise:30, isFeatured:false, rating:{average:4.5,count:89},   variants:[{color:'Mixed',colorHex:'#ffd700',stock:60,reserved:0,images:[{url:img('1605100804763-247f67b3557e')}]}],                                                                                                                      description:'Set of 5 stackable rings in mixed finishes.' },
  { name:'Red Modern Sunglasses',      price:70,  category:'Accessories', brand:'Modo',       discount:18, raise:0,  isFeatured:false, rating:{average:5.0,count:310},  variants:[{color:'Red',colorHex:'#ff0000',stock:35,reserved:0,images:[{url:img('1572635196237-14b3f281503f')}]},{color:'Black',colorHex:'#1a1a1a',stock:30,reserved:0,images:[{url:img('1572635196237-14b3f281503f')}]}],                  description:'Oversized sunglasses with UV400 protection.' },
  { name:'Gold Plated Bangle Bracelet',price:399, category:'Accessories', brand:'GoldArt',    discount:0,  raise:20, isFeatured:false, rating:{average:5.0,count:3300}, variants:[{color:'Gold',colorHex:'#ffd700',stock:30,reserved:0,images:[{url:img('1611085583191-a3b181a88401')}]},{color:'Rose Gold',colorHex:'#b76e79',stock:25,reserved:0,images:[{url:img('1611085583191-a3b181a88401')}]}],              description:'18K gold plated stainless steel bangle bracelet.' },

  // ── School Supplies ───────────────────────────────────────────────────────
  { name:'Composition Notebook',       price:8,   category:'School Supplies', brand:'Mead',          discount:0,  raise:30, isFeatured:false, rating:{average:4.5,count:42},   variants:[{color:'Black/White',colorHex:'#1a1a1a',stock:200,reserved:0,images:[{url:img('1544716278-ca5e3f4abd8c')}]},{color:'Blue',colorHex:'#0000ff',stock:150,reserved:0,images:[{url:img('1544716278-ca5e3f4abd8c')}]}],          description:'200-page wide-ruled composition notebook.' },
  { name:'Hipolymer Pencil Eraser',    price:5,   category:'School Supplies', brand:'Pentel',         discount:0,  raise:30, isFeatured:false, rating:{average:5.0,count:156},  variants:[{color:'White',colorHex:'#ffffff',stock:300,reserved:0,images:[{url:img('1611532736597-de2d4265fba3')}]}],                                                                                                                description:'Non-abrasive polymer eraser.' },
  { name:'Coloring Set 36 Colors',     price:5,   category:'School Supplies', brand:'Faber-Castell',  discount:0,  raise:25, isFeatured:false, rating:{average:4.5,count:89},   variants:[{color:'Assorted',colorHex:'#ff6600',stock:80,reserved:0,images:[{url:img('1513542789411-b6a5d4f31634')}]}],                                                                                                             description:'Professional 36-piece coloring set.' },
  { name:'Minimalist Pencil Case',     price:30,  category:'School Supplies', brand:'MiniCase',       discount:54, raise:0,  isFeatured:true,  rating:{average:5.0,count:310},  variants:[{color:'Beige',colorHex:'#f5f5dc',stock:70,reserved:0,images:[{url:img('1553062407-98eeb64c6a62')}]},{color:'Black',colorHex:'#1a1a1a',stock:60,reserved:0,images:[{url:img('1553062407-98eeb64c6a62')}]},{color:'Pink',colorHex:'#ffb6c1',stock:50,reserved:0,images:[{url:img('1553062407-98eeb64c6a62')}]}], description:'Slim canvas pencil case with zipper closure.' },
  { name:'Roto Ballpoint Pen Set',     price:1,   category:'School Supplies', brand:'Roto',           discount:0,  raise:30, isFeatured:false, rating:{average:4.5,count:3100}, variants:[{color:'Blue',colorHex:'#0000ff',stock:500,reserved:0,images:[{url:img('1583485088034-697b5bc54ccd')}]},{color:'Black',colorHex:'#1a1a1a',stock:400,reserved:0,images:[{url:img('1583485088034-697b5bc54ccd')}]}],         description:'Pack of 12 smooth-writing ballpoint pens.' },
  { name:'Faber-Castell Apple Sharpener',price:9, category:'School Supplies', brand:'Faber-Castell',  discount:0,  raise:25, isFeatured:false, rating:{average:5.0,count:1100}, variants:[{color:'Red',colorHex:'#ff0000',stock:150,reserved:0,images:[{url:img('1583485088034-697b5bc54ccd')}]},{color:'Green',colorHex:'#008000',stock:120,reserved:0,images:[{url:img('1583485088034-697b5bc54ccd')}]}],          description:'Apple-shaped sharpener with removable shavings container.' },
  { name:'Spiral A4 Notebook',         price:2,   category:'School Supplies', brand:'Mead',           discount:0,  raise:30, isFeatured:false, rating:{average:4.8,count:520},  variants:[{color:'Blue',colorHex:'#0000ff',stock:200,reserved:0,images:[{url:img('1544716278-ca5e3f4abd8c')}]},{color:'Red',colorHex:'#ff0000',stock:150,reserved:0,images:[{url:img('1544716278-ca5e3f4abd8c')}]}],                description:'200-page A4 spiral notebook with 5 mm grid paper.' },
  { name:'Desk Organizer Mesh Set',    price:19,  category:'School Supplies', brand:'OfficePro',      discount:0,  raise:20, isFeatured:false, rating:{average:4.8,count:230},  variants:[{color:'Black',colorHex:'#1a1a1a',stock:40,reserved:0,images:[{url:img('1518455027359-f3f8164ba6bd')}]},{color:'Silver',colorHex:'#c0c0c0',stock:30,reserved:0,images:[{url:img('1518455027359-f3f8164ba6bd')}]}],         description:'Multi-compartment mesh desk organizer.' },
];

// ── SEED ──────────────────────────────────────────────────────────────────────
const seed = async () => {
  try {
    await mongoose.connect(DB_URI);
    console.log('✅  MongoDB connected');

    await Promise.all([
      productModel.deleteMany({}),
      categoryModel.deleteMany({}),
      userModel.deleteMany({ role: { $ne: 'admin' } }),
      counterModel.deleteMany({}),
    ]);
    console.log('🗑   Cleared products, categories, counters');

    // Categories
    const catDocs = CATEGORIES.map((c) => ({ ...c, slug: slugify(c.name), bannerText:'PREMIUM COLLECTION', productCount:0, isActive:true }));
    const createdCats = await categoryModel.insertMany(catDocs);
    console.log(`📁  Seeded ${createdCats.length} categories`);

    // Products — deduplicate slugs within batch
    const usedSlugs = new Set();
    const productDocs = PRODUCTS.map((p) => {
      let slug = slugify(p.name);
      if (usedSlugs.has(slug)) slug = `${slug}-${Date.now()}-${Math.floor(Math.random()*1000)}`;
      usedSlugs.add(slug);
      return { ...p, slug };
    });
    const createdProducts = await productModel.insertMany(productDocs);
    console.log(`📦  Seeded ${createdProducts.length} products`);

    // Update category productCounts
    for (const cat of createdCats) {
      const count = await productModel.countDocuments({ category: { $regex: cat.name, $options: 'i' } });
      await categoryModel.findByIdAndUpdate(cat._id, { productCount: count });
    }
    console.log('🔢  Updated category product counts');

    // Admin user
    const adminExists = await userModel.findOne({ email: 'admin@cartify.com' });
    if (!adminExists) {
      await userModel.create({
        email: 'admin@cartify.com',
        password: await bcrypt.hash('Admin@12345', 12),
        firstName: 'Cartify', lastName: 'Admin',
        role: 'admin', isVerified: true, membershipTier: 'PLATINUM',
      });
      console.log('👤  Admin created: admin@cartify.com / Admin@12345');
    } else {
      console.log('👤  Admin already exists — skipped');
    }

    // Order counter
    await counterModel.findOneAndUpdate({ _id:'order' }, { $setOnInsert:{ seq:0 } }, { upsert:true });
    console.log('🔢  Order counter initialised');

    console.log('\n✨  Seeding complete!\n');
  } catch (err) {
    console.error('❌  Seeding failed:', err.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('🔌  Disconnected');
  }
};

seed();
