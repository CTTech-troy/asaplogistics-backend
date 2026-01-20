import express from 'express';
import { verifyToken } from '../middleware/auth.middleware.js';
import {
  getWebSocketToken,
  getSystemInfo,
  initiateWalletFunding,
  initiateDeliveryPayment,
  opayWebhook,
  getTransactionStatus,
  confirmTransaction,
  testCompletePayment
} from '../controller/payment.controller.js';

const router = express.Router();

// All payment routes require authentication except webhook
router.use('/webhook', express.json()); // OPay sends JSON webhooks

// OPay webhook (no auth required for webhooks)
router.post('/webhook', opayWebhook);

// Authenticated routes
router.use(verifyToken);

// Get WebSocket authentication token
router.get('/ws-token', getWebSocketToken);

// Get system info (admin only)
router.get('/system-info', getSystemInfo);

// Initiate wallet funding
router.post('/wallet/fund', initiateWalletFunding);

// Initiate delivery payment
router.post('/delivery/pay', initiateDeliveryPayment);

// Get transaction status
router.get('/transaction/:transactionId', getTransactionStatus);

// Confirm transaction with gateway
router.post('/transaction/confirm', confirmTransaction);

// Manual webhook test endpoint (development only)
if (process.env.NODE_ENV !== 'production') {
  router.post('/test-complete-payment', testCompletePayment);
}

export default router;