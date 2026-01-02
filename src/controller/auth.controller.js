import admin from "../config/firebase.js";
import { sendOtpByEmail } from "../utils/mailer.js";

// Temporary in-memory OTP store. For production use a persistent store like Redis.
const otpStore = new Map();

function generateOtp() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

async function scheduleOtpExpiry(uid, ttlMs = 5 * 60 * 1000) {
  setTimeout(() => otpStore.delete(uid), ttlMs);
}

// Helper to log full error for developers and send a sanitized message to client
function makeDebugId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
}

function logAndRespond(res, err, userMessage = 'An unexpected error occurred', status = 500) {
  const debugId = makeDebugId();
  // Log full details for developers
  console.error(`DebugId=${debugId} -`, err && err.stack ? err.stack : err);
  // Send sanitized message to client with debugId for correlation
  return res.status(status).json({ message: userMessage, debugId });
}

// ================= SIGNUP =================
export const signup = async (req, res) => {
  try {
    const { fullName, email, phone, password } = req.body;

    // Basic input validation/sanitization
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ message: 'Valid email required' });
    if (!password || String(password).length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters' });

    const user = await admin.auth().createUser({
      email,
      password,
      phoneNumber: phone,
      displayName: fullName,
    });

    // Realtime Database writes removed; using Firestore for user records.

    // Also create an initial Firestore document for the user with empty sections
    try {
      await admin.firestore().doc(`users/${user.uid}`).set({
        uid: user.uid,
        fullName: fullName || user.displayName || null,
        email: email || null,
        phone: phone || null,
        wallet: { balance: 0 },
        dashboardMessage: 'Place your order now to get free delivery on your next order',
        createdAt: Date.now(),
        role: 'user',
      }, { merge: true });
    } catch (fsErr) {
      console.error('Failed to write user document to Firestore', fsErr);
    }

    // Generate and store OTP (mocking SMS send). In production call your SMS provider here.
    const otp = generateOtp();
    otpStore.set(user.uid, { otp, createdAt: Date.now() });
    scheduleOtpExpiry(user.uid);


    // Send OTP by email. If mail fails, log but still return success to avoid leaking implementation details.
    try {
      if (email) await sendOtpByEmail({ to: email, otp });
    } catch (mailErr) {
      console.error('Error sending OTP email', mailErr);
    }

    res.status(201).json({
      success: true,
      message: "Signup successful. OTP sent to phone.",
      uid: user.uid,
    });
  } catch (error) {
    // Friendly message for user, full error logged for devs
    return logAndRespond(res, error, 'Could not create account. Please check your details and try again.', 400);
  }
};

// ================= LOGIN (SEND OTP) =================
export const login = async (req, res) => {
  try {
    const { phone } = req.body;

    const user = await admin.auth().getUserByPhoneNumber(phone);
    // generate OTP for the user and send to their email if available
    const otp = generateOtp();
    otpStore.set(user.uid, { otp, createdAt: Date.now() });
    scheduleOtpExpiry(user.uid);
    console.log(`OTP for login (uid=${user.uid}, phone=${phone || 'N/A'}, email=${user.email || 'N/A'}): ${otp}`);
    try {
      if (user.email) await sendOtpByEmail({ to: user.email, otp });
    } catch (mailErr) {
      console.error('Failed to send login OTP email', mailErr);
    }

    res.status(200).json({ success: true, message: 'OTP sent', uid: user.uid });
  } catch (error) {
    // Avoid user enumeration: always return a generic success message
    console.warn('login lookup failed:', error && error.message ? error.message : error);
    return res.status(200).json({ success: true, message: 'If an account exists for this phone number, an OTP has been sent' });
  }
};

// ================= VERIFY OTP =================
export const verifyOtp = async (req, res) => {
  try {
    const { idToken } = req.body;

    const decodedToken = await admin.auth().verifyIdToken(idToken);

    res.status(200).json({
      success: true,
      message: "OTP verified",
      user: decodedToken,
    });
  } catch (error) {
    return logAndRespond(res, error, 'Invalid or expired OTP', 401);
  }
};

// Verify either via Firebase ID token OR via uid+otp (development/test helper)
export const verifyOtpOrCode = async (req, res) => {
  try {
    const { idToken, uid, otp } = req.body;

    if (idToken) {
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      const uidFromToken = decodedToken.uid;
      // issue server session token and persist it on the user document (single-session enforcement)
      try {
        const sessionToken = `sess_${makeDebugId()}`;
        await admin.firestore().doc(`users/${uidFromToken}`).set({ currentSession: sessionToken, sessionIssuedAt: Date.now() }, { merge: true });
        return res.status(200).json({ success: true, message: 'OTP verified', user: decodedToken, sessionToken });
      } catch (e) {
        console.error('Failed to persist session token', e);
        return res.status(200).json({ success: true, message: 'OTP verified', user: decodedToken });
      }
    }

    if (uid && otp) {
      const record = otpStore.get(uid);
      if (record && record.otp === String(otp)) {
        otpStore.delete(uid);
        // create server session token and persist to Firestore (single active session)
        try {
          const sessionToken = `sess_${makeDebugId()}`;
          await admin.firestore().doc(`users/${uid}`).set({ currentSession: sessionToken, sessionIssuedAt: Date.now() }, { merge: true });
          return res.status(200).json({ success: true, message: 'OTP verified (by code)', uid, sessionToken });
        } catch (e) {
          console.error('Failed to persist session token after OTP', e);
          return res.status(200).json({ success: true, message: 'OTP verified (by code)', uid });
        }
      }
      return res.status(401).json({ message: 'Invalid OTP' });
    }

    return res.status(400).json({ message: 'Missing verification parameters' });
  } catch (error) {
    return logAndRespond(res, error, 'Verification failed', 500);
  }
};

// ================= BULK SIGNUP =================
// Create many users with a concurrency limit to avoid overwhelming the Firebase API
async function asyncPool(poolLimit, array, iteratorFn) {
  const ret = [];
  const executing = [];
  let i = 0;
  const enqueue = () => {
    if (i === array.length) return Promise.resolve();
    const item = array[i++];
    const p = Promise.resolve().then(() => iteratorFn(item));
    ret.push(p);
    const e = p.then(() => executing.splice(executing.indexOf(e), 1));
    executing.push(e);
    let r = Promise.resolve();
    if (executing.length >= poolLimit) r = Promise.race(executing);
    return r.then(() => enqueue());
  };
  return enqueue().then(() => Promise.all(ret));
}

export const signupBulk = async (req, res) => {
  try {
    const users = req.body.users || [];
    // Require admin API key for bulk operations
    const adminKey = req.headers['x-admin-key'];
    if (!process.env.ADMIN_API_KEY || adminKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    if (!Array.isArray(users) || users.length === 0) return res.status(400).json({ message: 'Provide an array of users' });

    // Allow caller to set concurrency via query, default to 50
    const concurrency = Math.max(5, Math.min(200, parseInt(req.query.concurrency) || 50));

    const results = [];

    await asyncPool(concurrency, users, async (u) => {
      try {
        const { fullName, email, phone, password } = u;
        if (!email || !/^\S+@\S+\.\S+$/.test(email)) throw new Error('Invalid email');
        if (!password || String(password).length < 8) throw new Error('Invalid password');
        const created = await admin.auth().createUser({
          email,
          password,
          phoneNumber: phone,
          displayName: fullName,
        });

        // Realtime Database writes removed; using Firestore for user records.

        // Also create Firestore document for each created user
        try {
          await admin.firestore().doc(`users/${created.uid}`).set({
            uid: created.uid,
            fullName: fullName || created.displayName || null,
            email: email || null,
            phone: phone || null,
            wallet: { balance: 0 },
            dashboardMessage: 'Place your order now to get free delivery on your next order',
            createdAt: Date.now(),
            role: 'user',
          }, { merge: true });
        } catch (fsErr) {
          console.error('Failed to write bulk-created user to Firestore', fsErr);
        }

        // generate OTP for each created user (dev/test only)
        const otp = generateOtp();
        otpStore.set(created.uid, { otp, createdAt: Date.now() });
        scheduleOtpExpiry(created.uid);
        console.log(`OTP for bulk signup (uid=${created.uid}, phone=${phone || 'N/A'}, email=${email || 'N/A'}): ${otp}`);
        try {
          if (email) await sendOtpByEmail({ to: email, otp });
        } catch (mailErr) {
          console.error('Error sending bulk OTP email for', email, mailErr.message || mailErr);
        }

        results.push({ success: true, uid: created.uid });
      } catch (err) {
        results.push({ success: false, error: err.message || String(err) });
      }
    });

    res.status(200).json({ success: true, results, total: users.length });
  } catch (error) {
    return logAndRespond(res, error, 'Bulk signup failed', 500);
  }
};
