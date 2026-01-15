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

// Booking and delivery
router.post('/book-driver', verifyToken, ordersCtrl.bookDriver);

// Location and vehicle services
router.get('/location-suggestions', verifyToken, ordersCtrl.getLocationSuggestions);
router.get('/vehicle-types', verifyToken, ordersCtrl.getVehicleTypes);

// Wallet routes removed (wallet functionality deprecated)

// History
router.get('/history', verifyToken, historyCtrl.getHistory);

// Profile for logged-in user
router.get('/profile', verifyToken, usersCtrl.getProfile);

// Delete account — cascades deletion of all user data
router.delete('/delete-account', verifyToken, usersCtrl.deleteAccount);
router.delete('/delete-account/:uid', verifyToken, usersCtrl.deleteAccount);

export default router;
