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
      fullName: data.fullName || data.displayName || null,
      email: data.email || null,
      phone: data.phone || null,
      wallet: data.wallet || { balance: 0 },
      dashboardMessage: data.dashboardMessage || '',
      role: data.role || 'user',
      createdAt: data.createdAt || null,
    };

    return res.status(200).json({ success: true, user: safe });
  } catch (err) {
    console.error('getProfile error', err);
    return res.status(500).json({ message: 'Could not fetch profile' });
  }
};
