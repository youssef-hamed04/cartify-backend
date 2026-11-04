import { Router } from 'express';
import { protectRoute, requireAuth } from '../../middleware/auth.js';
import { validate, createReviewRules, updateReviewRules, mongoIdParam } from '../../middleware/validation.js';
import * as RC from './review.controller.js';

const router = Router();
router.use(protectRoute, requireAuth);

router.post('/',      createReviewRules, validate, RC.createReview);
router.patch('/:id',  ...mongoIdParam('id'), validate, updateReviewRules, validate, RC.updateReview);
router.delete('/:id', ...mongoIdParam('id'), validate, RC.deleteReview);

export default router;
