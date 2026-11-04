import { Router } from 'express';
import { protectRoute, adminOnly } from '../../middleware/auth.js';
import { validate, lockerRules, mongoIdParam } from '../../middleware/validation.js';
import * as LC from './locker.controller.js';

const router = Router();
router.use(protectRoute);

router.get('/',    LC.getLockers);
router.get('/:id', ...mongoIdParam('id'), validate, LC.getLockerById);

router.post('/',      adminOnly, lockerRules, validate, LC.createLocker);
router.patch('/:id',  adminOnly, ...mongoIdParam('id'), validate, LC.updateLocker);
router.delete('/:id', adminOnly, ...mongoIdParam('id'), validate, LC.deleteLocker);

export default router;
