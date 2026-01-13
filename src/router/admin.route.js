import express from 'express';
import { verifyToken, isAdmin } from '../middleware/auth.middleware.js';
import * as adminCtrl from '../controller/admin.controller.js';

const router = express.Router();

router.get('/orders', verifyToken, isAdmin, adminCtrl.listOrders);
router.patch('/orders/:uid/:orderId', verifyToken, isAdmin, adminCtrl.updateOrderStatus);
router.get('/users', verifyToken, isAdmin, adminCtrl.listUsers);
router.get('/referral-stats', verifyToken, isAdmin, adminCtrl.getReferralStats);
router.get('/contacts', verifyToken, isAdmin, adminCtrl.listContacts);
router.delete('/contacts/:contactId', verifyToken, isAdmin, adminCtrl.deleteContact);
router.post('/decrypt-message', verifyToken, isAdmin, adminCtrl.decryptContactMessage);
router.post('/send-email', verifyToken, isAdmin, adminCtrl.sendEmailToUsers);

export default router;
