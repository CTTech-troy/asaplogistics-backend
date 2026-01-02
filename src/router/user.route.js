import express from 'express';
import { verifyToken } from '../middleware/auth.middleware.js';
import * as ordersCtrl from '../controller/orders.controller.js';
import * as historyCtrl from '../controller/history.controller.js';
import * as usersCtrl from '../controller/users.controller.js';

const router = express.Router();

// Orders
router.post('/orders', verifyToken, ordersCtrl.createOrder);
router.get('/orders', verifyToken, ordersCtrl.getOrders);
router.delete('/orders/:id', verifyToken, ordersCtrl.deleteOrder);

// Wallet routes removed (wallet functionality deprecated)

// History
router.get('/history', verifyToken, historyCtrl.getHistory);

// Profile for logged-in user
router.get('/profile', verifyToken, usersCtrl.getProfile);

export default router;
