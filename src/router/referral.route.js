import express from 'express';
import { getMyReferral, getReferralStats, generateInviteToken, useReferral } from '../controller/referral.controller.js';
import { validateAndGetReferrer } from '../controller/referral.controller.js';
import { verifyToken } from '../middleware/auth.middleware.js';

const router = express.Router();

/**
 * GET /api/referral/my-referral
 * Get user's referral code and link
 * Auth required
 */
router.get('/my-referral', verifyToken, getMyReferral);

/**
 * POST /api/referral/my-referral
 * Also support POST for convenience (mobile apps might prefer POST)
 */
router.post('/my-referral', verifyToken, getMyReferral);

/**
 * GET /api/referral/stats
 * Get referral stats (total referrals, earned rewards)
 * Auth required
 */
router.get('/stats', verifyToken, getReferralStats);

/**
 * GET /api/referral/validate
 * Validate a referral code without auth (for signup page)
 * Query param: code
 */
router.get('/validate', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) {
      return res.status(400).json({ valid: false, message: 'Referral code required' });
    }

    const referrerInfo = await validateAndGetReferrer(code);
    return res.status(200).json(referrerInfo);
  } catch (err) {
    console.error('[REFERRAL] validate error:', err && err.message ? err.message : err);
    return res.status(500).json({ valid: false, message: 'Error validating code' });
  }
});

/**
 * POST /api/referral/invite
 * Create a one-time invite token for the authenticated user and return a shareable link
 */
router.post('/invite', verifyToken, async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ message: 'Unauthorized' });
    const { rawToken, id } = await generateInviteToken(uid);
    const frontendUrl = process.env.FRONTEND_URL;
    const inviteLink = `${frontendUrl}/signup?invite=${encodeURIComponent(rawToken)}`;
    return res.status(200).json({ success: true, inviteLink, inviteId: id });
  } catch (err) {
    console.error('[REFERRAL] invite generation error:', err && err.message ? err.message : err);
    return res.status(500).json({ success: false, message: 'Failed to generate invite' });
  }
});

/**
 * POST /api/referral/use
 * Auth required — apply a referral code for the current authenticated user
 */
router.post('/use', verifyToken, async (req, res) => {
  try {
    return useReferral(req, res);
  } catch (err) {
    console.error('[REFERRAL] /use error:', err && err.message ? err.message : err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * POST /api/referral/use-invite
 * Auth required — apply one-time invite token for current authenticated user
 */
router.post('/use-invite', verifyToken, async (req, res) => {
  try {
    const { inviteToken } = req.body;
    // delegate to controller
    return (await import('../controller/referral.controller.js')).useInviteToken(req, res);
  } catch (err) {
    console.error('[REFERRAL] /use-invite error:', err && err.message ? err.message : err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
