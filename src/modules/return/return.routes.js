import { Router } from 'express';
import { protectRoute, adminOnly } from '../../middleware/auth.js';
import { attachSession } from '../../middleware/session.js';
import { validate, createReturnRules, mongoIdParam } from '../../middleware/validation.js';
import { deviceAuth } from '../../middleware/deviceAuth.js';
import { codeCheckLimiter } from '../../middleware/cameraRateLimit.js';
import * as RTC from './return.controller.js';

const router = Router();

// ── SmartBox endpoint: the box sends its X-Device-Key and X-Box-Id headers ───
router.post('/validate-code', deviceAuth, codeCheckLimiter, RTC.validateReturnCode);

router.use(protectRoute, attachSession);

// ── Any user (or anonymous session) ──────────────────────────────────────────
router.post('/', createReturnRules, validate, RTC.createReturn);
router.get('/my', RTC.getMyReturns);
router.get('/:id', ...mongoIdParam('id'), validate, RTC.getReturnById);

// ── Admin ─────────────────────────────────────────────────────────────────────
router.get('/', adminOnly, RTC.getAllReturns);
router.patch('/:id', adminOnly, ...mongoIdParam('id'), validate, RTC.updateReturn);

export default router;
