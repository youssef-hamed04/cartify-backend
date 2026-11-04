import { Router } from 'express';
import { adminOnly, protectRoute } from '../../middleware/auth.js';
import { upload } from '../../middleware/multer.js';
import { validate, productRules, mongoIdParam } from '../../middleware/validation.js';
import * as PC from './product.controller.js';

const router = Router();

router.get('/',             PC.getProducts);
router.get('/featured',     PC.getFeaturedProducts);
router.get('/categories',   PC.getAllCategories);
router.get('/brands',       PC.getAllBrands);
router.get('/slug/:slug',   PC.getProductBySlug);
router.get('/:id/reviews',  ...mongoIdParam('id'), validate, PC.getProductReviews);
router.get('/:id',          ...mongoIdParam('id'), validate, PC.getProductById);

router.use(protectRoute, adminOnly);
router.patch('/bulk-brand',    PC.bulkUpdateByBrand);
router.patch('/bulk-category', PC.bulkUpdateByCategory);
router.post('/',  upload.any(), productRules, validate, PC.createProduct);
router.patch('/:id', ...mongoIdParam('id'), validate, upload.any(), PC.updateProduct);
router.delete('/:id', ...mongoIdParam('id'), validate, PC.deleteProduct);

export default router;
