import admin from '../config/firebase.js';

export const getHistory = async (req, res) => {
  try {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ message: 'Unauthorized' });

    // Combine orders and wallet transactions as a simple activity history
    const ordersSnap = await admin.firestore().collection('users').doc(uid).collection('orders').orderBy('createdAt', 'desc').limit(50).get();
    const txSnap = await admin.firestore().doc(`users/${uid}`).collection('wallet').orderBy('createdAt', 'desc').limit(50).get();

    const orders = ordersSnap.docs.map(d => ({ type: 'order', ...d.data() }));
    const txs = txSnap.docs.map(d => ({ type: 'wallet', ...d.data() }));

    // merge and sort by createdAt descending
    const combined = orders.concat(txs).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 100);
    return res.status(200).json({ success: true, history: combined });
  } catch (err) {
    console.error('getHistory error', err);
    return res.status(500).json({ message: 'Could not fetch history' });
  }
};
