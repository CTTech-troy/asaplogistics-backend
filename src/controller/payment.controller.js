import admin from '../config/firebase.js';
import opayClient, { opayPublicKey, opayMerchantId } from '../config/opay.js';
import { generateHmac, encryptData, decryptData, generateTransactionId } from '../utils/paymentCrypto.js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const db = admin.database();
const wsClients = new Map();

/* =======================================================
   WEBSOCKET TOKEN
======================================================= */
export const getWebSocketToken = async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ message: 'Unauthorized' });

    const wsToken = jwt.sign(
      { uid, type: 'websocket' },
      process.env.JWT_SECRET,
      { expiresIn: '5m' }
    );

    const wsUrl =
      process.env.NODE_ENV === 'production'
        ? `wss://asaplogistics-backend.onrender.com?token=${wsToken}`
        : `ws://localhost:5000?token=${wsToken}`;

    res.json({ success: true, wsToken, wsUrl });
  } catch (err) {
    res.status(500).json({ message: 'Failed to generate WebSocket token' });
  }
};

/* =======================================================
   SYSTEM INFO
======================================================= */
export const getSystemInfo = async (req, res) => {
  try {
    const os = await import('os');
    const processMod = await import('process');

    const info = {
      uptime: processMod.uptime(),
      platform: os.platform(),
      nodeVersion: processMod.version,
      memory: {
        total: os.totalmem(),
        free: os.freemem()
      }
    };

    res.json({ success: true, data: info });
  } catch {
    res.status(500).json({ message: 'Failed to get system info' });
  }
};

/* =======================================================
   WEBSOCKET HELPERS
======================================================= */
export function notifyUser(uid, event, data) {
  const client = wsClients.get(uid);
  if (client && client.readyState === 1) {
    client.send(JSON.stringify({ event, data }));
  }
}

export function notifyAdmins(event, data) {
  wsClients.forEach(client => {
    if (client.isAdmin && client.readyState === 1) {
      client.send(JSON.stringify({ event, data }));
    }
  });
}

/* =======================================================
   TRANSACTION LOCK
======================================================= */
async function acquireProcessingLock(transactionId) {
  const ref = db.ref(`processingTransactions/${transactionId}`);
  const snap = await ref.once('value');
  if (snap.exists()) return false;
  await ref.set({ lockedAt: Date.now() });
  return true;
}

async function releaseProcessingLock(transactionId) {
  await db.ref(`processingTransactions/${transactionId}`).remove();
}

/* =======================================================
   INITIATE WALLET FUNDING
======================================================= */
export const initiateWalletFunding = async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ message: 'Unauthorized' });

    const { amount } = req.body;
    const numericAmount = Number(amount);
    if (isNaN(numericAmount) || numericAmount <= 0)
      return res.status(400).json({ message: 'Invalid amount' });

    const transactionId = generateTransactionId();

    const transactionData = {
      transactionId,
      uid,
      type: 'wallet_funding',
      amount: numericAmount,
      status: 'pending',
      timestamp: Date.now()
    };

    const userSnap = await admin.firestore().doc(`users/${uid}`).get();
    if (!userSnap.exists) return res.status(404).json({ message: 'User not found' });

    const user = userSnap.data();

    const opayRequest = {
      reference: transactionId,
      amount: Math.round(numericAmount * 100),
      currency: 'NGN',
      callbackUrl: `${process.env.FRONTEND_URL}/payment/callback`,
      returnUrl: `${process.env.FRONTEND_URL}/payment/success`,
      cancelUrl: `${process.env.FRONTEND_URL}/payment/cancel`,
      customerName: user.name || 'User',
      customerEmail: user.email || 'user@email.com',
      productName: 'Wallet Funding'
    };

    const opayResponse = await opayClient.post(
      '/api/v1/international/cashier/create',
      opayRequest
    );

    if (opayResponse.data.code !== '00000')
      return res.status(400).json({ message: 'OPay init failed' });

    const paymentData = {
      ...transactionData,
      opayReference: opayResponse.data.data.reference,
      opayOrderNo: opayResponse.data.data.orderNo
    };

    await admin.firestore()
      .collection('pendingTransactions')
      .doc(transactionId)
      .set({
        data: encryptData(paymentData),
        opayReference: paymentData.opayReference,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

    res.json({
      success: true,
      transactionId,
      opayUrl: opayResponse.data.data.cashierUrl
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to initiate funding' });
  }
};

/* =======================================================
   OPAY WEBHOOK
======================================================= */
export const opayWebhook = async (req, res) => {
  try {
    const { payload, signature } = req.body;

    if (!verifyOpayWebhookSignature(payload, signature)) {
      return res.status(400).send('Invalid signature');
    }

    const data = typeof payload === 'string' ? JSON.parse(payload) : payload;

    if (data.status !== 'SUCCESS') return res.json({ received: true });

    const reference = data.data.reference;

    const pendingQuery = await admin.firestore()
      .collection('pendingTransactions')
      .where('opayReference', '==', reference)
      .limit(1)
      .get();

    if (pendingQuery.empty) return res.status(404).send('Transaction not found');

    const doc = pendingQuery.docs[0];
    const transactionData = decryptData(doc.data().data);

    const lock = await acquireProcessingLock(doc.id);
    if (!lock) return res.json({ received: true });

    try {
      await processSuccessfulPayment(transactionData);
      await admin.firestore().collection('pendingTransactions').doc(doc.id).delete();
    } finally {
      await releaseProcessingLock(doc.id);
    }

    res.json({ received: true });

  } catch (err) {
    console.error(err);
    res.status(500).send('Webhook error');
  }
};

/* =======================================================
   SIGNATURE VERIFY
======================================================= */
function verifyOpayWebhookSignature(payload, signature) {
  if (process.env.NODE_ENV !== 'production') return true;

  const hash = crypto
    .createHmac('sha512', process.env.OPAY_WEBHOOK_SECRET)
    .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
    .digest('hex');

  return hash === signature;
}

/* =======================================================
   PROCESS PAYMENT
======================================================= */
async function processFailedPayment(transactionData) {
  const { uid, transactionId } = transactionData;
  console.log(`❌ Payment failed for transaction ${transactionId}`);
  notifyUser(uid, 'payment_failed', {
    transactionId,
    message: 'Payment processing failed. Please try again.'
  });
}

export async function processSuccessfulPayment(transactionData) {
  const { uid, amount } = transactionData;
  const userRef = admin.firestore().doc(`users/${uid}`);

  await admin.firestore().runTransaction(async (t) => {
    const userSnap = await t.get(userRef);
    const userData = userSnap.data();
    const currentBalance = userData.wallet?.balance || 0;
    const newBalance = currentBalance + amount;

    t.update(userRef, {
      'wallet.balance': newBalance,
      'wallet.lastUpdated': admin.firestore.FieldValue.serverTimestamp()
    });

    t.set(admin.firestore().collection('transactions').doc(), {
      uid,
      type: 'credit',
      amount,
      description: 'Wallet funding',
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    notifyUser(uid, 'wallet_balance_update', { newBalance });
  });
}

/* =======================================================
   WEBSOCKET CONNECTION
======================================================= */
export async function handleWebSocketConnection(ws, req) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    if (!token) {
      console.error('❌ WebSocket: No token provided');
      return ws.close();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const uid = decoded.uid;
    console.log(`✅ WebSocket: User ${uid} connected`);

    const userSnap = await admin.firestore().doc(`users/${uid}`).get();
    if (userSnap.data()?.accountLevel === 'admin') ws.isAdmin = true;

    wsClients.set(uid, ws);

    ws.send(JSON.stringify({
      event: 'connected',
      data: { uid }
    }));

    ws.on('close', () => {
      console.log(`🔌 WebSocket: User ${uid} disconnected`);
      wsClients.delete(uid);
    });

    ws.on('message', async (msg) => {
      try {
        const data = JSON.parse(msg);
        if (data.type === 'api_request') {
          console.log(`📨 WebSocket API request: ${data.endpoint}`);
          await handleWebSocketAPIRequest(ws, uid, data);
        }
      } catch (err) {
        console.error('WebSocket message handler error:', err);
      }
    });

  } catch (err) {
    console.error('❌ WebSocket connection error:', err.message);
    ws.close();
  }
}

/* =======================================================
   WS API ROUTER
======================================================= */
async function handleWebSocketAPIRequest(ws, uid, request) {
  const { requestId, endpoint, method, body } = request;
  console.log(`🔄 Processing API request [${requestId}]: ${method} ${endpoint}`);

  const mockReq = { user: { uid }, body: body || {}, params: {}, method: method || 'GET' };

  const mockRes = {
    status: (code) => ({
      json: (data) => {
        try {
          const response = {
            event: 'api_response',
            data: { requestId, status: code, ...data }
          };
          console.log(`✅ Sending response [${requestId}] status ${code}`);
          ws.send(JSON.stringify(response));
        } catch (e) {
          console.error(`❌ Failed to send response for ${requestId}:`, e);
        }
      }
    }),
    json: (data) => {
      try {
        const response = {
          event: 'api_response',
          data: { requestId, status: 200, ...data }
        };
        console.log(`✅ Sending response [${requestId}] status 200`);
        ws.send(JSON.stringify(response));
      } catch (e) {
        console.error(`❌ Failed to send response for ${requestId}:`, e);
      }
    }
  };

  try {
    // Route to payment endpoints
    if (endpoint === '/api/payment/wallet/fund') {
      console.log(`💳 Routing to initiateWalletFunding`);
      return await initiateWalletFunding(mockReq, mockRes);
    } else if (endpoint === '/api/payment/delivery/pay') {
      console.log(`🚚 Routing to initiateDeliveryPayment`);
      return await initiateDeliveryPayment(mockReq, mockRes);
    }
    // Route to user endpoints
    else if (endpoint === '/api/user/profile') {
      console.log(`👤 Routing to getProfile for user ${uid}`);
      const usersCtrl = await import('./users.controller.js');
      return await usersCtrl.getProfile(mockReq, mockRes);
    } else if (endpoint === '/api/user/orders') {
      console.log(`📦 Routing to getOrders for user ${uid}`);
      const ordersCtrl = await import('./orders.controller.js');
      return await ordersCtrl.getOrders(mockReq, mockRes);
    } else if (endpoint === '/api/user/history') {
      console.log(`📅 Routing to getHistory for user ${uid}`);
      const historyCtrl = await import('./history.controller.js');
      return await historyCtrl.getHistory(mockReq, mockRes);
    }
    // Default: endpoint not found
    else {
      console.warn(`⚠️ Endpoint not found: ${endpoint}`);
      mockRes.status(404).json({ message: 'Endpoint not found' });
    }
  } catch (err) {
    console.error(`❌ WebSocket API error for ${endpoint}:`, err);
    mockRes.status(500).json({ message: err.message || 'Internal server error' });
  }
}
/* =======================================================
   MANUAL CONFIRM TRANSACTION (ADMIN / TEST)
======================================================= */
export const confirmTransaction = async (req, res) => {
  try {
    const { transactionId } = req.body;
    if (!transactionId) {
      return res.status(400).json({ message: 'Transaction ID required' });
    }

    // Find pending transaction
    const pendingDoc = await admin
      .firestore()
      .collection('pendingTransactions')
      .doc(transactionId)
      .get();

    if (!pendingDoc.exists) {
      return res.status(404).json({ message: 'Transaction not found' });
    }

    const transactionData = decryptData(pendingDoc.data().data);

    // Process success directly
    const lock = await acquireProcessingLock(transactionId);
    if (!lock) {
      return res.status(400).json({ message: 'Transaction already processing' });
    }

    try {
      await processSuccessfulPayment(transactionData);
      await admin.firestore()
        .collection('pendingTransactions')
        .doc(transactionId)
        .delete();
    } finally {
      await releaseProcessingLock(transactionId);
    }

    return res.json({ success: true, message: 'Transaction confirmed manually' });

  } catch (err) {
    console.error('Confirm transaction error:', err);
    res.status(500).json({ message: 'Failed to confirm transaction' });
  }
};

/* =======================================================
   GET TRANSACTION STATUS
======================================================= */
export const getTransactionStatus = async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ message: 'Unauthorized' });

    const { transactionId } = req.params;

    const pendingDoc = await admin
      .firestore()
      .collection('pendingTransactions')
      .doc(transactionId)
      .get();

    if (!pendingDoc.exists) {
      return res.status(404).json({ message: 'Transaction not found or completed' });
    }

    const transactionData = decryptData(pendingDoc.data().data);

    if (transactionData.uid !== uid) {
      return res.status(403).json({ message: 'Access denied' });
    }

    res.json({
      success: true,
      status: transactionData.status,
      type: transactionData.type
    });
  } catch (err) {
    console.error('getTransactionStatus error:', err);
    res.status(500).json({ message: 'Failed to get status' });
  }
};

/* =======================================================
   INITIATE DELIVERY PAYMENT
======================================================= */
export const initiateDeliveryPayment = async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ message: 'Unauthorized' });

    const { deliveryId, amount } = req.body;
    const numericAmount = Number(amount);

    if (!deliveryId || isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ message: 'Invalid delivery or amount' });
    }

    // Verify delivery belongs to user
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
      status: 'pending',
      timestamp: Date.now()
    };

    const userSnap = await admin.firestore().doc(`users/${uid}`).get();
    if (!userSnap.exists) return res.status(404).json({ message: 'User not found' });

    const user = userSnap.data();

    const opayRequest = {
      reference: transactionId,
      amount: Math.round(numericAmount * 100),
      currency: 'NGN',
      callbackUrl: `${process.env.FRONTEND_URL}/payment/callback`,
      returnUrl: `${process.env.FRONTEND_URL}/payment/success`,
      cancelUrl: `${process.env.FRONTEND_URL}/payment/cancel`,
      customerName: user.name || 'User',
      customerEmail: user.email || 'user@email.com',
      productName: 'Delivery Payment'
    };

    const opayResponse = await opayClient.post(
      '/api/v1/international/cashier/create',
      opayRequest
    );

    if (opayResponse.data.code !== '00000')
      return res.status(400).json({ message: 'OPay init failed' });

    const paymentData = {
      ...transactionData,
      opayReference: opayResponse.data.data.reference,
      opayOrderNo: opayResponse.data.data.orderNo
    };

    await admin.firestore()
      .collection('pendingTransactions')
      .doc(transactionId)
      .set({
        data: encryptData(paymentData),
        opayReference: paymentData.opayReference,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

    res.json({
      success: true,
      transactionId,
      opayUrl: opayResponse.data.data.cashierUrl
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to initiate delivery payment' });
  }
};

/* =======================================================
   TEST COMPLETE PAYMENT (DEVELOPMENT ONLY)
======================================================= */
export const testCompletePayment = async (req, res) => {
  try {
    // Only allow in development mode
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ message: 'This endpoint is only available in development mode' });
    }

    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ message: 'Unauthorized' });

    const { transactionId } = req.body;
    if (!transactionId) {
      return res.status(400).json({ message: 'Transaction ID required' });
    }

    // Get the pending transaction
    const pendingDoc = await admin
      .firestore()
      .collection('pendingTransactions')
      .doc(transactionId)
      .get();

    if (!pendingDoc.exists) {
      return res.status(404).json({ message: 'Transaction not found' });
    }

    const transactionData = decryptData(pendingDoc.data().data);

    // Check if transaction belongs to user
    if (transactionData.uid !== uid) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Process the successful payment
    const lock = await acquireProcessingLock(transactionId);
    if (!lock) {
      return res.status(400).json({ message: 'Transaction already processing' });
    }

    try {
      await processSuccessfulPayment(transactionData);
      await admin.firestore()
        .collection('pendingTransactions')
        .doc(transactionId)
        .delete();

      res.json({
        success: true,
        message: 'Test payment completed successfully'
      });

    } finally {
      await releaseProcessingLock(transactionId);
    }

  } catch (err) {
    console.error('Test complete payment error:', err);
    res.status(500).json({ message: 'Failed to complete test payment' });
  }
};
