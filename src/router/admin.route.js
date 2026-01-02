import express from 'express';
import { verifyToken, isAdmin } from '../middleware/auth.middleware.js';
import * as adminCtrl from '../controller/admin.controller.js';

const router = express.Router();

router.get('/orders', verifyToken, isAdmin, adminCtrl.listOrders);
router.patch('/orders/:uid/:orderId', verifyToken, isAdmin, adminCtrl.updateOrderStatus);

export default router;
