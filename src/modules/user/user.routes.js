import { Router } from 'express';
import { protectRoute, requireAuth, adminOnly } from '../../middleware/auth.js';
import { validate, authRules, updateUserRules, mongoIdParam } from '../../middleware/validation.js';
import * as UC from './user.controller.js';

const router = Router();

router.post('/auth',   authRules, validate, UC.authUser);
router.post('/logout', UC.logoutUser);
router.get('/me',    protectRoute, requireAuth, UC.getMyProfile);
router.patch('/me',  protectRoute, requireAuth, updateUserRules, validate, UC.updateMyProfile);
router.get('/',      protectRoute, adminOnly, UC.getAllUsers);
router.get('/:id',   protectRoute, adminOnly, ...mongoIdParam('id'), validate, UC.getUserById);
router.patch('/:id', protectRoute, adminOnly, ...mongoIdParam('id'), updateUserRules, validate, UC.updateUserById);

export default router;
