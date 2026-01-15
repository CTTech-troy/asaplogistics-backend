import express from 'express';
import { verifyToken } from '../middleware/auth.middleware.js';
import {
  getWebSocketToken,
  initiateWalletFunding,
  initiateDeliveryPayment,
  stripeWebhook,
  getTransactionStatus
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

// Get transaction status
router.get('/transaction/:transactionId', getTransactionStatus);

export default router;