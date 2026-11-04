import { Router } from 'express';
import { deviceAuth } from '../../middleware/deviceAuth.js';
import { protectRoute, adminOnly } from '../../middleware/auth.js';
import { validate, mongoIdParam } from '../../middleware/validation.js';
import * as CC from './camera.controller.js';

const router = Router();

// ── Hardware endpoint ─────────────────────────────────────────────────────────
// Accepts both multipart/form-data and raw image/jpeg bodies.
// express.raw() is applied in index.js for this route so raw bodies arrive
// as a Buffer. Multer handles multipart internally inside the controller.
router.post('/upload', deviceAuth, CC.uploadImage);
router.get('/next-return', CC.getNextReturn);

// ── Admin endpoints ───────────────────────────────────────────────────────────
router.use(protectRoute, adminOnly);
router.get('/sessions', CC.listSessions);
router.get('/session/:id', ...mongoIdParam('id'), validate, CC.getSession);
router.get('/return/:returnId', ...mongoIdParam('returnId'), validate, CC.getSessionByReturn);
router.delete('/session/:id', ...mongoIdParam('id'), validate, CC.deleteSession);

export default router;
