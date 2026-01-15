import admin from '../config/firebase.js';
import stripe, { stripeWebhookSecret } from '../config/stripe.js';
import { generateHmac, verifyHmac, encryptData, decryptData, generateTransactionId } from '../utils/paymentCrypto.js';
import jwt from 'jsonwebtoken';

// Firebase Realtime DB for processing transaction locks
const db = admin.database();

// WebSocket clients
const wsClients = new Map();

// Generate WebSocket authentication token
export const getWebSocketToken = async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ message: 'Unauthorized' });

    // Create a short-lived token for WebSocket authentication
    const wsToken = jwt.sign(
      { uid, type: 'websocket' },
      process.env.JWT_SECRET,
      { expiresIn: '5m' } // 5 minutes
    );

    // Determine WebSocket URL based on environment
    const isProduction = process.env.NODE_ENV === 'production';
    const wsUrl = isProduction
      ? `wss://asaplogistics-backend.onrender.com?token=${wsToken}`
      : `ws://localhost:5000?token=${wsToken}`;

    res.status(200).json({
      success: true,
      wsToken,
      wsUrl
    });
  } catch (err) {
    console.error('getWebSocketToken error:', err);
    res.status(500).json({ message: 'Failed to generate WebSocket token' });
  }
};

// WebSocket helper
export function notifyUser(uid, event, data) {
  const client = wsClients.get(uid);
  if (client && client.readyState === 1) { 
    client.send(JSON.stringify({ event, data }));
  }
}

// Helper functions for transaction processing locks
async function acquireProcessingLock(transactionId) {
  const lockRef = db.ref(`processingTransactions/${transactionId}`);
  const snapshot = await lockRef.once('value');
  if (snapshot.exists()) {
    return false; // Already processing
  }
  await lockRef.set({ lockedAt: Date.now() });
  return true;
}

async function releaseProcessingLock(transactionId) {
  const lockRef = db.ref(`processingTransactions/${transactionId}`);
  await lockRef.remove();
}

// Initiate wallet funding
export const initiateWalletFunding = async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ message: 'Unauthorized' });

    // Check if WebSocket is connected
    const wsClient = wsClients.get(uid);
    if (!wsClient || wsClient.readyState !== 1) {
      return res.status(400).json({
        message: 'WebSocket connection required. Please connect to WebSocket first.',
        code: 'WEBSOCKET_REQUIRED'
      });
    }

    const { amount } = req.body;
    const numericAmount = Number(amount);

    if (isNaN(numericAmount) || numericAmount <= 0 || numericAmount > 1000000) {
      return res.status(400).json({ message: 'Invalid amount' });
    }

    const transactionId = generateTransactionId();
    const transactionData = {
      transactionId,
      uid,
      type: 'wallet_funding',
      amount: numericAmount,
      timestamp: Date.now(),
      status: 'pending'
    };

    const hmac = generateHmac(transactionData);

    // Create Stripe Payment Intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(numericAmount * 100), // Convert to cents
      currency: 'usd', // Change to your currency
      metadata: {
        transactionId,
        uid,
        type: 'wallet_funding'
      },
      description: `Wallet funding for user ${uid}`,
      automatic_payment_methods: {
        enabled: true,
      },
    });

    // Store encrypted transaction with payment intent ID
    const transactionWithPayment = {
      ...transactionData,
      paymentIntentId: paymentIntent.id
    };

    await admin.firestore().collection('pendingTransactions').doc(transactionId).set({
      data: encryptData(transactionWithPayment),
      hmac,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Notify user via WebSocket
    notifyUser(uid, 'transaction_initiated', {
      transactionId,
      type: 'wallet_funding',
      amount: numericAmount,
      clientSecret: paymentIntent.client_secret
    });

    res.status(200).json({
      success: true,
      transactionId,
      hmac,
      clientSecret: paymentIntent.client_secret,
      message: 'Funding initiated. Complete payment to confirm.'
    });
  } catch (err) {
    console.error('initiateWalletFunding error:', err);
    res.status(500).json({ message: 'Failed to initiate funding' });
  }
};

// Initiate delivery payment
export const initiateDeliveryPayment = async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ message: 'Unauthorized' });

    // Check if WebSocket is connected
    const wsClient = wsClients.get(uid);
    if (!wsClient || wsClient.readyState !== 1) {
      return res.status(400).json({
        message: 'WebSocket connection required. Please connect to WebSocket first.',
        code: 'WEBSOCKET_REQUIRED'
      });
    }

    const { deliveryId, amount } = req.body;
    const numericAmount = Number(amount);

    if (!deliveryId || isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ message: 'Invalid delivery or amount' });
    }

    // Verify delivery belongs to user and is in payable state
    const deliveryDoc = await admin.firestore().doc(`deliveries/${deliveryId}`).get();
    if (!deliveryDoc.exists) {
      return res.status(404).json({ message: 'Delivery not found' });
    }

    const delivery = deliveryDoc.data();
    if (delivery.userId !== uid || delivery.status !== 'confirmed') {
      return res.status(403).json({ message: 'Cannot pay for this delivery' });
    }

    if (delivery.paid) {
      return res.status(400).json({ message: 'Already paid' });
    }

    const transactionId = generateTransactionId();
    const transactionData = {
      transactionId,
      uid,
      type: 'delivery_payment',
      deliveryId,
      amount: numericAmount,
      timestamp: Date.now(),
      status: 'pending'
    };

    const hmac = generateHmac(transactionData);

    // Create Stripe Payment Intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(numericAmount * 100), // Convert to cents
      currency: 'usd', // Change to your currency
      metadata: {
        transactionId,
        uid,
        type: 'delivery_payment',
        deliveryId
      },
      description: `Delivery payment for ${deliveryId}`,
      automatic_payment_methods: {
        enabled: true,
      },
    });

    // Store encrypted transaction with payment intent ID
    const transactionWithPayment = {
      ...transactionData,
      paymentIntentId: paymentIntent.id
    };

    await admin.firestore().collection('pendingTransactions').doc(transactionId).set({
      data: encryptData(transactionWithPayment),
      hmac,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    notifyUser(uid, 'transaction_initiated', {
      transactionId,
      type: 'delivery_payment',
      deliveryId,
      amount: numericAmount,
      clientSecret: paymentIntent.client_secret
    });

    res.status(200).json({
      success: true,
      transactionId,
      hmac,
      clientSecret: paymentIntent.client_secret,
      message: 'Payment initiated. Complete payment to confirm.'
    });
  } catch (err) {
    console.error('initiateDeliveryPayment error:', err);
    res.status(500).json({ message: 'Failed to initiate payment' });
  }
};

// Stripe webhook handler
export const stripeWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // Handle the event
    switch (event.type) {
      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(event.data.object);
        break;
      case 'payment_intent.payment_failed':
        await handlePaymentIntentFailed(event.data.object);
        break;
      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook processing error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
};

// Handle successful payment intent
async function handlePaymentIntentSucceeded(paymentIntent) {
  const { transactionId } = paymentIntent.metadata;

  if (!transactionId) {
    console.error('No transactionId in payment intent metadata');
    return;
  }

  const pendingDoc = await admin.firestore().collection('pendingTransactions').doc(transactionId).get();
  if (!pendingDoc.exists) {
    console.error('Transaction not found:', transactionId);
    return;
  }

  const { data: encryptedData } = pendingDoc.data();
  const transactionData = decryptData(encryptedData);

  // Check if already processing
  const lockAcquired = await acquireProcessingLock(transactionId);
  if (!lockAcquired) {
    console.log('Transaction already processing:', transactionId);
    return;
  }

  try {
    await processSuccessfulPayment(transactionData, {
      paymentIntentId: paymentIntent.id,
      amount: paymentIntent.amount / 100, // Convert from cents
      currency: paymentIntent.currency
    });

    // Remove pending transaction
    await admin.firestore().collection('pendingTransactions').doc(transactionId).delete();
  } finally {
    await releaseProcessingLock(transactionId);
  }
}

// Handle failed payment intent
async function handlePaymentIntentFailed(paymentIntent) {
  const { transactionId } = paymentIntent.metadata;

  if (!transactionId) {
    console.error('No transactionId in payment intent metadata');
    return;
  }

  const pendingDoc = await admin.firestore().collection('pendingTransactions').doc(transactionId).get();
  if (!pendingDoc.exists) {
    console.error('Transaction not found:', transactionId);
    return;
  }

  const { data: encryptedData } = pendingDoc.data();
  const transactionData = decryptData(encryptedData);

  await processFailedPayment(transactionData);

  // Remove pending transaction
  await admin.firestore().collection('pendingTransactions').doc(transactionId).delete();
}

// Process successful payment
async function processSuccessfulPayment(transactionData, gatewayData) {
  const { uid, type, amount, deliveryId } = transactionData;

  const userRef = admin.firestore().doc(`users/${uid}`);

  await admin.firestore().runTransaction(async (t) => {
    const userSnap = await t.get(userRef);
    const userData = userSnap.data() || {};
    const currentBalance = userData.wallet?.balance || 0;

    if (type === 'wallet_funding') {
      const newBalance = currentBalance + amount;
      const upgradeThreshold = 50000; // Configure as needed
      const shouldUpgrade = newBalance >= upgradeThreshold && !userData.accountLevel === 'premium';

      t.update(userRef, {
        'wallet.balance': newBalance,
        'wallet.lastUpdated': admin.firestore.FieldValue.serverTimestamp(),
        ...(shouldUpgrade && { accountLevel: 'premium', upgradedAt: admin.firestore.FieldValue.serverTimestamp() })
      });

      // Log transaction
      t.set(admin.firestore().collection('transactions').doc(), {
        uid,
        type: 'credit',
        amount,
        description: 'Wallet funding',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      notifyUser(uid, 'wallet_funded', { amount, newBalance, ...(shouldUpgrade && { upgraded: true }) });
    } else if (type === 'delivery_payment') {
      if (currentBalance < amount) {
        throw new Error('Insufficient funds');
      }

      const newBalance = currentBalance - amount;
      t.update(userRef, {
        'wallet.balance': newBalance,
        'wallet.lastUpdated': admin.firestore.FieldValue.serverTimestamp()
      });

      // Mark delivery as paid
      t.update(admin.firestore().doc(`deliveries/${deliveryId}`), {
        paid: true,
        paidAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Log transaction
      t.set(admin.firestore().collection('transactions').doc(), {
        uid,
        type: 'debit',
        amount,
        description: `Delivery payment for ${deliveryId}`,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      notifyUser(uid, 'delivery_paid', { deliveryId, amount, newBalance });
    }
  });
}

// Process failed payment
async function processFailedPayment(transactionData) {
  const { uid, type, transactionId } = transactionData;

  notifyUser(uid, 'payment_failed', { transactionId, type });
}

// Get transaction status (for client polling if needed)
export const getTransactionStatus = async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ message: 'Unauthorized' });

    const { transactionId } = req.params;

    const pendingDoc = await admin.firestore().collection('pendingTransactions').doc(transactionId).get();
    if (!pendingDoc.exists) {
      return res.status(404).json({ message: 'Transaction not found or completed' });
    }

    const { data: encryptedData } = pendingDoc.data();
    const transactionData = decryptData(encryptedData);

    if (transactionData.uid !== uid) {
      return res.status(403).json({ message: 'Access denied' });
    }

    res.status(200).json({
      success: true,
      status: transactionData.status,
      type: transactionData.type
    });
  } catch (err) {
    console.error('getTransactionStatus error:', err);
    res.status(500).json({ message: 'Failed to get status' });
  }
};

// WebSocket connection handler
export function handleWebSocketConnection(ws, req) {
  try {
    // Extract token from query parameters
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');

    if (!token) {
      ws.close(1008, 'No token provided');
      return;
    }

    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded || decoded.type !== 'websocket' || !decoded.uid) {
      ws.close(1008, 'Invalid token');
      return;
    }

    const uid = decoded.uid;

    // Check if user already has a connection
    if (wsClients.has(uid)) {
      const existingWs = wsClients.get(uid);
      if (existingWs.readyState === 1) { // OPEN
        existingWs.close(1000, 'New connection established');
      }
      wsClients.delete(uid);
    }

    wsClients.set(uid, ws);

    // Send connection confirmation
    ws.send(JSON.stringify({
      event: 'connected',
      data: { uid, message: 'WebSocket connected successfully' }
    }));

    ws.on('message', (message) => {
      // Clients can only listen, not send updates
      try {
        const data = JSON.parse(message);
        if (data.type === 'ping') {
          ws.send(JSON.stringify({ event: 'pong', timestamp: Date.now() }));
        } else if (data.type === 'ready_for_payment') {
          // Client signals ready for payment
          ws.send(JSON.stringify({
            event: 'payment_ready',
            data: { message: 'Ready to initiate payments' }
          }));
        }
        // Ignore other messages
      } catch (e) {
        // Invalid message, ignore
      }
    });

    ws.on('close', () => {
      wsClients.delete(uid);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
      wsClients.delete(uid);
    });

  } catch (err) {
    console.error('WebSocket authentication error:', err);
    ws.close(1008, 'Authentication failed');
  }
}