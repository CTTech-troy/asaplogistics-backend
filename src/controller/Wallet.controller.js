import admin from '../config/firebase.js';

// Get wallet summary for authenticated user
export const getWallet = async (req, res) => {
  try {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ message: 'Unauthorized' });

    const userDoc = await admin.firestore().doc(`users/${uid}`).get();
    const data = userDoc.exists ? userDoc.data() : null;
    const wallet = (data && data.wallet) || { balance: 0 };
    return res.status(200).json({ success: true, wallet });
  } catch (err) {
    console.error('getWallet error', err);
    return res.status(500).json({ message: 'Could not fetch wallet' });
  }
};

// Create a wallet transaction (credit or debit) — updates balance transactionally
export const createTransaction = async (req, res) => {
  try {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ message: 'Unauthorized' });

    const { amount, type = 'credit', note = '' } = req.body;
    const numericAmount = Number(amount || 0);
    if (!numericAmount || !['credit', 'debit'].includes(type)) return res.status(400).json({ message: 'Invalid transaction' });

    const userRef = admin.firestore().doc(`users/${uid}`);

    const txResult = await admin.firestore().runTransaction(async (t) => {
      const snap = await t.get(userRef);
      const data = snap.exists ? snap.data() : {};
      const current = (data.wallet && Number(data.wallet.balance)) || 0;
      const newBalance = type === 'credit' ? current + numericAmount : current - numericAmount;
      if (newBalance < 0) throw new Error('Insufficient funds');

      const txRef = userRef.collection('wallet').doc();
      const txDoc = {
        id: txRef.id,
        uid,
        amount: numericAmount,
        type,
        note,
        createdAt: Date.now(),
      };

      t.set(txRef, txDoc);
      t.set(userRef, { wallet: { balance: newBalance } }, { merge: true });
      return txDoc;
    });

    return res.status(201).json({ success: true, transaction: txResult });
  } catch (err) {
    console.error('createTransaction error', err);
    if (err.message && err.message.includes('Insufficient')) return res.status(400).json({ message: 'Insufficient funds' });
    return res.status(500).json({ message: 'Could not create transaction' });
  }
};

