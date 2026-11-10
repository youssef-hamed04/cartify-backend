import connectToDB from '../../../db/connectionDB.js';
import { asyncHandler } from '../../utils/error.js';
import { sendSuccess } from '../../utils/response.js';
import * as INV from './inventory.service.js';
import { takeInventorySnapshot } from './snapshot.service.js';

const horizon = (req) => Number(req.query.horizonDays || req.body?.horizonDays) || 30;
const handler = (fn) => asyncHandler(async (req, res) => { await connectToDB(); await fn(req, res); });

export const overview        = handler(async (req, res) => sendSuccess(res, 200, 'success', await INV.getOverview({ horizonDays: horizon(req) })));
export const branchInventory = handler(async (req, res) => sendSuccess(res, 200, 'success', await INV.getBranchInventory(req.params.branchId, { ...req.query, horizonDays: horizon(req) })));
export const setInventory    = handler(async (req, res) => sendSuccess(res, 200, 'success', { inventory: await INV.setInventory(req.params.branchId, req.params.productId, req.body, req.user) }));
export const productStock    = handler(async (req, res) => sendSuccess(res, 200, 'success', await INV.getProductAcrossBranches(req.params.productId, { horizonDays: horizon(req) })));
export const branchSales     = handler(async (req, res) => sendSuccess(res, 200, 'success', await INV.getBranchSales({ branchId: req.query.branchId, days: req.query.days })));
export const lowStock        = handler(async (req, res) => sendSuccess(res, 200, 'success', await INV.identifyLowStock({ branchId: req.query.branchId, horizonDays: horizon(req), limit: Number(req.query.limit) || 50 })));
export const excess          = handler(async (req, res) => sendSuccess(res, 200, 'success', await INV.identifyExcess({ branchId: req.query.branchId, horizonDays: horizon(req), limit: Number(req.query.limit) || 50 })));
export const transferIdeas   = handler(async (req, res) => sendSuccess(res, 200, 'success', await INV.suggestTransfers({ horizonDays: horizon(req), productId: req.query.productId, branchId: req.query.branchId, limit: Number(req.query.limit) || 50 })));
export const anomalies       = handler(async (req, res) => sendSuccess(res, 200, 'success', await INV.detectAnomalies({ days: Math.min(Number(req.query.days) || 14, 90) })));
export const report          = handler(async (req, res) => sendSuccess(res, 200, 'success', { report: await INV.inventoryReport({ horizonDays: horizon(req) }) }));

export const listMovements   = handler(async (req, res) => sendSuccess(res, 200, 'success', await INV.listMovements(req.query)));
export const createMovement  = handler(async (req, res) => {
  const via = req.get('X-Requested-Via') === 'inventory_agent' ? 'inventory_agent' : 'dashboard';
  sendSuccess(res, 201, 'success', { movement: await INV.createMovement(req.body, req.user, via) });
});
export const approveMovement  = handler(async (req, res) => sendSuccess(res, 200, 'success', { movement: await INV.approveMovement(req.params.id, req.user, req.body?.note) }));
export const completeMovement = handler(async (req, res) => sendSuccess(res, 200, 'success', { movement: await INV.completeMovement(req.params.id, req.user, req.body?.note) }));
export const rejectMovement   = handler(async (req, res) => sendSuccess(res, 200, 'success', { movement: await INV.rejectMovement(req.params.id, req.user, req.body?.note) }));
export const cancelMovement   = handler(async (req, res) => sendSuccess(res, 200, 'success', { movement: await INV.cancelMovement(req.params.id, req.user, req.body?.note) }));

export const listRecommendations    = handler(async (req, res) => sendSuccess(res, 200, 'success', await INV.listRecommendations(req.query)));
export const generateRecommendations = handler(async (req, res) => sendSuccess(res, 201, 'success', await INV.generateRecommendations({ horizonDays: horizon(req), user: req.user })));
export const approveRecommendation  = handler(async (req, res) => sendSuccess(res, 200, 'success', await INV.approveRecommendation(req.params.id, req.user, req.body?.note)));
export const rejectRecommendation   = handler(async (req, res) => sendSuccess(res, 200, 'success', { recommendation: await INV.rejectRecommendation(req.params.id, req.user, req.body?.note) }));

export const snapshot = handler(async (req, res) => sendSuccess(res, 201, 'success', await takeInventorySnapshot()));
