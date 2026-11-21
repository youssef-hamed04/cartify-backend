// End-to-end test of the SmartBox flow against a running backend.
//   Offline box (current hardware): the Arduino checks the code itself, then the ESP32-CAM uploads
//   the photo with the locker ID typed on the keypad.
//   Online check: the box asks /returns/validate-code, then uploads with the returnId it got back.
// It creates returns and, when a JPEG path is given, uploads photos to Cloudinary; all of it is deleted at the end.
// Usage: node tests/smartbox.flow.mjs [baseUrl] [path/to/photo.jpg]   (DEVICE_API_KEY is read from .env)
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import mongoose from 'mongoose';

const BASE = process.argv[2] || process.env.API_URL || 'http://localhost:3001';
const PHOTO = process.argv[3];
const KEY = process.env.DEVICE_API_KEY;
const SECRET = Number(process.env.LOCKER_CODE_SECRET) || 7257;
let pass = 0;
let fail = 0;
const createdReturns = [];
const cameraSessions = [];

function check(name, condition, info = '') {
  if (condition) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${typeof info === 'string' ? info : JSON.stringify(info).slice(0, 300)}`); }
}

async function call(method, path, { body, headers = {} } = {}) {
  const isJson = body !== undefined && !(body instanceof Buffer);
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(isJson ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: isJson ? JSON.stringify(body) : body,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// The Arduino sketch, written out independently: ((ID + RTC day) % 10000) + SECRET_KEY, RTC on Egypt time
const arduinoCode = (lockerUserId) => {
  const day = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', day: 'numeric' }).format(new Date()));
  return ((Number(lockerUserId) + day) % 10000) + SECRET;
};
const run = Date.now().toString(36);
const BOX_A = `test-a-${run}`;
const BOX_B = `test-b-${run}`;
const BOX_C = `test-c-${run}`;
const box = (boxId) => ({ 'X-Device-Key': KEY, 'X-Box-Id': boxId });
const jpeg = PHOTO ? readFileSync(PHOTO) : null;
const upload = (boxId, ids) => call('POST', '/camera/upload', {
  body: jpeg || Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  headers: { ...box(boxId), 'Content-Type': 'image/jpeg', 'X-Weight': '350.25', 'X-Firmware-Version': 'test', ...ids },
});

if (!KEY) { console.error('DEVICE_API_KEY is not set in .env'); process.exit(1); }
const products = await call('GET', '/products?limit=1');
const product = products.data.products?.[0];
async function createReturn() {
  const r = await call('POST', '/returns', {
    body: { reason: 'other', notes: 'SmartBox flow test', items: [{ productId: product._id, name: product.name, color: 'Default', quantity: 1 }] },
  });
  if (r.status === 201 && r.data.returnRequest?._id) createdReturns.push(r.data.returnRequest._id);
  return r;
}

// ── 1. Offline box: Arduino checks the code, ESP32-CAM uploads with the locker ID
console.log('Offline box (Arduino checks the code)');
let r = await createReturn();
const offline = r.data.returnRequest;
check('customer creates a return', r.status === 201 && offline?.lockerUserId, r.data);
check('code shown in the app = code the Arduino computes', Number(offline.unlockCode) === arduinoCode(offline.lockerUserId),
  { app: offline.unlockCode, arduino: arduinoCode(offline.lockerUserId) });

r = await upload(BOX_A, {});
check('upload without a locker ID or return ID is refused', r.status === 400, r.data);
r = await call('POST', '/camera/upload', { body: Buffer.from([0xff, 0xd8]), headers: { 'X-Box-Id': BOX_A, 'Content-Type': 'image/jpeg', 'X-Locker-User-Id': offline.lockerUserId } });
check('upload without the device key is refused', r.status === 401);
r = await upload(BOX_A, { 'X-Locker-User-Id': '1' });
check('unknown locker ID -> 404', r.status === 404, r.data);

if (jpeg) {
  r = await upload(BOX_A, { 'X-Locker-User-Id': offline.lockerUserId });
  if (r.data.sessionId) cameraSessions.push(r.data.sessionId);
  check('photo with the keypad locker ID is accepted for the right return',
    r.status === 200 && r.data.returnId === offline._id && !!r.data.imageUrl, r.data);
  await mongoose.connect(process.env.DB_URL);
  const stored = await mongoose.connection.collection('returns').findOne({ _id: new mongoose.Types.ObjectId(offline._id) });
  check('the return is now completed, with the weight and box', stored.status === 'completed' && stored.weight === 350.25 && stored.processedByBox === BOX_A, stored);
  r = await upload(BOX_A, { 'X-Locker-User-Id': offline.lockerUserId });
  if (r.data.sessionId) cameraSessions.push(r.data.sessionId);
  check('a retry from the same box within the window is accepted', r.status === 200 && r.data.returnId === offline._id, r.data);
  r = await upload(BOX_B, { 'X-Return-Id': offline._id });
  check('another box cannot add photos to it', r.status === 409, r.data);
} else {
  console.log('  skip photo uploads (pass a JPEG path as the 2nd argument to test them)');
}

// ── 2. Online check: the box asks the server, then uploads with the returnId
console.log('Online check (box asks the server)');
r = await createReturn();
const online = r.data.returnRequest;
const code = String(online.unlockCode);
r = await call('POST', '/returns/validate-code', { body: { lockerUserId: online.lockerUserId, unlockCode: code } });
check('code check without device key is refused', r.status === 401);
r = await call('POST', '/returns/validate-code', { body: { lockerUserId: online.lockerUserId, unlockCode: code }, headers: { 'X-Device-Key': 'wrong', 'X-Box-Id': BOX_C } });
check('code check with a wrong device key is refused', r.status === 403);
r = await call('POST', '/returns/validate-code', { body: { lockerUserId: online.lockerUserId, unlockCode: '0000' }, headers: box(BOX_C) });
check('wrong code -> deny', r.data.action === 'deny', r.data);
r = await call('POST', '/returns/validate-code', { body: { lockerUserId: online.lockerUserId, unlockCode: code }, headers: box(BOX_C) });
check('right code -> open with the returnId', r.data.action === 'open' && r.data.returnId === online._id, r.data);
r = await call('POST', '/returns/validate-code', { body: { lockerUserId: online.lockerUserId, unlockCode: code }, headers: box(BOX_C) });
check('same code again -> used', r.data.action === 'used', r.data);
r = await call('GET', '/camera/next-return', { headers: box(BOX_C) });
check('next-return gives the return this box opened', r.status === 200 && r.data.returnId === online._id, r.data);
r = await call('GET', '/camera/next-return', { headers: box(BOX_B) });
check('another box gets nothing from next-return', r.status === 404);
r = await upload(BOX_B, { 'X-Return-Id': online._id });
check('photo from a different box is refused', r.status === 409, r.data);
if (jpeg) {
  r = await upload(BOX_C, { 'X-Return-Id': online._id });
  if (r.data.sessionId) cameraSessions.push(r.data.sessionId);
  check('photo after the door opened is accepted', r.status === 200 && r.data.returnId === online._id, r.data);
}

// ── Clean up: camera sessions (and their Cloudinary photos) and the returns
if (mongoose.connection.readyState !== 1) await mongoose.connect(process.env.DB_URL);
const { default: CameraSession } = await import('../db/models/cameraSession.model.js');
const { deleteImageFromCloud } = await import('../src/utils/imageUpload.js');
for (const id of cameraSessions) {
  const session = await CameraSession.findById(id);
  if (session?.publicId) await deleteImageFromCloud(session.publicId);
}
await CameraSession.deleteMany({ returnId: { $in: createdReturns } });
await mongoose.connection.collection('returns').deleteMany({ _id: { $in: createdReturns.map((id) => new mongoose.Types.ObjectId(id)) } });
await mongoose.disconnect();

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
