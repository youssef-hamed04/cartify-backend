import { Router } from 'express';
import { protectRoute, adminOnly } from '../../middleware/auth.js';
import { attachSession } from '../../middleware/session.js';
import { validate, createOrderRules, updateOrderRules, mongoIdParam } from '../../middleware/validation.js';
import * as OC from './order.controller.js';

const router = Router();
router.use(protectRoute, attachSession);

router.get('/shipping-rates', OC.getShippingRatesEndpoint);
router.get('/',    adminOnly, OC.getOrders);
router.get('/my',             OC.getMyOrders);
router.get('/:id',            ...mongoIdParam('id'), validate, OC.getOrderById);
router.post('/',              createOrderRules, validate, OC.createOrder);
router.patch('/:id',          adminOnly, ...mongoIdParam('id'), validate, updateOrderRules, validate, OC.updateOrder);
router.patch('/:id/cancel',   adminOnly, ...mongoIdParam('id'), validate, OC.cancelOrder);

export default router;
