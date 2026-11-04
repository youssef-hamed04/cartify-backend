import { Router } from 'express';
import { protectRoute, adminOnly } from '../../middleware/auth.js';
import { attachSession } from '../../middleware/session.js';
import { validate, createReturnRules, mongoIdParam } from '../../middleware/validation.js';
import * as RTC from './return.controller.js';

const router = Router();
router.use(protectRoute, attachSession);

// ── Any user (or anonymous session) ──────────────────────────────────────────
router.post('/', createReturnRules, validate, RTC.createReturn);
router.get('/my', RTC.getMyReturns);
router.get('/:id', ...mongoIdParam('id'), validate, RTC.getReturnById);

// ── Hardware validation endpoint (no auth needed — secret key protects it) ───
router.post('/validate-code', RTC.validateReturnCode);

// ── Admin ─────────────────────────────────────────────────────────────────────
router.get('/', adminOnly, RTC.getAllReturns);
router.patch('/:id', adminOnly, ...mongoIdParam('id'), validate, RTC.updateReturn);

export default router;
