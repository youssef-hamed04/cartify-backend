import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { body, param } from 'express-validator';
import { protectRoute, adminOnly } from '../../middleware/auth.js';
import { attachSession } from '../../middleware/session.js';
import { validate, mongoIdParam } from '../../middleware/validation.js';
import * as AC from './assistant.controller.js';

// Each chat message can trigger several model calls, so chats are rate limited per person.
const perMinute = parseInt(process.env.ASSISTANT_RATE_LIMIT_PER_MIN, 10) || 15;
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: perMinute,
  keyGenerator: (req) => (req.user ? `u:${req.user._id}` : `s:${req.sessionId || req.ip}`),
  message: { msg: 'error', err: 'Too many messages. Please wait a minute and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const chatRules = [
  body('message').isString().trim().isLength({ min: 1, max: 2000 }).withMessage('message must be 1–2000 characters'),
  body('conversationId').optional({ values: 'null' }).isMongoId().withMessage('Invalid conversationId'),
];
const actionRules = [param('actionId').isUUID().withMessage('Invalid actionId'), body('conversationId').isMongoId().withMessage('Invalid conversationId')];

const router = Router();
router.use(protectRoute, attachSession);

router.get('/status', AC.status);

// Shopping assistant — customers and guests
router.post('/chat', chatRules, validate, chatLimiter, AC.shoppingChat);
router.get('/conversations/:id', ...mongoIdParam('id'), validate, AC.getShoppingConversation);
router.delete('/conversations/:id', ...mongoIdParam('id'), validate, AC.deleteShoppingConversation);
router.post('/actions/:actionId/confirm', actionRules, validate, AC.confirmShoppingAction);
router.post('/actions/:actionId/cancel', actionRules, validate, AC.cancelShoppingAction);

// Inventory agent — administrators only
router.post('/inventory/chat', adminOnly, chatRules, validate, chatLimiter, AC.inventoryChat);
router.get('/inventory/conversations/:id', adminOnly, ...mongoIdParam('id'), validate, AC.getInventoryConversation);
router.delete('/inventory/conversations/:id', adminOnly, ...mongoIdParam('id'), validate, AC.deleteInventoryConversation);
router.post('/inventory/actions/:actionId/confirm', adminOnly, actionRules, validate, AC.confirmInventoryAction);
router.post('/inventory/actions/:actionId/cancel', adminOnly, actionRules, validate, AC.cancelInventoryAction);

export default router;
