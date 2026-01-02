import admin from '../config/firebase.js';

// Create an order for the authenticated user
export const createOrder = async (req, res) => {
  try {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ message: 'Unauthorized' });

    const { items = [], total = 0, metadata = {} } = req.body;

    const orderRef = admin.firestore().collection('users').doc(uid).collection('orders').doc();
    const order = {
      id: orderRef.id,
      uid,
      items,
      total,
      metadata,
      status: 'pending',
      createdAt: Date.now(),
    };

    await orderRef.set(order);

    // Optionally add a lightweight pointer in user's root document
    try {
      await admin.firestore().doc(`users/${uid}`).set({ lastOrderAt: Date.now() }, { merge: true });
    } catch (e) {
      console.error('Failed to update user lastOrderAt', e);
    }

    return res.status(201).json({ success: true, order });
  } catch (err) {
    console.error('createOrder error', err);
    return res.status(500).json({ message: 'Could not create order' });
  }
};

export const getOrders = async (req, res) => {
  try {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ message: 'Unauthorized' });

    const snap = await admin.firestore().collection('users').doc(uid).collection('orders').orderBy('createdAt', 'desc').limit(100).get();
    const orders = snap.docs.map(d => d.data());
    return res.status(200).json({ success: true, orders });
  } catch (err) {
    console.error('getOrders error', err);
    return res.status(500).json({ message: 'Could not fetch orders' });
  }
};

// Book a driver / create a delivery request (user-facing)
export const bookDriver = async (req, res) => {
  try {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ message: 'Unauthorized' });

    // Expect fields: pickup, destination, packageDescription, pickupTime, contact, price
    const { pickup = {}, destination = {}, packageDescription = '', pickupTime = null, contact = {}, price = 0 } = req.body;

    const orderRef = admin.firestore().collection('users').doc(uid).collection('orders').doc();
    const order = {
      id: orderRef.id,
      uid,
      items: [{ name: packageDescription }],
      total: Number(price) || 0,
      metadata: { pickup, destination, contact, pickupTime },
      status: 'pending',
      createdAt: Date.now(),
      type: 'delivery',
      booking: true,
    };

    await orderRef.set(order);

    try { await admin.firestore().doc(`users/${uid}`).set({ lastOrderAt: Date.now() }, { merge: true }); } catch (e) { console.error('Failed to update user lastOrderAt', e); }

    return res.status(201).json({ success: true, order });
  } catch (err) {
    console.error('bookDriver error', err);
    return res.status(500).json({ message: 'Could not create delivery request' });
  }
};

// Delete an order owned by the authenticated user
export const deleteOrder = async (req, res) => {
  try {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ message: 'Unauthorized' });

    const { id } = req.params;
    if (!id) return res.status(400).json({ message: 'Order id is required' });

    const orderRef = admin.firestore().collection('users').doc(uid).collection('orders').doc(id);
    const snap = await orderRef.get();
    if (!snap.exists) return res.status(404).json({ message: 'Order not found' });

    await orderRef.delete();

    // Optionally clear lastOrderAt if this was the most recent order — leave for now
    return res.status(200).json({ success: true, id });
  } catch (err) {
    console.error('deleteOrder error', err);
    return res.status(500).json({ message: 'Could not delete order' });
  }
};
