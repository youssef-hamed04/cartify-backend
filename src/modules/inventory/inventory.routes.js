import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { protectRoute, adminOnly } from '../../middleware/auth.js';
import { validate, mongoIdParam } from '../../middleware/validation.js';
import * as IC from './inventory.controller.js';

const horizon = query('horizonDays').optional().isIn(['7', '30', '90']).withMessage('horizonDays must be 7, 30 or 90');
const branchQuery = query('branchId').optional().custom((v) => v === 'all' || v === 'online' || /^[a-f\d]{24}$/i.test(v)).withMessage('branchId must be all, online or a branch id');
const note = body('note').optional().isString().isLength({ max: 500 }).withMessage('note is too long');
const paging = [query('page').optional().isInt({ min: 1 }), query('limit').optional().isInt({ min: 1, max: 200 })];

const router = Router();
router.use(protectRoute, adminOnly); // every inventory endpoint is admin-only

router.get('/overview', horizon, validate, IC.overview);
router.get('/report', horizon, validate, IC.report);
router.get('/sales', branchQuery, query('days').optional().isInt({ min: 7, max: 365 }), validate, IC.branchSales);
router.get('/low-stock', horizon, branchQuery, validate, IC.lowStock);
router.get('/excess', horizon, branchQuery, validate, IC.excess);
router.get('/transfer-suggestions', horizon, branchQuery, query('productId').optional().isMongoId(), validate, IC.transferIdeas);
router.get('/anomalies', query('days').optional().isInt({ min: 1, max: 90 }), validate, IC.anomalies);
router.post('/snapshots', IC.snapshot);

router.get('/branches/:branchId', ...mongoIdParam('branchId'), horizon, query('status').optional().isIn(['all', 'low', 'excess', 'out']), query('sort').optional().isIn(['risk', 'available', 'surplus', 'name']), query('search').optional().isLength({ max: 100 }), ...paging, validate, IC.branchInventory);
router.patch('/branches/:branchId/products/:productId', ...mongoIdParam('branchId'), ...mongoIdParam('productId'),
  body('quantity').optional().isInt({ min: 0, max: 1000000 }).withMessage('quantity must be a whole number ≥ 0'),
  body('safetyStock').optional({ values: 'null' }).isInt({ min: 0, max: 100000 }).withMessage('safetyStock must be a whole number ≥ 0'),
  body('reason').optional().isString().isLength({ max: 300 }), validate, IC.setInventory);
router.get('/products/:productId', ...mongoIdParam('productId'), horizon, validate, IC.productStock);

router.get('/movements', query('status').optional().isIn(['all', 'open', 'requested', 'approved', 'completed', 'rejected', 'cancelled']), query('type').optional().isIn(['transfer', 'replenishment', 'adjustment']), branchQuery, query('productId').optional().isMongoId(), ...paging, validate, IC.listMovements);
router.post('/movements',
  body('type').optional().isIn(['transfer', 'replenishment']).withMessage('type must be transfer or replenishment'),
  body('productId').isMongoId().withMessage('Invalid productId'),
  body('sourceBranchId').if(body('type').not().equals('replenishment')).isMongoId().withMessage('sourceBranchId is required for a transfer'),
  body('destinationBranchId').isMongoId().withMessage('Invalid destinationBranchId'),
  body('quantity').isInt({ min: 1, max: 100000 }).withMessage('quantity must be a whole number ≥ 1'),
  body('reason').optional().isString().isLength({ max: 500 }), validate, IC.createMovement);
router.patch('/movements/:id/approve', ...mongoIdParam('id'), note, validate, IC.approveMovement);
router.patch('/movements/:id/complete', ...mongoIdParam('id'), note, validate, IC.completeMovement);
router.patch('/movements/:id/reject', ...mongoIdParam('id'), note, validate, IC.rejectMovement);
router.patch('/movements/:id/cancel', ...mongoIdParam('id'), note, validate, IC.cancelMovement);

router.get('/recommendations', query('status').optional().isIn(['all', 'pending', 'approved', 'rejected', 'superseded']), query('type').optional().isIn(['stock_transfer', 'replenishment', 'excess_stock']), ...paging, validate, IC.listRecommendations);
router.post('/recommendations/generate', body('horizonDays').optional().isIn([7, 30, 90]).withMessage('horizonDays must be 7, 30 or 90'), validate, IC.generateRecommendations);
router.patch('/recommendations/:id/approve', ...mongoIdParam('id'), note, validate, IC.approveRecommendation);
router.patch('/recommendations/:id/reject', ...mongoIdParam('id'), note, validate, IC.rejectRecommendation);

export default router;
