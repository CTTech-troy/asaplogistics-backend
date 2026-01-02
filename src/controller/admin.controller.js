import admin from '../config/firebase.js';

// Admin: list recent orders across all users (collectionGroup)
export const listOrders = async (req, res) => {
  try {
    const snap = await admin.firestore().collectionGroup('orders').orderBy('createdAt', 'desc').limit(200).get();
    const orders = snap.docs.map(d => d.data());
    return res.status(200).json({ success: true, orders });
  } catch (err) {
    console.error('listOrders error', err);
    return res.status(500).json({ message: 'Could not list orders' });
  }
};

// Admin: update an order status and optional assigned driver
export const updateOrderStatus = async (req, res) => {
  try {
    const { uid, orderId } = req.params;
    const { status, assignedDriver = null, note = '' } = req.body;
    if (!uid || !orderId) return res.status(400).json({ message: 'Missing uid or orderId' });

    const orderRef = admin.firestore().collection('users').doc(uid).collection('orders').doc(orderId);
    const snap = await orderRef.get();
    if (!snap.exists) return res.status(404).json({ message: 'Order not found' });

    const updates = { status, updatedAt: Date.now() };
    if (assignedDriver) updates.assignedDriver = assignedDriver;
    if (note) updates.note = note;

    await orderRef.set(updates, { merge: true });

    // Optionally notify user via updating their root doc flag
    try {
      await admin.firestore().doc(`users/${uid}`).set({ lastOrderUpdatedAt: Date.now() }, { merge: true });
    } catch (e) {
      console.error('Failed to update user lastOrderUpdatedAt', e);
    }

    return res.status(200).json({ success: true, message: 'Order updated' });
  } catch (err) {
    console.error('updateOrderStatus error', err);
    return res.status(500).json({ message: 'Could not update order' });
  }
};
