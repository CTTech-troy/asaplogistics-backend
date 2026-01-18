import express from 'express';
import { verifyToken } from '../middleware/auth.middleware.js';
import {
  getWebSocketToken,
  initiateWalletFunding,
  initiateDeliveryPayment,
  stripeWebhook,
  getTransactionStatus,
  manualWalletUpdate
} from '../controller/payment.controller.js';

const router = express.Router();

// All payment routes require authentication except webhook
router.use('/webhook', express.raw({ type: 'application/json' })); // Stripe needs raw body for webhook

// Stripe webhook (no auth required for webhooks)
router.post('/webhook', stripeWebhook);

// Authenticated routes
router.use(verifyToken);

// Get WebSocket authentication token
router.get('/ws-token', getWebSocketToken);

// Initiate wallet funding
router.post('/wallet/fund', initiateWalletFunding);

// Initiate delivery payment
router.post('/delivery/pay', initiateDeliveryPayment);

// Manual wallet update for testing (development only)
router.post('/manual-update', manualWalletUpdate);

// Get transaction status
router.get('/transaction/:transactionId', getTransactionStatus);

// Manual webhook test endpoint (development only)
if (process.env.NODE_ENV !== 'production') {
  router.post('/test-complete-payment', async (req, res) => {
    try {
      const uid = req.user?.uid;
      if (!uid) return res.status(401).json({ message: 'Unauthorized' });

      const { transactionId } = req.body;
      if (!transactionId) {
        return res.status(400).json({ message: 'Transaction ID required' });
      }

      // Dynamic imports
      const admin = (await import('../config/firebase.js')).default;
      const { decryptData } = await import('../utils/paymentCrypto.js');
      const { processSuccessfulPayment } = await import('../controller/payment.controller.js');

      // Get the pending transaction
      const pendingDoc = await admin.firestore().collection('pendingTransactions').doc(transactionId).get();
      if (!pendingDoc.exists) {
        return res.status(404).json({ message: 'Transaction not found' });
      }

      const { data: encryptedData } = pendingDoc.data();
      const transactionData = decryptData(encryptedData);

      if (transactionData.uid !== uid) {
        return res.status(403).json({ message: 'Access denied' });
      }

      // Manually trigger success processing
      await processSuccessfulPayment(transactionData, {
        paymentIntentId: `test_${transactionId}`,
        amount: transactionData.amount,
        currency: 'usd'
      });

      // Remove pending transaction
      await admin.firestore().collection('pendingTransactions').doc(transactionId).delete();

      res.status(200).json({ success: true, message: 'Payment completed manually' });
    } catch (err) {
      console.error('Manual payment completion error:', err);
      res.status(500).json({ message: 'Failed to complete payment manually' });
    }
  });
}

export default router;