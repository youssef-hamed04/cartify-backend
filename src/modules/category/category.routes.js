import { Router } from 'express';
import { adminOnly, protectRoute } from '../../middleware/auth.js';
import { upload } from '../../middleware/multer.js';
import { validate, categoryRules, mongoIdParam } from '../../middleware/validation.js';
import * as CC from './category.controller.js';

const router = Router();

router.get('/',       CC.getCategories);
router.get('/:slug',  CC.getCategoryBySlug);

router.use(protectRoute, adminOnly);
router.post('/sync-counts', CC.syncProductCounts);
router.post('/',  upload.single('image'), categoryRules, validate, CC.createCategory);
router.patch('/:id', ...mongoIdParam('id'), validate, upload.single('image'), CC.updateCategory);
router.delete('/:id', ...mongoIdParam('id'), validate, CC.deleteCategory);

export default router;
