import admin from '../config/firebase.js';

// basic sanitizers and validators
const sanitizeString = (v, max = 1000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const sanitizePhone = (v) => (typeof v === 'string' ? v.trim().replace(/[^+0-9]/g, '') : '');

// Create an order for the authenticated user (secure)
export const createOrder = async (req, res) => {
  try {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ message: 'Unauthorized' });

    // Basic rate-limit protection per-user: disallow more than 1 order every 20 seconds
    const userRef = admin.firestore().doc(`users/${uid}`);
    const userSnap = await userRef.get();
    const userData = userSnap.exists ? userSnap.data() : {};
    const lastOrderAt = Number(userData.lastOrderAt) || 0;
    if (Date.now() - lastOrderAt < 20 * 1000) {
      return res.status(429).json({ message: 'Too many order requests. Please wait a moment.' });
    }

    const { items = [], total = 0, metadata = {} } = req.body;

    // Validate items array
    if (!Array.isArray(items) || items.length === 0 || items.length > 20) return res.status(400).json({ message: 'Invalid items' });
    const cleanItems = items.slice(0, 20).map((it) => ({ name: sanitizeString(it.name || it.description || '', 256) }));

    // Validate total
    const numericTotal = Number(total || 0);
    if (Number.isNaN(numericTotal) || numericTotal < 0 || numericTotal > 1_000_000_000) return res.status(400).json({ message: 'Invalid total amount' });

    // Metadata sanitization (allow pickup/destination/contact as simple objects)
    const meta = {};
    if (metadata.pickup) meta.pickup = {
      address: sanitizeString(String(metadata.pickup.address || metadata.pickup)),
      contactName: sanitizeString(metadata.pickup.contactName || '' , 128),
      contactPhone: sanitizePhone(metadata.pickup.contactPhone || metadata.pickup.phone || ''),
    };
    if (metadata.destination) meta.destination = {
      address: sanitizeString(String(metadata.destination.address || metadata.destination)),
      contactName: sanitizeString(metadata.destination.contactName || '' , 128),
      contactPhone: sanitizePhone(metadata.destination.contactPhone || metadata.destination.phone || ''),
    };

    // Cap metadata size
    if (JSON.stringify(meta).length > 8000) return res.status(400).json({ message: 'Metadata too large' });

    const orderRef = admin.firestore().collection('users').doc(uid).collection('orders').doc();
    const order = {
      id: orderRef.id,
      uid,
      items: cleanItems,
      total: numericTotal,
      metadata: meta,
      status: 'pending',
      createdAt: Date.now(),
    };

    await orderRef.set(order);

    // Update user's lastOrderAt atomically
    try {
      await userRef.set({ lastOrderAt: Date.now() }, { merge: true });
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

// Book a driver / create a delivery request (user-facing, secure)
export const bookDriver = async (req, res) => {
  try {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ message: 'Unauthorized' });

    // Anti-abuse: require minimal interval between bookings
    const userRef = admin.firestore().doc(`users/${uid}`);
    const userSnap = await userRef.get();
    const userData = userSnap.exists ? userSnap.data() : {};
    const lastOrderAt = Number(userData.lastOrderAt) || 0;
    if (Date.now() - lastOrderAt < 20 * 1000) {
      return res.status(429).json({ message: 'Too many booking requests. Please wait a moment.' });
    }

    // Expect fields: pickup, destination, packageDescription, pickupTime, contact, price
    const { pickup = {}, destination = {}, packageDescription = '', pickupTime = null, contact = {}, price = 0 } = req.body;

    // Validate required fields
    const pkg = sanitizeString(packageDescription, 512);
    if (!pkg) return res.status(400).json({ message: 'Package description is required' });

    const cleanPickup = {
      address: sanitizeString(pickup.address || pickup, 1000),
      contactName: sanitizeString(pickup.contactName || contact.name || '', 128),
      contactPhone: sanitizePhone(pickup.contactPhone || contact.phone || ''),
    };
    const cleanDestination = {
      address: sanitizeString(destination.address || destination, 1000),
      contactName: sanitizeString(destination.contactName || contact.name || '', 128),
      contactPhone: sanitizePhone(destination.contactPhone || contact.phone || ''),
    };

    if (!cleanPickup.address || !cleanDestination.address) return res.status(400).json({ message: 'Pickup and destination addresses are required' });

    const numericPrice = Number(price || 0);
    if (Number.isNaN(numericPrice) || numericPrice < 0) return res.status(400).json({ message: 'Invalid price' });

    const orderRef = admin.firestore().collection('users').doc(uid).collection('orders').doc();
    const order = {
      id: orderRef.id,
      uid,
      items: [{ name: pkg }],
      total: numericPrice,
      metadata: { pickup: cleanPickup, destination: cleanDestination, contact: { name: sanitizeString(contact.name || ''), phone: sanitizePhone(contact.phone || '') }, pickupTime: pickupTime || null },
      status: 'pending',
      createdAt: Date.now(),
      type: 'delivery',
      booking: true,
    };

    await orderRef.set(order);

    try { await userRef.set({ lastOrderAt: Date.now() }, { merge: true }); } catch (e) { console.error('Failed to update user lastOrderAt', e); }

    return res.status(201).json({ success: true, order });
  } catch (err) {
    console.error('bookDriver error', err);
    return res.status(500).json({ message: 'Could not create delivery request' });
  }
};

// Delete an order owned by the authenticated user (keeps checks)
export const deleteOrder = async (req, res) => {
  try {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ message: 'Unauthorized' });

    const { id } = req.params;
    if (!id) return res.status(400).json({ message: 'Order id is required' });

    const orderRef = admin.firestore().collection('users').doc(uid).collection('orders').doc(id);
    const snap = await orderRef.get();
    if (!snap.exists) return res.status(404).json({ message: 'Order not found' });

    // Prevent deleting orders that are already in-progress or completed
    const order = snap.data();
    if (order && ['in_transit', 'delivered', 'completed'].includes(order.status)) {
      return res.status(403).json({ message: 'Cannot delete an order that is already in progress or completed' });
    }

    await orderRef.delete();

    return res.status(200).json({ success: true, id });
  } catch (err) {
    console.error('deleteOrder error', err);
    return res.status(500).json({ message: 'Could not delete order' });
  }
};
