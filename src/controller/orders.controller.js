import admin from '../config/firebase.js';
import { broadcastServerLog } from './payment.controller.js';

// basic sanitizers and validators
const sanitizeString = (v, max = 1000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const sanitizePhone = (v) => (typeof v === 'string' ? v.trim().replace(/[^+0-9]/g, '') : '');

// Vehicle pricing configuration
const VEHICLE_TYPES = {
  'Motorbike (Fastest)': {
    basePrice: 1500,
    perKmRate: 500,
    description: 'Fastest delivery option'
  },
  'Car (Fragile)': {
    basePrice: 3500,
    perKmRate: 1000,
    description: 'Suitable for fragile items'
  },
  'Van (Large Items)': {
    basePrice: 4000,
    perKmRate: 2000,
    description: 'For large and bulky items'
  }
};

// Abeokuta area coordinates (approximate center)
const ABEOKUTA_CENTER = {
  lat: 7.1475,
  lng: 3.3619
};

// Calculate distance between two points using Haversine formula
const calculateDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

// Check if location is within Abeokuta area (approximate 20km radius)
const isWithinAbeokuta = (lat, lng) => {
  const distance = calculateDistance(lat, lng, ABEOKUTA_CENTER.lat, ABEOKUTA_CENTER.lng);
  return distance <= 20; // 20km radius
};

// Calculate delivery price based on vehicle type and locations
const calculateDeliveryPrice = (vehicleType, pickupLat, pickupLng, destLat, destLng) => {
  const vehicle = VEHICLE_TYPES[vehicleType];
  if (!vehicle) {
    throw new Error('Invalid vehicle type');
  }

  // Check if both locations are within Abeokuta
  const pickupInAbeokuta = isWithinAbeokuta(pickupLat, pickupLng);
  const destInAbeokuta = isWithinAbeokuta(destLat, destLng);

  if (pickupInAbeokuta && destInAbeokuta) {
    // Both locations within Abeokuta - use base price
    return vehicle.basePrice;
  } else {
    // At least one location outside Abeokuta - calculate distance-based price
    const distance = calculateDistance(pickupLat, pickupLng, destLat, destLng);
    const distancePrice = distance * vehicle.perKmRate;
    return Math.max(vehicle.basePrice, distancePrice);
  }
};

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
    const orders = snap.docs.map(d => ({
      id: d.id,
      ...d.data()
    }));
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

    // Expect fields: pickup, destination, packageDescription, pickupTime, contact, vehicleType, coordinates
    const {
      pickup = {},
      destination = {},
      packageDescription = '',
      pickupTime = null,
      contact = {},
      vehicleType = 'Motorbike (Fastest)',
      coordinates = {}
    } = req.body;

    // Validate vehicle type
    if (!VEHICLE_TYPES[vehicleType]) {
      return res.status(400).json({ message: 'Invalid vehicle type selected' });
    }

    // Validate required fields
    const pkg = sanitizeString(packageDescription, 512);
    if (!pkg) return res.status(400).json({ message: 'Package description is required' });

    const cleanPickup = {
      address: sanitizeString(pickup.address || pickup, 1000),
      contactName: sanitizeString(pickup.contactName || contact.name || '', 128),
      contactPhone: sanitizePhone(pickup.contactPhone || contact.phone || ''),
      coordinates: {
        lat: coordinates.pickupLat ? Number(coordinates.pickupLat) : null,
        lng: coordinates.pickupLng ? Number(coordinates.pickupLng) : null
      }
    };

    const cleanDestination = {
      address: sanitizeString(destination.address || destination, 1000),
      contactName: sanitizeString(destination.contactName || contact.name || '', 128),
      contactPhone: sanitizePhone(destination.contactPhone || contact.phone || ''),
      coordinates: {
        lat: coordinates.destLat ? Number(coordinates.destLat) : null,
        lng: coordinates.destLng ? Number(coordinates.destLng) : null
      }
    };

    if (!cleanPickup.address || !cleanDestination.address) {
      return res.status(400).json({ message: 'Pickup and destination addresses are required' });
    }

    // Calculate delivery price
    let deliveryPrice = VEHICLE_TYPES[vehicleType].basePrice; // Default price
    let distance = 0;

    if (cleanPickup.coordinates.lat && cleanPickup.coordinates.lng &&
        cleanDestination.coordinates.lat && cleanDestination.coordinates.lng) {
      try {
        distance = calculateDistance(
          cleanPickup.coordinates.lat, cleanPickup.coordinates.lng,
          cleanDestination.coordinates.lat, cleanDestination.coordinates.lng
        );
        deliveryPrice = calculateDeliveryPrice(
          vehicleType,
          cleanPickup.coordinates.lat, cleanPickup.coordinates.lng,
          cleanDestination.coordinates.lat, cleanDestination.coordinates.lng
        );
      } catch (error) {
        console.error('Error calculating delivery price:', error);
        // Use default price if calculation fails
      }
    }

    // Check user's wallet balance
    const walletBalance = userData?.wallet?.balance ? Number(userData.wallet.balance) : 0;

    if (walletBalance < deliveryPrice) {
      return res.status(400).json({ 
        message: 'Please top up your wallet',
        requiredAmount: deliveryPrice,
        currentBalance: walletBalance
      });
    }

    // Deduct amount from wallet and create transaction
    let orderStatus = 'pending';
    
    try {
      await admin.firestore().runTransaction(async (transaction) => {
        const userSnap = await transaction.get(userRef);
        const currentData = userSnap.exists ? userSnap.data() : {};
        const currentBalance = currentData?.wallet?.balance ? Number(currentData.wallet.balance) : 0;
        
        if (currentBalance < deliveryPrice) {
          throw new Error('Insufficient funds');
        }
        
        const newBalance = currentBalance - deliveryPrice;
        
        // Create wallet transaction
        const txRef = userRef.collection('wallet').doc();
        const txDoc = {
          id: txRef.id,
          uid,
          amount: deliveryPrice,
          type: 'debit',
          note: `Delivery booking - ${pkg}`,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        
        // Update wallet balance and save transaction
        transaction.set(txRef, txDoc);
        transaction.set(userRef, { wallet: { balance: newBalance } }, { merge: true });
        
        // Set order status to pending since payment is successful
        orderStatus = 'pending';
      });
    } catch (error) {
      console.error('Wallet transaction error:', error);
      return res.status(400).json({ message: 'Payment failed. Please try again.' });
    }

    const orderRef = admin.firestore().collection('users').doc(uid).collection('orders').doc();
    const order = {
      id: orderRef.id,
      uid,
      items: [{ name: pkg }],
      total: deliveryPrice,
      metadata: {
        pickup: cleanPickup,
        destination: cleanDestination,
        contact: {
          name: sanitizeString(contact.name || ''),
          phone: sanitizePhone(contact.phone || '')
        },
        pickupTime: pickupTime || null,
        vehicleType: vehicleType,
        distance: distance,
        coordinates: coordinates
      },
      status: orderStatus,
      createdAt: Date.now(),
      type: 'delivery',
      booking: true,
      paid: true,
    };

    await orderRef.set(order);

    try { await userRef.set({ lastOrderAt: Date.now() }, { merge: true }); } catch (e) { console.error('Failed to update user lastOrderAt', e); }

    return res.status(201).json({
      success: true,
      order,
      pricing: {
        vehicleType,
        basePrice: VEHICLE_TYPES[vehicleType].basePrice,
        calculatedPrice: deliveryPrice,
        distance: distance,
        isWithinAbeokuta: cleanPickup.coordinates.lat && cleanDestination.coordinates.lat ?
          (isWithinAbeokuta(cleanPickup.coordinates.lat, cleanPickup.coordinates.lng) &&
           isWithinAbeokuta(cleanDestination.coordinates.lat, cleanDestination.coordinates.lng)) : false
      }
    });
  } catch (err) {
    console.error('bookDriver error', err);
    return res.status(500).json({ message: 'Could not create delivery request' });
  }
};

// Get location suggestions using OpenStreetMap Nominatim (free alternative to Google Maps)
export const getLocationSuggestions = async (req, res) => {
  try {
    const { query, countrycodes = 'ng', limit = 5 } = req.query;

    if (!query || query.trim().length < 2) {
      return res.status(400).json({ message: 'Query must be at least 2 characters long' });
    }

    // Use OpenStreetMap Nominatim API (free, no API key required)
    const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=${countrycodes}&limit=${limit}&addressdetails=1&extratags=1`;

    const response = await fetch(nominatimUrl, {
      headers: {
        'User-Agent': 'ASAP-Logistics-App/1.0'
      }
    });

    if (!response.ok) {
      throw new Error('Failed to fetch location suggestions');
    }

    const data = await response.json();

    // Transform the response to a cleaner format
    const suggestions = data.map(item => ({
      place_id: item.place_id,
      display_name: item.display_name,
      address: {
        house_number: item.address?.house_number || '',
        road: item.address?.road || '',
        suburb: item.address?.suburb || '',
        city: item.address?.city || item.address?.town || item.address?.village || '',
        state: item.address?.state || '',
        country: item.address?.country || '',
        postcode: item.address?.postcode || ''
      },
      coordinates: {
        lat: parseFloat(item.lat),
        lng: parseFloat(item.lon)
      },
      type: item.type,
      importance: item.importance
    }));

    return res.status(200).json({
      success: true,
      suggestions,
      query: query.trim()
    });

  } catch (error) {
    console.error('Location suggestions error:', error);
    return res.status(500).json({ message: 'Could not fetch location suggestions' });
  }
};

// Get vehicle types and pricing information
export const getVehicleTypes = async (req, res) => {
  try {
    const vehicleTypes = Object.keys(VEHICLE_TYPES).map(key => ({
      type: key,
      ...VEHICLE_TYPES[key]
    }));

    return res.status(200).json({
      success: true,
      vehicleTypes
    });
  } catch (error) {
    console.error('Get vehicle types error:', error);
    return res.status(500).json({ message: 'Could not fetch vehicle types' });
  }
};

// Delete an order (only if it's pending and belongs to the user)
export const deleteOrder = async (req, res) => {
  try {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ message: 'Unauthorized' });

    const { id } = req.params;
    if (!id) return res.status(400).json({ message: 'Order ID is required' });

    const orderRef = admin.firestore().doc(`orders/${id}`);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const orderData = orderSnap.data();

    // Check if the order belongs to the user
    if (orderData.uid !== uid) {
      return res.status(403).json({ message: 'You can only delete your own orders' });
    }

    // Only allow deletion of pending orders
    if (orderData.status !== 'pending') {
      return res.status(400).json({ message: 'Only pending orders can be deleted' });
    }

    // Delete the order
    await orderRef.delete();

    return res.status(200).json({
      success: true,
      message: 'Order deleted successfully'
    });
  } catch (error) {
    console.error('Delete order error:', error);
    return res.status(500).json({ message: 'Could not delete order' });
  }
};
