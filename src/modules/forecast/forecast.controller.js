import connectToDB from '../../../db/connectionDB.js';
import { asyncHandler } from '../../utils/error.js';
import { sendSuccess } from '../../utils/response.js';
import { aiServiceHealth } from './aiServiceClient.js';
import { detectDataSource } from './forecastData.js';
import { HORIZONS, getForecastView, getProductForecast, latestRun, listRuns, runForecast, runMeta } from './forecast.service.js';

// GET /forecasts/status
export const getStatus = asyncHandler(async (req, res) => {
  await connectToDB();
  const [service, data, run] = await Promise.all([aiServiceHealth(), detectDataSource(), latestRun()]);
  sendSuccess(res, 200, 'success', { aiService: service, data, latestRun: runMeta(run), horizons: HORIZONS });
});

// POST /forecasts/run  { horizons?: [7, 30, 90] }
export const postRun = asyncHandler(async (req, res) => {
  await connectToDB();
  const horizons = Array.isArray(req.body.horizons) && req.body.horizons.length ? req.body.horizons.map(Number) : HORIZONS;
  const run = await runForecast({ horizons, userId: req.user._id });
  console.log(`[forecast] admin ${req.user.email} ran forecast ${run._id}`);
  sendSuccess(res, 201, 'success', {
    run: runMeta(run.toObject()),
    horizons: run.horizons.map((h) => ({ horizonDays: h.horizonDays, status: h.status, selectedModel: h.selectedModel, selectedModelLabel: h.selectedModelLabel, candidates: h.candidates, warnings: h.warnings, rows: h.results.length })),
  });
});

// GET /forecasts/latest?horizonDays=30&branchId=all|online|<id>&groupBy=location|product&trend&risk&search&sort&page&limit
export const getLatest = asyncHandler(async (req, res) => {
  await connectToDB();
  const view = await getForecastView({ ...req.query });
  sendSuccess(res, 200, 'success', view);
});

// GET /forecasts/products/:productId?horizonDays=30&branchId=all&weeks=26
export const getProduct = asyncHandler(async (req, res) => {
  await connectToDB();
  const weeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || 26, 4), 52);
  const data = await getProductForecast(req.params.productId, { horizonDays: Number(req.query.horizonDays) || 30, branchId: req.query.branchId || 'all', weeks });
  sendSuccess(res, 200, 'success', data);
});

// GET /forecasts/runs
export const getRuns = asyncHandler(async (req, res) => {
  await connectToDB();
  sendSuccess(res, 200, 'success', { runs: await listRuns(Math.min(parseInt(req.query.limit, 10) || 20, 50)) });
});
