import admin from "../config/firebase.js";
import bcryptjs from "bcryptjs";
import { sendOtpByEmail } from "../utils/mailer.js";

// Temporary in-memory OTP store. For production use a persistent store like Redis.
const otpStore = new Map();

function generateOtp() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

async function scheduleOtpExpiry(uid, ttlMs = 5 * 60 * 1000) {
  setTimeout(() => otpStore.delete(uid), ttlMs);
}

// OTP TTL and helper
const OTP_TTL_MS = 5 * 60 * 1000;
function hasValidOtp(uid) {
  const rec = otpStore.get(uid);
  if (!rec) return false;
  return (Date.now() - (rec.createdAt || 0)) < OTP_TTL_MS;
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
    const { fullName, email, phone, password, rememberMe } = req.body;

    // Input validation with detailed error messages
    if (!fullName || String(fullName).trim().length === 0) {
      return res.status(400).json({ message: 'Full name is required' });
    }
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ message: 'Valid email address is required' });
    }
    if (!phone || String(phone).trim().length < 10) {
      return res.status(400).json({ message: 'Valid phone number is required (at least 10 digits)' });
    }
    if (!password || String(password).length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters long' });
    }

    // Get client IP address for "remember me" feature
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || 
                     req.socket?.remoteAddress || 
                     req.connection?.remoteAddress || 
                     'unknown';

    try {
      const user = await admin.auth().createUser({
        email,
        password,
        phoneNumber: phone,
        displayName: fullName,
      });

      // Hash password for storage in database (security best practice)
      const hashedPassword = await bcryptjs.hash(password, 10);

      // Create Firestore document with password hash and IP tracking
      try {
        await admin.firestore().doc(`users/${user.uid}`).set({
          uid: user.uid,
          fullName: fullName.trim(),
          email: email.toLowerCase(),
          phone: phone,
          passwordHash: hashedPassword,
          rememberMe: rememberMe === true,
          lastLoginIp: clientIp,
          registeredIp: clientIp,
          trustedIps: rememberMe === true ? [clientIp] : [],
          wallet: { balance: 0 },
          dashboardMessage: 'Place your order now to get free delivery on your next order',
          createdAt: Date.now(),
          lastLoginAt: Date.now(),
          role: 'user',
        }, { merge: true });
      } catch (fsErr) {
        console.error('Failed to write user document to Firestore', fsErr);
      }

      // If an OTP was already generated recently, don't resend
      if (hasValidOtp(user.uid)) {
        console.log(`i [SIGNUP] Existing valid OTP present for ${email}, not resending`);
        return res.status(200).json({ success: true, message: 'OTP already sent', uid: user.uid, email });
      }

      // Generate and store OTP
      const otp = generateOtp();
      otpStore.set(user.uid, { otp, createdAt: Date.now() });
      scheduleOtpExpiry(user.uid);

      // Send OTP by email
      let emailSent = false;
      try {
        if (email) {
          await sendOtpByEmail({ to: email, otp });
          emailSent = true;
          console.log(`✓ [SIGNUP] OTP email sent successfully to ${email}`);
        }
      } catch (mailErr) {
        console.error(`✗ [SIGNUP] Failed to send OTP email to ${email}:`, mailErr.message);
      }
      if (!emailSent && email) {
        console.warn(`[SIGNUP] Email could not be sent to ${email}. User must verify via OTP code instead.`);
      }

      console.log(`✓ [SIGNUP] New user registered: ${email} from IP ${clientIp}`);

      res.status(201).json({
        success: true,
        message: "Signup successful. OTP sent to your email.",
        uid: user.uid,
        email: email,
      });
    } catch (authErr) {
      // Handle specific Firebase Auth errors
      if (authErr.code === 'auth/email-already-exists') {
        return res.status(400).json({ message: 'Email address is already registered. Please login instead.' });
      }
      if (authErr.code === 'auth/invalid-email') {
        return res.status(400).json({ message: 'Invalid email format' });
      }
      if (authErr.code === 'auth/weak-password') {
        return res.status(400).json({ message: 'Password is too weak. Use at least 8 characters with letters and numbers.' });
      }
      throw authErr;
    }
  } catch (error) {
    console.error(`✗ [SIGNUP] Error:`, error.message);
    return logAndRespond(res, error, 'Could not create account. Please check your details and try again.', 400);
  }
};

// ================= LOGIN (SEND OTP) =================
export const login = async (req, res) => {
  try {
    const { phone, rememberMe } = req.body;

    if (!phone || String(phone).trim().length < 10) {
      return res.status(400).json({ message: 'Valid phone number is required' });
    }

    // Get client IP for remember me
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || 
                     req.socket?.remoteAddress || 
                     req.connection?.remoteAddress || 
                     'unknown';

    const user = await admin.auth().getUserByPhoneNumber(phone);
    
    // Check if user is logging in from a trusted IP (remember me feature)
    const userDoc = await admin.firestore().doc(`users/${user.uid}`).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    
    if (userData.rememberMe && userData.trustedIps && userData.trustedIps.includes(clientIp)) {
      // Auto-login from trusted IP
      console.log(`✓ [LOGIN] Auto-login from trusted IP ${clientIp} for user ${user.uid}`);
      try {
        const sessionToken = `sess_${makeDebugId()}`;
        await admin.firestore().doc(`users/${user.uid}`).set({
          currentSession: sessionToken,
          sessionIssuedAt: Date.now(),
          lastLoginIp: clientIp,
          lastLoginAt: Date.now(),
        }, { merge: true });
        return res.status(200).json({
          success: true,
          message: 'Auto-login successful',
          uid: user.uid,
          sessionToken,
          autoLogin: true,
        });
      } catch (e) {
        console.error('Failed to create auto-login session', e);
      }
    }

    // Standard OTP flow
    const otp = generateOtp();
    otpStore.set(user.uid, { otp, createdAt: Date.now(), rememberMe: rememberMe === true });
    scheduleOtpExpiry(user.uid);
    
    let emailSent = false;
    try {
      if (user.email) {
        await sendOtpByEmail({ to: user.email, otp });
        emailSent = true;
        console.log(`✓ [LOGIN] OTP email sent successfully to ${user.email}`);
      } else {
        console.warn(`[LOGIN] No email on file for user ${user.uid}. Could not send OTP email.`);
      }
    } catch (mailErr) {
      console.error(`✗ [LOGIN] Failed to send OTP email to ${user.email}:`, mailErr.message);
    }
    if (!emailSent && !user.email) {
      console.warn(`[LOGIN] User ${user.uid} must verify via OTP code instead of email.`);
    }

    console.log(`[LOGIN] OTP requested for user ${user.uid} from IP ${clientIp}${rememberMe ? ' (remember me enabled)' : ''}`);

    res.status(200).json({ success: true, message: 'OTP sent to your email', uid: user.uid });
  } catch (error) {
    // Avoid user enumeration: always return a generic success message
    console.warn('login lookup failed:', error && error.message ? error.message : error);
    return res.status(200).json({ success: true, message: 'If an account exists for this phone number, an OTP has been sent' });
  }
};

// ================= LOGIN WITH PASSWORD =================
export const loginWithPassword = async (req, res) => {
  try {
    const { phone, password, rememberMe } = req.body;

    if (!phone || String(phone).trim().length < 10) {
      return res.status(400).json({ message: 'Valid phone number is required' });
    }
    if (!password || String(password).length === 0) {
      return res.status(400).json({ message: 'Password is required' });
    }

    // Get client IP for remember me
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || 
                     req.socket?.remoteAddress || 
                     req.connection?.remoteAddress || 
                     'unknown';

    // Look up user document by phone in Firestore to avoid depending on
    // admin.auth network lookup (which can fail with DNS/proxy issues).
    const usersRef = admin.firestore().collection('users');
    const qSnap = await usersRef.where('phone', '==', phone).limit(1).get();
    if (qSnap.empty) {
      // Do not reveal whether phone exists
      return res.status(401).json({ message: 'Invalid phone number or password' });
    }
    const userDoc = qSnap.docs[0];
    const userData = userDoc.data();
    const uid = userData.uid || userDoc.id;
    const passwordHash = userData?.passwordHash;

    if (!passwordHash) {
      return res.status(401).json({ message: 'Invalid phone number or password' });
    }

    // Verify password using bcrypt
    const passwordMatch = await bcryptjs.compare(password, passwordHash);
    if (!passwordMatch) {
      console.warn(`[LOGIN PASSWORD] Failed login attempt for user ${user.uid} from IP ${clientIp}`);
      return res.status(401).json({ message: 'Invalid phone number or password' });
    }

    // Check if user is logging in from a trusted IP (remember me feature)
    if (userData.rememberMe && userData.trustedIps && userData.trustedIps.includes(clientIp)) {
      console.log(`✓ [LOGIN PASSWORD] Auto-login from trusted IP ${clientIp} for user ${uid}`);
    }

    // Create session token
    const sessionToken = `sess_${makeDebugId()}`;
    const trustedIps = [...(userData.trustedIps || [])];
    if (rememberMe && !trustedIps.includes(clientIp)) {
      trustedIps.push(clientIp);
    }

    try {
      await admin.firestore().doc(`users/${uid}`).set({
        currentSession: sessionToken,
        sessionIssuedAt: Date.now(),
        lastLoginIp: clientIp,
        lastLoginAt: Date.now(),
        rememberMe: rememberMe === true,
        trustedIps: rememberMe ? trustedIps : [],
      }, { merge: true });
    } catch (e) {
      console.error('Failed to persist login session', e);
    }

    console.log(`✓ [LOGIN PASSWORD] User ${uid} logged in successfully from IP ${clientIp}`);

    res.status(200).json({
      success: true,
      message: 'Login successful',
      uid,
      sessionToken,
      user: {
        uid,
        email: userData.email,
        displayName: userData.fullName || userData.displayName,
      },
    });
  } catch (error) {
    console.error(`✗ [LOGIN PASSWORD] Error:`, error && error.message ? error.message : error);
    // Return generic message to avoid leaking internals
    return res.status(401).json({ message: 'Invalid phone number or password' });
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

    // Get client IP for remember me feature
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || 
                     req.socket?.remoteAddress || 
                     req.connection?.remoteAddress || 
                     'unknown';

    if (idToken) {
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      const uidFromToken = decodedToken.uid;
      // issue server session token and persist it on the user document (single-session enforcement)
      try {
        const sessionToken = `sess_${makeDebugId()}`;
        await admin.firestore().doc(`users/${uidFromToken}`).set({
          currentSession: sessionToken,
          sessionIssuedAt: Date.now(),
          lastLoginIp: clientIp,
          lastLoginAt: Date.now(),
        }, { merge: true });
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
          const userRef = admin.firestore().doc(`users/${uid}`);
          
          // Get current user data to update remember me settings
          const userSnap = await userRef.get();
          const userData = userSnap.exists ? userSnap.data() : {};
          
          // If user has remember me enabled, add this IP to trusted IPs
          const updatedData = {
            currentSession: sessionToken,
            sessionIssuedAt: Date.now(),
            lastLoginIp: clientIp,
            lastLoginAt: Date.now(),
          };
          
          if (userData.rememberMe) {
            const trustedIps = userData.trustedIps || [];
            if (!trustedIps.includes(clientIp)) {
              updatedData.trustedIps = [...trustedIps, clientIp];
              console.log(`✓ [VERIFY OTP] Added trusted IP ${clientIp} for user ${uid}`);
            }
          }
          
          await userRef.set(updatedData, { merge: true });
          console.log(`✓ [VERIFY OTP] OTP verified successfully for user ${uid} from IP ${clientIp}`);
          
          return res.status(200).json({ success: true, message: 'OTP verified (by code)', uid, sessionToken });
        } catch (e) {
          console.error('Failed to persist session token after OTP', e);
          return res.status(200).json({ success: true, message: 'OTP verified (by code)', uid });
        }
      }
      console.error(`✗ [VERIFY OTP] Invalid OTP attempt for user ${uid}`);
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
        try {
          if (email) {
            await sendOtpByEmail({ to: email, otp });
            console.log(`✓ [BULK SIGNUP] OTP email sent successfully to ${email}`);
          } else {
            console.warn(`[BULK SIGNUP] No email for user ${fullName}. OTP code will be used instead.`);
          }
        } catch (mailErr) {
          console.error(`✗ [BULK SIGNUP] Failed to send OTP email to ${email}:`, mailErr.message);
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
