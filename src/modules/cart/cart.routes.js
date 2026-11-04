import { Router } from 'express';
import { protectRoute, adminOnly } from '../../middleware/auth.js';
import { attachSession } from '../../middleware/session.js';
import { validate, addToCartRules, cartItemRules } from '../../middleware/validation.js';
import * as CC from './cart.controller.js';

const router = Router();
router.use(protectRoute);
router.use(attachSession);
router.get('/', CC.getCart);
router.get('/quantity', CC.getCartQuantity);
router.post('/', addToCartRules, validate, CC.addToCart);
router.patch('/add-quantity', cartItemRules, validate, CC.addQuantity);
router.patch('/reduce-quantity', cartItemRules, validate, CC.reduceQuantity);
router.patch('/remove-item', cartItemRules, validate, CC.removeItem);
router.patch('/empty', CC.emptyCart);
router.get('/all', adminOnly, CC.getAllCarts);

export default router;
