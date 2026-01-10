import admin from '../config/firebase.js';

// Return the Firestore user document for the authenticated user (safe fields only)
export const getProfile = async (req, res) => {
  try {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ message: 'Unauthorized' });

    const docRef = admin.firestore().doc(`users/${uid}`);
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ message: 'User not found' });
    const data = snap.data() || {};

    const safe = {
      uid: data.uid || uid,
      fullName: data.fullName || data.displayName,
      email: data.email,
      phone: data.phone,
      wallet: data.wallet || { balance: 0 },
      role: data.role || 'user',
      createdAt: data.createdAt,
    };

    return res.status(200).json({ success: true, user: safe });
  } catch (err) {
    console.error('getProfile error', err);
    return res.status(500).json({ message: 'Could not fetch profile' });
  }
};

/**
 * DELETE /api/user/delete-account
 * Permanently delete user account and all associated data
 * Auth required — only user or admin can delete
 * Cascades: deletes user doc, referral data, orders, sessions, wallet history, Firebase Auth user
 */
export const deleteAccount = async (req, res) => {
  try {
    const uid = req.user?.uid;
    const targetUid = req.params?.uid || req.body?.uid;

    if (!uid) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Allow only the user themselves or an admin to delete
    const isAdmin = req.user?.role === 'admin' || req.user?.admin === true;
    if (!isAdmin && uid !== targetUid) {
      return res.status(403).json({ message: 'Forbidden: can only delete your own account' });
    }

    const uidToDelete = targetUid || uid;

    // Start deletion cascade
    console.log(`[USER DELETE] Beginning deletion cascade for user ${uidToDelete}...`);

    // 1. Get user document to extract referral info before deletion
    const userRef = admin.firestore().doc(`users/${uidToDelete}`);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).json({ message: 'User not found' });
    }
    const userData = userSnap.data() || {};
    const referralCode = userData.referralCode;

    // 2. Delete or update referral data
    // a) If this user referred others, clear their referrer field but keep the relationship for records
    if (userData.totalReferrals && userData.totalReferrals > 0) {
      const referredUsersSnap = await admin
        .firestore()
        .collection('users')
        .where('referredBy', '==', uidToDelete)
        .get();
      
      const batch1 = admin.firestore().batch();
      referredUsersSnap.docs.forEach((doc) => {
        batch1.update(doc.ref, { referredBy: null, referredByCode: null });
      });
      if (!referredUsersSnap.empty) {
        await batch1.commit();
        console.log(`[USER DELETE] Cleared referrer for ${referredUsersSnap.size} users who were referred by ${uidToDelete}`);
      }
    }

    // b) If this user was referred by someone, decrement their referral count and wallet balance
    if (userData.referredBy) {
      const referrerRef = admin.firestore().doc(`users/${userData.referredBy}`);
      const referrerSnap = await referrerRef.get();
      if (referrerSnap.exists) {
        const referrerData = referrerSnap.data();
        const newTotalReferrals = Math.max(0, (referrerData.totalReferrals || 1) - 1);
        const newRewardsEarned = Math.max(0, (referrerData.referralRewardsEarned || 500) - 500);
        const newWalletBalance = Math.max(0, (referrerData.wallet?.balance || 500) - 500);
        
        await referrerRef.set({
          totalReferrals: newTotalReferrals,
          referralRewardsEarned: newRewardsEarned,
          wallet: { balance: newWalletBalance },
        }, { merge: true });
        
        console.log(`[USER DELETE] Adjusted referrer ${userData.referredBy}: -₦500 for lost referral`);
      }
    }

    // 3. Delete all orders associated with the user
    const ordersSnap = await admin
      .firestore()
      .collection('orders')
      .where('userId', '==', uidToDelete)
      .get();
    
    const orderBatch = admin.firestore().batch();
    ordersSnap.docs.forEach((doc) => {
      orderBatch.delete(doc.ref);
    });
    if (!ordersSnap.empty) {
      await orderBatch.commit();
      console.log(`[USER DELETE] Deleted ${ordersSnap.size} orders for user ${uidToDelete}`);
    }

    // 4. Delete all order history records
    const historySnap = await admin
      .firestore()
      .collection('orderHistory')
      .where('userId', '==', uidToDelete)
      .get();
    
    const historyBatch = admin.firestore().batch();
    historySnap.docs.forEach((doc) => {
      historyBatch.delete(doc.ref);
    });
    if (!historySnap.empty) {
      await historyBatch.commit();
      console.log(`[USER DELETE] Deleted ${historySnap.size} order history records for user ${uidToDelete}`);
    }

    // 5. Delete wallet transaction history
    const walletSnap = await admin
      .firestore()
      .collection('walletTransactions')
      .where('userId', '==', uidToDelete)
      .get();
    
    const walletBatch = admin.firestore().batch();
    walletSnap.docs.forEach((doc) => {
      walletBatch.delete(doc.ref);
    });
    if (!walletSnap.empty) {
      await walletBatch.commit();
      console.log(`[USER DELETE] Deleted ${walletSnap.size} wallet transactions for user ${uidToDelete}`);
    }

    // 6. Delete user sessions
    const sessionsSnap = await admin
      .firestore()
      .collection('sessions')
      .where('userId', '==', uidToDelete)
      .get();
    
    const sessionBatch = admin.firestore().batch();
    sessionsSnap.docs.forEach((doc) => {
      sessionBatch.delete(doc.ref);
    });
    if (!sessionsSnap.empty) {
      await sessionBatch.commit();
      console.log(`[USER DELETE] Deleted ${sessionsSnap.size} sessions for user ${uidToDelete}`);
    }

    // 7. Delete user document from Firestore
    await userRef.delete();
    console.log(`[USER DELETE] Deleted user document for ${uidToDelete} from Firestore`);

    // 8. Delete user from Firebase Authentication (do this last, after Firestore)
    try {
      await admin.auth().deleteUser(uidToDelete);
      console.log(`[USER DELETE] Deleted user ${uidToDelete} from Firebase Auth`);
    } catch (authErr) {
      // If user doesn't exist in Firebase Auth, that's okay (already deleted or never created)
      if (authErr.code === 'auth/user-not-found') {
        console.log(`[USER DELETE] User ${uidToDelete} not found in Firebase Auth (may have been pre-deleted)`);
      } else {
        console.error(`[USER DELETE] Error deleting from Firebase Auth:`, authErr && authErr.message ? authErr.message : authErr);
        throw authErr;
      }
    }

    console.log(`✓ [USER DELETE] Complete cascade deletion for user ${uidToDelete}`);

    return res.status(200).json({
      success: true,
      message: 'User account and all associated data have been permanently deleted',
    });
  } catch (err) {
    console.error(`✗ [USER DELETE] Error during deletion:`, err && err.message ? err.message : err);
    return res.status(500).json({ message: 'Failed to delete account', error: err && err.message ? err.message : String(err) });
  }
};

