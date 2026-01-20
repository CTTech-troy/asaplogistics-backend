import admin from '../config/firebase.js';
import { broadcastServerLog } from './payment.controller.js';
import { decryptToUTF8 } from '../utils/crypto.js';
import { sendBulkEmail } from '../utils/mailer.js';
import { notifyUser } from './payment.controller.js';

// Admin: list recent orders across all users (collectionGroup)
export const listOrders = async (req, res) => {
  try {
    // Prefer collectionGroup for performance when supported
    try {
      const snap = await admin.firestore().collectionGroup('orders').orderBy('createdAt', 'desc').limit(200).get();
      const orders = snap.docs.map(d => ({
        id: d.id,
        ...d.data()
      }));
      return res.status(200).json({ success: true, orders });
    } catch (cgErr) {
      // Some Firestore setups (Datastore mode or restricted projects) may not support collectionGroup queries.
      // Fall back to scanning users -> orders subcollections and merge results.
      console.warn('collectionGroup query failed, falling back to per-user scan:', cgErr && (cgErr.message || cgErr.code));
      const usersSnap = await admin.firestore().collection('users').get();
      const orders = [];
      // Fetch orders for each user (in parallel batches to avoid blocking)
      const promises = [];
      usersSnap.forEach(userDoc => {
        const p = admin.firestore().collection('users').doc(userDoc.id).collection('orders').get()
          .then(s => s.docs.map(d => ({
            id: d.id,
            ...d.data()
          })).forEach(o => orders.push(o)))
          .catch(e => console.warn('Failed to fetch orders for user', userDoc.id, e && e.message));
        promises.push(p);
      });
      await Promise.all(promises);
      // Sort by createdAt desc and limit
      orders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const limited = orders.slice(0, 200);
      return res.status(200).json({ success: true, orders: limited, fallback: true });
    }
  } catch (err) {
    console.error('listOrders error', err);
    return res.status(500).json({ message: 'Could not list orders' });
  }
};

// Admin: update an order status and optional assigned driver
export const updateOrderStatus = async (req, res) => {
  try {
    const { uid, orderId } = req.params;
    const { status, assignedDriver = null, note = '' } = req.body;
    if (!uid || !orderId) return res.status(400).json({ message: 'Missing uid or orderId' });

    const orderRef = admin.firestore().collection('users').doc(uid).collection('orders').doc(orderId);
    const snap = await orderRef.get();
    if (!snap.exists) return res.status(404).json({ message: 'Order not found' });

    const updates = { status, updatedAt: Date.now() };
    if (assignedDriver) updates.assignedDriver = assignedDriver;
    if (note) updates.note = note;

    await orderRef.set(updates, { merge: true });

    // Notify user via WebSocket about order status update
    try {
      notifyUser(uid, 'order_status_update', {
        orderId,
        status,
        assignedDriver,
        note,
        updatedAt: updates.updatedAt
      });
    } catch (wsErr) {
      console.warn('Failed to send WebSocket notification for order update:', wsErr);
    }

    // Optionally notify user via updating their root doc flag
    try {
      await admin.firestore().doc(`users/${uid}`).set({ lastOrderUpdatedAt: Date.now() }, { merge: true });
    } catch (e) {
      console.error('Failed to update user lastOrderUpdatedAt', e);
    }

    return res.status(200).json({ success: true, message: 'Order updated' });
  } catch (err) {
    console.error('updateOrderStatus error', err);
    return res.status(500).json({ message: 'Could not update order' });
  }
};

// Admin: list all users with their wallet balance
export const listUsers = async (req, res) => {
  try {
    const snap = await admin.firestore().collection('users').get();
    const users = [];
    snap.forEach(doc => {
      const data = doc.data();
      users.push({
        uid: doc.id,
        fullName: data.fullName || 'N/A',
        email: data.email || 'N/A',
        phone: data.phone || 'N/A',
        wallet: {
          balance: data.wallet?.balance ?? data.walletBalance ?? 0,
        },
        referralCode: data.referralCode || 'N/A',
        createdAt: data.createdAt || null,
      });
    });
    return res.status(200).json({ success: true, users, totalUsers: users.length });
  } catch (err) {
    console.error('listUsers error', err);
    return res.status(500).json({ message: 'Could not list users' });
  }
};

// Admin: get referral statistics and total generated
export const getReferralStats = async (req, res) => {
  try {
    const usersSnap = await admin.firestore().collection('users').get();
    let totalWalletGenerated = 0;
    let totalReferrals = 0;
    const referralBreakdown = [];

    usersSnap.forEach(userDoc => {
      const userData = userDoc.data();
      const walletBalance = userData.walletBalance || 0;
      totalWalletGenerated += walletBalance;
      
      if (userData.referralCode) {
        totalReferrals++;
        referralBreakdown.push({
          uid: userDoc.id,
          fullName: userData.fullName || 'N/A',
          referralCode: userData.referralCode,
          walletBalance: walletBalance,
        });
      }
    });

    return res.status(200).json({
      success: true,
      totalWalletGenerated,
      totalUsersWithReferral: totalReferrals,
      referralBreakdown: referralBreakdown.sort((a, b) => b.walletBalance - a.walletBalance),
    });
  } catch (err) {
    console.error('getReferralStats error', err);
    return res.status(500).json({ message: 'Could not get referral stats' });
  }
};

// Admin: list all contact submissions
export const listContacts = async (req, res) => {
  try {
    const snap = await admin.firestore().collection('contacts').orderBy('createdAt', 'desc').limit(500).get();
    const contacts = [];
    snap.forEach(doc => {
      const data = doc.data();
      contacts.push({
        id: doc.id,
        name: data.name || 'N/A',
        subject: data.subject || 'N/A',
        // Return encrypted message and email objects for frontend decryption
        email: data.email || null,
        message: data.message || null,
        createdAt: data.createdAt ? data.createdAt.toMillis ? data.createdAt.toMillis() : data.createdAt : null,
      });
    });
    return res.status(200).json({ success: true, contacts, totalContacts: contacts.length });
  } catch (err) {
    console.error('listContacts error', err);
    return res.status(500).json({ message: 'Could not list contacts' });
  }
};

// Admin: delete a contact submission
export const deleteContact = async (req, res) => {
  try {
    const { contactId } = req.params;
    if (!contactId) return res.status(400).json({ message: 'Missing contactId' });

    const contactRef = admin.firestore().collection('contacts').doc(contactId);
    const snap = await contactRef.get();
    if (!snap.exists) return res.status(404).json({ message: 'Contact not found' });

    await contactRef.delete();

    return res.status(200).json({ success: true, message: 'Contact deleted' });
  } catch (err) {
    console.error('deleteContact error', err);
    return res.status(500).json({ message: 'Could not delete contact' });
  }
};

// Admin: decrypt a contact message
export const decryptContactMessage = async (req, res) => {
  try {
    const encryptedMessage = req.body;

    if (!encryptedMessage || !encryptedMessage.iv || !encryptedMessage.tag || !encryptedMessage.data) {
      return res.status(400).json({ message: 'Invalid encrypted message format' });
    }

    try {
      const decrypted = decryptToUTF8(encryptedMessage);
      return res.status(200).json({ success: true, decrypted });
    } catch (decryptErr) {
      console.error('Decryption failed:', decryptErr.message);
      return res.status(400).json({ message: 'Decryption failed: ' + decryptErr.message });
    }
  } catch (err) {
    console.error('decryptContactMessage error', err);
    return res.status(500).json({ message: 'Could not decrypt message' });
  }
};

// Admin: delete a user and all their associated data
export const deleteUser = async (req, res) => {
  try {
    const { uid } = req.params;
    if (!uid) return res.status(400).json({ message: 'Missing uid' });

    // Verify user exists
    const userRef = admin.firestore().doc(`users/${uid}`);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).json({ message: 'User not found' });
    }

    const userData = userSnap.data();
    console.log(`[ADMIN] Starting deletion of user ${uid} (${userData?.email || 'unknown'})`);

    try {
      // Delete all user's orders
      const ordersSnap = await userRef.collection('orders').get();
      console.log(`[ADMIN] Deleting ${ordersSnap.size} orders for user ${uid}`);
      const batch1 = admin.firestore().batch();
      ordersSnap.forEach(doc => {
        batch1.delete(doc.ref);
      });
      if (ordersSnap.size > 0) await batch1.commit();

      // Delete all user's transactions
      const transactionsSnap = await userRef.collection('transactions').get();
      console.log(`[ADMIN] Deleting ${transactionsSnap.size} transactions for user ${uid}`);
      const batch2 = admin.firestore().batch();
      transactionsSnap.forEach(doc => {
        batch2.delete(doc.ref);
      });
      if (transactionsSnap.size > 0) await batch2.commit();

      // Delete all user's payment history
      const paymentSnap = await userRef.collection('paymentHistory').get();
      console.log(`[ADMIN] Deleting ${paymentSnap.size} payment history entries for user ${uid}`);
      const batch3 = admin.firestore().batch();
      paymentSnap.forEach(doc => {
        batch3.delete(doc.ref);
      });
      if (paymentSnap.size > 0) await batch3.commit();

      // Delete the user document from Firebase Authentication if possible
      try {
        await admin.auth().deleteUser(uid);
        console.log(`[ADMIN] Deleted user from Firebase Auth: ${uid}`);
      } catch (authErr) {
        console.warn(`[ADMIN] Could not delete user from Auth (may not exist): ${uid}`, authErr.message);
      }

      // Delete the user document from Firestore
      await userRef.delete();
      console.log(`[ADMIN] Successfully deleted user ${uid} and all associated data`);

      // Broadcast log
      broadcastServerLog(`✅ Admin deleted user: ${uid} (${userData?.email || 'unknown'})`);

      return res.status(200).json({
        success: true,
        message: 'User and all associated data deleted successfully',
        deletedUser: {
          uid,
          email: userData?.email,
          fullName: userData?.fullName
        }
      });
    } catch (deleteErr) {
      console.error(`[ADMIN] Error during user deletion process: ${uid}`, deleteErr);
      broadcastServerLog(`❌ Error deleting user ${uid}: ${deleteErr.message}`);
      throw deleteErr;
    }
  } catch (err) {
    console.error('deleteUser error', err);
    return res.status(500).json({ message: 'Could not delete user: ' + (err?.message || 'Unknown error') });
  }
};

// Admin: delete a specific order
export const deleteOrder = async (req, res) => {
  try {
    const { uid, orderId } = req.params;
    if (!uid || !orderId) {
      return res.status(400).json({ message: 'Missing uid or orderId' });
    }

    // Get order reference
    const orderRef = admin.firestore().collection('users').doc(uid).collection('orders').doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const orderData = orderSnap.data();
    console.log(`[ADMIN] Deleting order ${orderId} for user ${uid}`);

    try {
      // Delete order
      await orderRef.delete();

      // Delete related order history if exists
      try {
        const historyRef = admin.firestore().collection('users').doc(uid).collection('history').doc(orderId);
        await historyRef.delete();
      } catch (historyErr) {
        console.warn(`[ADMIN] Could not delete order history: ${orderId}`, historyErr.message);
      }

      console.log(`[ADMIN] Successfully deleted order ${orderId} for user ${uid}`);

      // Broadcast log
      broadcastServerLog(`✅ Admin deleted order: ${orderId} for user ${uid}`);

      return res.status(200).json({
        success: true,
        message: 'Order deleted successfully',
        deletedOrder: {
          orderId,
          uid,
          status: orderData?.status,
          total: orderData?.total,
          createdAt: orderData?.createdAt
        }
      });
    } catch (deleteErr) {
      console.error(`[ADMIN] Error during order deletion: ${orderId}`, deleteErr);
      broadcastServerLog(`❌ Error deleting order ${orderId}: ${deleteErr.message}`);
      throw deleteErr;
    }
  } catch (err) {
    console.error('deleteOrder error', err);
    return res.status(500).json({ message: 'Could not delete order: ' + (err?.message || 'Unknown error') });
  }
};

// Admin: send email to multiple users
export const sendEmailToUsers = async (req, res) => {
  try {
    const { recipients, subject, message, isHtml } = req.body;

    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ message: 'Recipients array is required' });
    }

    if (!subject || !message) {
      return res.status(400).json({ message: 'Subject and message are required' });
    }

    // Validate email addresses
    const validEmails = recipients.filter(email => {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      return emailRegex.test(email);
    });

    if (validEmails.length === 0) {
      return res.status(400).json({ message: 'No valid email addresses provided' });
    }

    console.log(`[ADMIN] Sending email to ${validEmails.length} users...`);

    // Send bulk email
    const result = await sendBulkEmail({
      recipients: validEmails,
      subject,
      html: isHtml ? message : `<p>${message.replace(/\n/g, '<br>')}</p>`,
    });

    console.log(`[ADMIN] Bulk email result:`, result);

    return res.status(200).json({
      success: true,
      message: 'Email send completed',
      sentCount: result.sent?.length || 0,
      failedCount: result.failed?.length || 0,
      skippedCount: recipients.length - validEmails.length,
      failed: result.failed || [],
    });
  } catch (err) {
    console.error('[ADMIN] sendEmailToUsers error:', err);
    return res.status(500).json({ message: 'Failed to send email: ' + (err?.message || 'Unknown error') });
  }
};

// Admin: add money to user's wallet
export const addMoneyToWallet = async (req, res) => {
  try {
    const { uid } = req.params;
    const { amount } = req.body;

    if (!uid) {
      return res.status(400).json({ message: 'User ID is required' });
    }

    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ message: 'Valid amount greater than 0 is required' });
    }

    const userRef = admin.firestore().collection('users').doc(uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ message: 'User not found' });
    }

    const userData = userDoc.data();
    const currentBalance = userData.wallet?.balance || 0;
    const newBalance = currentBalance + parseFloat(amount);

    // Update wallet balance
    await userRef.update({
      'wallet.balance': newBalance,
      'wallet.lastUpdatedAt': new Date().toISOString(),
    });

    // Log transaction in history/audit trail if exists
    const historyRef = userRef.collection('walletHistory').doc();
    await historyRef.set({
      type: 'admin_credit',
      amount: parseFloat(amount),
      previousBalance: currentBalance,
      newBalance: newBalance,
      description: 'Manual credit by admin',
      createdAt: new Date().toISOString(),
    });

    // Notify user via WebSocket if they're connected
    await notifyUser(uid, {
      type: 'wallet_balance_update',
      balance: newBalance,
      amount: parseFloat(amount),
      message: `Your wallet has been credited with ₦${parseFloat(amount).toLocaleString()}`,
    });

    console.log(`[ADMIN] Added ₦${amount} to user ${uid}'s wallet. New balance: ₦${newBalance}`);

    // Return updated user data
    const updatedUserDoc = await userRef.get();
    return res.status(200).json({
      success: true,
      message: 'Money added successfully',
      user: {
        uid: updatedUserDoc.id,
        ...updatedUserDoc.data(),
      },
    });
  } catch (err) {
    console.error('[ADMIN] addMoneyToWallet error:', err);
    return res.status(500).json({ message: 'Failed to add money to wallet: ' + (err?.message || 'Unknown error') });
  }
};
