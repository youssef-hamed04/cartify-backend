import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { protectRoute, adminOnly } from '../../middleware/auth.js';
import { validate } from '../../middleware/validation.js';
import * as FC from './forecast.controller.js';

const HORIZONS = [7, 30, 90];
const branchParam = query('branchId').optional().custom((v) => v === 'all' || v === 'online' || /^[a-f\d]{24}$/i.test(v)).withMessage('branchId must be all, online or a branch id');
const viewRules = [
  query('horizonDays').optional().isIn(HORIZONS.map(String)).withMessage('horizonDays must be 7, 30 or 90'),
  branchParam,
  query('productId').optional().isMongoId().withMessage('Invalid productId'),
  query('groupBy').optional().isIn(['location', 'product']),
  query('trend').optional().isIn(['increasing', 'decreasing', 'stable', 'unknown']),
  query('risk').optional().isIn(['high', 'medium', 'low', 'none', 'at_risk']),
  query('sort').optional().isIn(['risk', 'demand', 'growth', 'decline', 'replenishment', 'excess', 'name']),
  query('search').optional().isString().isLength({ max: 100 }),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 500 }),
];

const router = Router();
router.use(protectRoute, adminOnly);

router.get('/status', FC.getStatus);
router.get('/runs', FC.getRuns);
router.get('/latest', viewRules, validate, FC.getLatest);
router.get('/products/:productId', param('productId').isMongoId().withMessage('Invalid productId'), query('horizonDays').optional().isIn(HORIZONS.map(String)), branchParam, validate, FC.getProduct);
router.post('/run', body('horizons').optional().isArray({ min: 1, max: 3 }), body('horizons.*').optional().isIn(HORIZONS).withMessage('horizons must be 7, 30 and/or 90'), validate, FC.postRun);

export default router;
