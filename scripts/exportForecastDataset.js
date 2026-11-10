/**
 * Export the exact dataset the forecasting model trains on, for offline evaluation:
 *   node scripts/exportForecastDataset.js [output.json]
 *   ai-service/.venv/bin/python ai-service/scripts/evaluate.py output.json
 * Uses the same data-source rules as the API (FORECAST_DATA_SOURCE, default auto).
 * For the synthetic demo dataset it also exports the simulated true demand, so the evaluation can
 * show how much the stockout handling matters. Real order data has no such field.
 */
import 'dotenv/config';
import fs from 'fs';
import mongoose from 'mongoose';
import { detectDataSource, loadSeries, isoDay } from '../src/modules/forecast/forecastData.js';

const out = process.argv[2] || 'forecast-dataset.json';
await mongoose.connect(process.env.DB_URL || process.env.DB_URL_ONLINE);
try {
  const detection = await detectDataSource();
  if (!detection.source) throw new Error(detection.reason);
  const { asOf, series } = await loadSeries(detection.source, { withLatent: detection.source === 'synthetic_demo' });
  fs.writeFileSync(out, JSON.stringify({ dataSource: detection.source, asOf: isoDay(asOf), horizons: [7, 30, 90], series }));
  console.log(`Wrote ${series.length} series (${detection.source}, as of ${isoDay(asOf)}) to ${out}`);
} catch (err) {
  console.error('Export failed:', err.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
