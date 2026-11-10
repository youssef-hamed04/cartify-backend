import { Router } from 'express';
import { body, query } from 'express-validator';
import { protectRoute, adminOnly } from '../../middleware/auth.js';
import { validate, mongoIdParam } from '../../middleware/validation.js';
import * as BC from './branch.controller.js';

// Branches are internal operations data: admin-only. Deleting is not offered (stock and movement
// history refer to branches); set status to "inactive" instead.
const STATUSES = ['active', 'inactive', 'maintenance'];
const branchRules = (optional) => {
  const f = (chain) => (optional ? chain.optional() : chain);
  return [
    f(body('code')).trim().notEmpty().isLength({ max: 20 }).withMessage('code is required (max 20 characters)'),
    f(body('name')).trim().notEmpty().isLength({ max: 100 }).withMessage('name is required'),
    f(body('address')).trim().notEmpty().isLength({ max: 200 }).withMessage('address is required'),
    body('city').optional().trim().isLength({ max: 60 }),
    body('location.lat').optional().isFloat({ min: -90, max: 90 }).withMessage('Invalid latitude'),
    body('location.lng').optional().isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude'),
    body('status').optional().isIn(STATUSES).withMessage(`status must be one of ${STATUSES.join(', ')}`),
  ];
};

const router = Router();
router.use(protectRoute, adminOnly);

router.get('/', query('status').optional().isIn(STATUSES), validate, BC.getBranches);
router.get('/:id', ...mongoIdParam('id'), validate, BC.getBranchById);
router.post('/', branchRules(false), validate, BC.createBranch);
router.patch('/:id', ...mongoIdParam('id'), branchRules(true), validate, BC.updateBranch);

export default router;
