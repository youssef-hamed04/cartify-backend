// Copy every collection from one MongoDB database to another (e.g. local → Atlas before deploying).
//   SOURCE_DB_URL=mongodb://127.0.0.1:27017/cartify TARGET_DB_URL="mongodb+srv://…/cartify" node db/copyDatabase.js
// Refuses to write into a target that already has data unless --force is passed (then it replaces
// each copied collection). Indexes are recreated by the app's models when it starts.
import mongoose from 'mongoose';

const { SOURCE_DB_URL, TARGET_DB_URL } = process.env;
const force = process.argv.includes('--force');
const BATCH = 1000;

if (!SOURCE_DB_URL || !TARGET_DB_URL) {
  console.error('Set SOURCE_DB_URL and TARGET_DB_URL');
  process.exit(1);
}
if (SOURCE_DB_URL === TARGET_DB_URL) {
  console.error('Source and target are the same database');
  process.exit(1);
}

const source = await mongoose.createConnection(SOURCE_DB_URL).asPromise();
const target = await mongoose.createConnection(TARGET_DB_URL).asPromise();
console.log(`Copying "${source.name}" → "${target.name}"`);

const existing = (await target.db.listCollections().toArray()).map((c) => c.name);
const nonEmpty = [];
for (const name of existing) if (await target.db.collection(name).estimatedDocumentCount()) nonEmpty.push(name);
if (nonEmpty.length && !force) {
  console.error(`Target already has data in: ${nonEmpty.join(', ')}. Re-run with --force to replace those collections.`);
  process.exit(1);
}

const collections = (await source.db.listCollections({ type: 'collection' }).toArray()).map((c) => c.name);
for (const name of collections) {
  const from = source.db.collection(name);
  const to = target.db.collection(name);
  if (existing.includes(name)) await to.deleteMany({});
  let batch = [];
  let copied = 0;
  for await (const doc of from.find()) {
    batch.push(doc);
    if (batch.length === BATCH) { await to.insertMany(batch, { ordered: false }); copied += batch.length; batch = []; }
  }
  if (batch.length) { await to.insertMany(batch, { ordered: false }); copied += batch.length; }
  console.log(`  ${name}: ${copied}`);
}

await source.close();
await target.close();
console.log('Done.');
