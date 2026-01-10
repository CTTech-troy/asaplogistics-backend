import admin from "../config/firebase.js";
import crypto from 'crypto';

/**
 * Generate a unique referral code for the user
 * Format: first 3 chars of name + 6 random alphanumeric
 * Example: JOH123ABC
 */
function generateReferralCode(fullName) {
  const prefix = (fullName || 'USER').slice(0, 3).toUpperCase();
  const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `${prefix}${suffix}`;
}

/**
 * Generate a one-time invite token for a referrer.
 * Stores only a SHA256 hash of the token in Firestore for security.
 */
export async function generateInviteToken(referrerUid, ttlMs = 7 * 24 * 60 * 60 * 1000) {
  const raw = crypto.randomBytes(24).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  const now = Date.now();
  const doc = {
    referrerUid,
    tokenHash,
    used: false,
    createdAt: now,
    expiresAt: now + ttlMs,
  };
  const ref = await admin.firestore().collection('referralInvites').doc();
  await ref.set(doc);
  return { rawToken: raw, id: ref.id };
}

/**
 * Validate a raw invite token. Returns referrerUid and invite doc ref if valid.
 * Marks invite as used when applying referral during signup.
 */
export async function validateInviteToken(rawToken) {
  if (!rawToken) return { valid: false, message: 'Missing token' };
  const tokenHash = crypto.createHash('sha256').update(String(rawToken)).digest('hex');
  const q = await admin.firestore().collection('referralInvites')
    .where('tokenHash', '==', tokenHash)
    .limit(1)
    .get();
  if (q.empty) return { valid: false, message: 'Invalid token' };
  const doc = q.docs[0];
  const data = doc.data();
  if (data.used) return { valid: false, message: 'Token already used' };
  if (data.expiresAt && Date.now() > data.expiresAt) return { valid: false, message: 'Token expired' };
  return { valid: true, referrerUid: data.referrerUid, inviteId: doc.id };
}

/**
 * Get user's referral code and link
 * POST /api/referral/my-referral
 * Auth required
 */
export const getMyReferral = async (req, res) => {
  try {
    const uid = req.user?.uid || req.body?.uid;
    if (!uid) {
      return res.status(401).json({ message: 'User not authenticated' });
    }

    const userRef = admin.firestore().doc(`users/${uid}`);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).json({ message: 'User not found' });
    }

    const userData = userSnap.data();
    let { referralCode } = userData;

    // Generate referral code if user doesn't have one
    if (!referralCode) {
      referralCode = generateReferralCode(userData.fullName);
      await userRef.set({ referralCode }, { merge: true });
      console.log(`✓ [REFERRAL] Generated referral code ${referralCode} for user ${uid}`);
    }

    // Construct referral link
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const referralLink = `${frontendUrl}/signup?ref=${referralCode}`;

    res.status(200).json({
      success: true,
      referralCode,
      referralLink,
      reward: '₦500',
      message: 'Copy and share your referral link to earn ₦500 per referral',
    });
  } catch (err) {
    console.error('[REFERRAL] getMyReferral error:', err && err.message ? err.message : err);
    return res.status(500).json({ message: 'Failed to get referral code' });
  }
};

/**
 * Get referral stats (total referrals, earned rewards)
 * GET /api/referral/stats
 * Auth required
 */
export const getReferralStats = async (req, res) => {
  try {
    const uid = req.user?.uid || req.body?.uid;
    if (!uid) {
      return res.status(401).json({ message: 'User not authenticated' });
    }

    const userRef = admin.firestore().doc(`users/${uid}`);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).json({ message: 'User not found' });
    }

    const userData = userSnap.data();
    const totalReferrals = userData.totalReferrals || 0;
    const referralRewardsEarned = userData.referralRewardsEarned || 0;

    res.status(200).json({
      success: true,
      totalReferrals,
      referralRewardsEarned: `₦${referralRewardsEarned}`,
    });
  } catch (err) {
    console.error('[REFERRAL] getReferralStats error:', err && err.message ? err.message : err);
    return res.status(500).json({ message: 'Failed to fetch referral stats' });
  }
};

/**
 * Apply referral code during signup (called from auth.signup)
 * Internal function — not exposed as HTTP endpoint
 */
export async function applyReferralCode(referredByCode, newUserUid, referrerUid) {
  const REFERRAL_REWARD = 500; // ₦500 per referral

  try {
    if (!referredByCode || !referrerUid) {
      return { success: false, message: 'Invalid referral code' };
    }

    // Update referrer: increment totalReferrals and add reward to wallet
    const referrerRef = admin.firestore().doc(`users/${referrerUid}`);
    const referrerSnap = await referrerRef.get();
    if (!referrerSnap.exists) {
      return { success: false, message: 'Referrer not found' };
    }

    const referrerData = referrerSnap.data();
    const newTotalReferrals = (referrerData.totalReferrals || 0) + 1;
    const newReferralRewards = (referrerData.referralRewardsEarned || 0) + REFERRAL_REWARD;
    const newWalletBalance = (referrerData.wallet?.balance || 0) + REFERRAL_REWARD;

    await referrerRef.set({
      totalReferrals: newTotalReferrals,
      referralRewardsEarned: newReferralRewards,
      wallet: { balance: newWalletBalance },
    }, { merge: true });

    // Update new user: record who referred them AND credit ₦500 to their wallet
    const newUserRef = admin.firestore().doc(`users/${newUserUid}`);
    const newUserWalletBalance = REFERRAL_REWARD;
    await newUserRef.set({
      referredBy: referrerUid,
      referredByCode: referredByCode,
      wallet: { balance: newUserWalletBalance },
    }, { merge: true });

    console.log(`✓ [REFERRAL] Applied referral code: ${referredByCode}. Referrer ${referrerUid} earned ₦${REFERRAL_REWARD} (balance now ₦${newWalletBalance}). New user credited ₦${REFERRAL_REWARD} (balance now ₦${newUserWalletBalance})`);

    return {
      success: true,
      message: `Referral applied! ${referrerData.fullName || 'Referrer'} earned ₦${REFERRAL_REWARD}`,
      referrerName: referrerData.fullName,
      rewardGiven: REFERRAL_REWARD,
    };
  } catch (err) {
    console.error(`[REFERRAL] applyReferralCode error:`, err && err.message ? err.message : err);
    return { success: false, message: 'Failed to apply referral code' };
  }
}

/**
 * Validate referral code and get referrer details (helper for signup)
 * Internal function
 */
export async function validateAndGetReferrer(referralCode) {
  try {
    if (!referralCode) return { valid: false };

    // Query for user with matching referralCode
    const usersRef = admin.firestore().collection('users');
    const qSnap = await usersRef.where('referralCode', '==', referralCode).limit(1).get();

    if (qSnap.empty) {
      console.warn(`[REFERRAL] Invalid referral code: ${referralCode}`);
      return { valid: false, message: 'Referral code not found' };
    }

    const referrerDoc = qSnap.docs[0];
    const referrerId = referrerDoc.id;
    const referrerData = referrerDoc.data();

    return {
      valid: true,
      referrerId,
      referrerName: referrerData.fullName || referrerData.displayName,
      referralCode,
    };
  } catch (err) {
    console.error('[REFERRAL] validateAndGetReferrer error:', err && err.message ? err.message : err);
    return { valid: false, message: 'Error validating referral code' };
  }
}

/**
 * Mark an invite token as used. Called after successfully applying referral.
 */
export async function markInviteUsed(inviteId, usedByUid) {
  try {
    const ref = admin.firestore().collection('referralInvites').doc(inviteId);
    await ref.set({ used: true, usedByUid, usedAt: Date.now() }, { merge: true });
    return { success: true };
  } catch (err) {
    console.error('[REFERRAL] markInviteUsed error:', err && err.message ? err.message : err);
    return { success: false, message: 'Could not mark invite used' };
  }
}

/**
 * Apply a referral for an already-authenticated user (use referral code while logged in)
 * POST /api/referral/use
 */
export const useReferral = async (req, res) => {
  try {
    const uid = req.user?.uid;
    const { code } = req.body;
    if (!uid) return res.status(401).json({ success: false, message: 'Unauthorized' });
    if (!code) return res.status(400).json({ success: false, message: 'Referral code required' });

    // prevent self-referral
    const refInfo = await validateAndGetReferrer(code);
    if (!refInfo.valid) return res.status(400).json({ success: false, message: 'Invalid referral code' });
    if (refInfo.referrerId === uid) return res.status(400).json({ success: false, message: 'You cannot use your own referral code' });

    // Check if user already has a referrer
    const userRef = admin.firestore().doc(`users/${uid}`);
    const userSnap = await userRef.get();
    const userData = userSnap.exists ? userSnap.data() : {};
    if (userData.referredBy) {
      return res.status(400).json({ success: false, message: 'Referral already applied for this account' });
    }

    // Apply referral (credit referrer and mark on this user)
    const applyResult = await applyReferralCode(code, uid, refInfo.referrerId);
    if (!applyResult || !applyResult.success) {
      return res.status(500).json({ success: false, message: applyResult?.message || 'Failed to apply referral' });
    }

    return res.status(200).json({ success: true, message: applyResult.message, reward: applyResult.rewardGiven || 500 });
  } catch (err) {
    console.error('[REFERRAL] useReferral error:', err && err.message ? err.message : err);
    return res.status(500).json({ success: false, message: 'Server error applying referral' });
  }
};

/**
 * Apply a one-time invite token for an authenticated user
 * POST /api/referral/use-invite
 */
export const useInviteToken = async (req, res) => {
  try {
    const uid = req.user?.uid;
    const { inviteToken } = req.body;
    if (!uid) return res.status(401).json({ success: false, message: 'Unauthorized' });
    if (!inviteToken) return res.status(400).json({ success: false, message: 'Invite token required' });

    // Ensure user hasn't already been referred
    const userRef = admin.firestore().doc(`users/${uid}`);
    const userSnap = await userRef.get();
    const userData = userSnap.exists ? userSnap.data() : {};
    if (userData.referredBy) {
      return res.status(400).json({ success: false, message: 'Referral already applied for this account' });
    }

    // Validate invite token
    const v = await validateInviteToken(inviteToken);
    if (!v.valid) return res.status(400).json({ success: false, message: v.message || 'Invalid or expired invite token' });

    const referrerUid = v.referrerUid;
    // fetch referrer's code
    const refSnap = await admin.firestore().doc(`users/${referrerUid}`).get();
    const refData = refSnap.exists ? refSnap.data() : {};
    const refCode = refData.referralCode || null;

    // Apply referral
    const applyResult = await applyReferralCode(refCode, uid, referrerUid);
    if (!applyResult || !applyResult.success) {
      return res.status(500).json({ success: false, message: applyResult?.message || 'Failed to apply invite' });
    }

    // mark invite used
    await markInviteUsed(v.inviteId, uid);

    return res.status(200).json({ success: true, message: applyResult.message, reward: applyResult.rewardGiven || 500 });
  } catch (err) {
    console.error('[REFERRAL] useInviteToken error:', err && err.message ? err.message : err);
    return res.status(500).json({ success: false, message: 'Server error applying invite' });
  }
};
