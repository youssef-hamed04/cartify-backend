import { Router } from 'express';
import { protectRoute } from '../../middleware/auth.js';
import { attachSession } from '../../middleware/session.js';
import { validate, wishlistRules, mongoIdParam } from '../../middleware/validation.js';
import * as WC from './wishlist.controller.js';

const router = Router();
router.use(protectRoute, attachSession);

router.get('/',                                        WC.getWishlist);
router.post('/toggle',  wishlistRules, validate,       WC.toggleWishlist);
router.delete('/empty',                                WC.emptyWishlist);
router.delete('/item/:productId', ...mongoIdParam('productId'), validate, WC.removeFromWishlist);

export default router;
