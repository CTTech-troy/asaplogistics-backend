import admin from "../config/firebase.js";
import bcryptjs from "bcryptjs";
import { sendOtpByEmail } from "../utils/mailer.js";
import { validateAndGetReferrer, applyReferralCode, validateInviteToken, markInviteUsed } from "./referral.controller.js";

// OTP TTL for emails (milliseconds)
const OTP_TTL_MS = 5 * 60 * 1000;

function generateOtp() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

async function setOtpForUser(uid, otp, ttlMs = OTP_TTL_MS) {
  const saltRounds = 10;
  const otpHash = await bcryptjs.hash(String(otp), saltRounds);
  const expiresAt = Date.now() + ttlMs;
  try {
    await admin.firestore().doc(`users/${uid}`).set({ otpHash, otpExpiresAt: expiresAt }, { merge: true });
    console.log(`✓ [OTP] Stored OTP hash for user ${uid}, expiresAt=${new Date(expiresAt).toISOString()}`);
  } catch (err) {
    console.error(`✗ [OTP] Failed to store OTP for user ${uid}:`, err && err.message ? err.message : err);
    throw err;
  }
}

async function clearOtpForUser(uid) {
  try {
    await admin.firestore().doc(`users/${uid}`).set({ otpHash: null, otpExpiresAt: null }, { merge: true });
  } catch (err) {
    console.error(`✗ [OTP] Failed to clear OTP for user ${uid}:`, err && err.message ? err.message : err);
  }
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
    const { fullName, email, phone, password, rememberMe, referralCode } = req.body;

    // Check if new user signups are enabled (only applicable to non-admin users)
    const adminWhitelist = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.toLowerCase().trim()).filter(Boolean);
    const isAdminSignup = adminWhitelist.includes(email?.toLowerCase().trim() || '');

    if (!isAdminSignup) {
      let appSettings = {};
      try {
        const settingsSnap = await admin.firestore().doc('settings/app').get();
        appSettings = settingsSnap.exists ? settingsSnap.data() : { signUpNewUsers: true };
      } catch (err) {
        console.warn('[SIGNUP] Could not fetch app settings:', err && err.message ? err.message : err);
        appSettings = { signUpNewUsers: true };
      }

      if (appSettings.signUpNewUsers === false) {
        return res.status(403).json({ 
          message: 'New user registration is currently disabled. Please contact support.' 
        });
      }
    } else {
      console.log(`✓ [SIGNUP] Admin signup bypass enabled for ${email}`);
    }

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
      // Set role to 'admin' if this is an admin signup, otherwise 'user'
      const adminWhitelist = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.toLowerCase().trim()).filter(Boolean);
      const userRole = adminWhitelist.includes(email?.toLowerCase().trim() || '') ? 'admin' : 'user';

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
          createdAt: Date.now(),
          lastLoginAt: Date.now(),
          role: userRole,
        }, { merge: true });
        if (userRole === 'admin') {
          console.log(`✓ [SIGNUP] Admin account created: ${email}`);
        }
      } catch (fsErr) {
        console.error('Failed to write user document to Firestore', fsErr);
      }

      // Handle invite token (one-time) or referral code (reusable)
      const { inviteToken } = req.body;
      if (inviteToken) {
        try {
          const v = await validateInviteToken(inviteToken);
          if (v.valid) {
            const referrerUid = v.referrerUid;
            // get referrer's code for record
            const refSnap = await admin.firestore().doc(`users/${referrerUid}`).get();
            const refData = refSnap.exists ? refSnap.data() : {};
            const refCode = refData.referralCode || null;
            const applyResult = await applyReferralCode(refCode, user.uid, referrerUid);
            console.log(`✓ [SIGNUP] Invite applied: ${applyResult.message}`);
            // mark invite used
            await markInviteUsed(v.inviteId, user.uid);
          } else {
            console.warn('[SIGNUP] Invalid or expired invite token');
          }
        } catch (e) {
          console.error('[SIGNUP] Error applying invite token:', e && e.message ? e.message : e);
        }
      } else if (referralCode) {
        const referrerInfo = await validateAndGetReferrer(referralCode);
        if (referrerInfo.valid) {
          const applyResult = await applyReferralCode(referralCode, user.uid, referrerInfo.referrerId);
          console.log(`✓ [SIGNUP] Referral applied: ${applyResult.message}`);
        } else {
          console.warn(`[SIGNUP] Invalid referral code: ${referralCode}`);
        }
      }

      // Generate OTP, persist hashed OTP in Firestore, and send via SMTP
      const otp = generateOtp();
      try {
        await setOtpForUser(user.uid, otp);
      } catch (err) {
        console.error('[SIGNUP] Could not persist OTP to datastore:', err && err.message ? err.message : err);
      }

      // Send OTP by email
      let emailSent = false;
      try {
        if (email) {
          await sendOtpByEmail({ to: email, otp });
          emailSent = true;
          console.log(`✓ [SIGNUP] OTP email sent successfully to ${email}`);
        }
      } catch (mailErr) {
        console.error(`✗ [SIGNUP] Failed to send OTP email to ${email}:`, mailErr && mailErr.message ? mailErr.message : mailErr);
      }
      if (!emailSent && email) {
        console.warn(`[SIGNUP] Email could not be sent to ${email}. User must verify via OTP code instead.`);
      }

      console.log(`✓ [SIGNUP] New user registered: ${email} from IP ${clientIp}`);

      // Get app settings to check if signup flow should be displayed
      let appSettings = {};
      try {
        const settingsSnap = await admin.firestore().doc('settings/app').get();
        appSettings = settingsSnap.exists ? settingsSnap.data() : { showSignupFlow: true };
      } catch (err) {
        console.warn('[SIGNUP] Could not fetch app settings:', err && err.message ? err.message : err);
        appSettings = { showSignupFlow: true };
      }

      res.status(201).json({
        success: true,
        message: emailSent ? "Signup successful. OTP sent to your email." : "Signup successful but email could not be sent. Check console for OTP.",
        uid: user.uid,
        email: email,
        emailSent: emailSent,
        showSignupFlow: appSettings.showSignupFlow !== false,
        signUpNewUsers: appSettings.signUpNewUsers !== false,
        // Include OTP in dev mode for testing/development
        otp: process.env.NODE_ENV === 'development' ? otp : undefined,
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

    // Standard OTP flow: persist hashed OTP in Firestore, then email it
    const otp = generateOtp();
    try {
      await setOtpForUser(user.uid, otp, OTP_TTL_MS);
    } catch (err) {
      console.error('[LOGIN] Could not persist OTP to datastore:', err && err.message ? err.message : err);
    }

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
      console.error(`✗ [LOGIN] Failed to send OTP email to ${user.email}:`, mailErr && mailErr.message ? mailErr.message : mailErr);
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

    // Get app settings to check if IP verification is required
    let appSettings = {};
    try {
      const settingsSnap = await admin.firestore().doc('settings/app').get();
      appSettings = settingsSnap.exists ? settingsSnap.data() : { signUpNewUsers: true };
    } catch (err) {
      console.warn('[LOGIN PASSWORD] Could not fetch app settings:', err && err.message ? err.message : err);
      appSettings = { signUpNewUsers: true };
    }

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
      console.warn(`[LOGIN PASSWORD] Failed login attempt for user ${uid} from IP ${clientIp}`);
      return res.status(401).json({ message: 'Invalid phone number or password' });
    }

    // If signups are disabled, enforce IP matching for security
    if (appSettings.signUpNewUsers === false && userData.registeredIp && userData.registeredIp !== clientIp) {
      console.warn(`[LOGIN PASSWORD] IP mismatch for user ${uid}. Registered IP: ${userData.registeredIp}, Current IP: ${clientIp}`);
      return res.status(403).json({ 
        message: 'Login from different IP address is not allowed. Please contact support.',
        ipMismatch: true
      });
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
      try {
        const userRef = admin.firestore().doc(`users/${uid}`);
        const snap = await userRef.get();
        if (!snap.exists) {
          console.error(`✗ [VERIFY OTP] No user record for uid ${uid}`);
          return res.status(401).json({ message: 'Invalid OTP' });
        }
        const data = snap.data() || {};
        const { otpHash, otpExpiresAt } = data;
        if (!otpHash || !otpExpiresAt || Date.now() > otpExpiresAt) {
          console.error(`✗ [VERIFY OTP] OTP missing or expired for user ${uid}`);
          return res.status(401).json({ message: 'Invalid or expired OTP' });
        }

        const match = await bcryptjs.compare(String(otp), otpHash);
        if (!match) {
          console.error(`✗ [VERIFY OTP] Invalid OTP attempt for user ${uid}`);
          return res.status(401).json({ message: 'Invalid OTP' });
        }

        // OTP is valid. Clear stored OTP and create session token.
        await clearOtpForUser(uid);
        try {
          const sessionToken = `sess_${makeDebugId()}`;
          const updatedData = {
            currentSession: sessionToken,
            sessionIssuedAt: Date.now(),
            lastLoginIp: clientIp,
            lastLoginAt: Date.now(),
          };
          if (data.rememberMe) {
            const trustedIps = data.trustedIps || [];
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
      } catch (err) {
        console.error('✗ [VERIFY OTP] Error during verification:', err && err.message ? err.message : err);
        return res.status(500).json({ message: 'Verification failed' });
      }
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

// Admin Login: Verify email and password for admin access
export const adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    // Get user by email
    const usersSnap = await admin.firestore().collection('users').where('email', '==', email).limit(1).get();
    if (usersSnap.empty) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const userDoc = usersSnap.docs[0];
    const userData = userDoc.data();
    const uid = userDoc.id;

    // Check if user is admin (check role field)
    if (userData.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access denied' });
    }

    // Verify password using bcrypt (same as regular login)
    const passwordHash = userData?.passwordHash;
    if (!passwordHash) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const passwordMatch = await bcryptjs.compare(password, passwordHash);
    if (!passwordMatch) {
      console.warn(`[ADMIN LOGIN] Failed admin login attempt for user ${uid}`);
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    // Get client IP address
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || 
                     req.socket?.remoteAddress || 
                     req.connection?.remoteAddress || 
                     'unknown';

    // Create session token (not custom token) for admin
    const sessionToken = `sess_${makeDebugId()}`;
    try {
      await admin.firestore().doc(`users/${uid}`).set({
        currentSession: sessionToken,
        sessionIssuedAt: Date.now(),
        lastLoginIp: clientIp,
        lastLoginAt: Date.now(),
      }, { merge: true });
    } catch (e) {
      console.error('Failed to persist admin login session', e);
    }

    console.log(`✓ [ADMIN LOGIN] Admin logged in: ${email} from IP ${clientIp}`);

    return res.status(200).json({
      success: true,
      message: 'Admin login successful',
      token: sessionToken,
      adminToken: sessionToken,
      uid: uid,
      fullName: userData.fullName,
      email: userData.email,
      role: 'admin',
    });
  } catch (err) {
    console.error('[ADMIN LOGIN] Error:', err);
    return res.status(500).json({ message: 'Admin login failed' });
  }
};

// ================= SETTINGS =================
// Get app settings (signup flow control)
export const getAppSettings = async (req, res) => {
  try {
    const settingsSnap = await admin.firestore().doc('settings/app').get();
    const settings = settingsSnap.exists ? settingsSnap.data() : { showSignupFlow: true, signUpNewUsers: true };
    
    return res.status(200).json({
      success: true,
      settings: {
        showSignupFlow: settings.showSignupFlow !== false,
        signUpNewUsers: settings.signUpNewUsers !== false,
      },
    });
  } catch (err) {
    console.error('[GET SETTINGS] Error:', err);
    return res.status(500).json({ success: false, message: 'Failed to get settings' });
  }
};

// Update app settings (admin only)
export const updateAppSettings = async (req, res) => {
  try {
    // Check if user is authenticated as admin
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    let uid;
    let userDoc;

    // Handle session tokens (starting with 'sess_')
    if (String(token).startsWith('sess_')) {
      const usersRef = admin.firestore().collection('users');
      const qSnap = await usersRef.where('currentSession', '==', token).limit(1).get();
      
      if (qSnap.empty) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      
      userDoc = qSnap.docs[0];
      uid = userDoc.id;
    } else {
      // Handle Firebase ID tokens
      try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        uid = decodedToken.uid;
        userDoc = await admin.firestore().doc(`users/${uid}`).get();
      } catch (err) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
    }
    
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
      return res.status(403).json({ message: 'Forbidden: Admin access required' });
    }

    const { showSignupFlow, signUpNewUsers } = req.body;

    // Validate input - at least one setting must be provided
    const updates = {};
    
    if (showSignupFlow !== undefined && typeof showSignupFlow !== 'boolean') {
      return res.status(400).json({ message: 'showSignupFlow must be a boolean' });
    }
    if (showSignupFlow !== undefined) {
      updates.showSignupFlow = showSignupFlow;
    }

    if (signUpNewUsers !== undefined && typeof signUpNewUsers !== 'boolean') {
      return res.status(400).json({ message: 'signUpNewUsers must be a boolean' });
    }
    if (signUpNewUsers !== undefined) {
      updates.signUpNewUsers = signUpNewUsers;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'At least one setting must be provided' });
    }

    updates.updatedAt = Date.now();
    updates.updatedBy = uid;

    await admin.firestore().doc('settings/app').set(updates, { merge: true });

    console.log(`✓ [UPDATE SETTINGS] App settings updated:`, updates);

    return res.status(200).json({
      success: true,
      message: 'Settings updated successfully',
      settings: {
        showSignupFlow: showSignupFlow !== undefined ? showSignupFlow : undefined,
        signUpNewUsers: signUpNewUsers !== undefined ? signUpNewUsers : undefined,
      },
    });
  } catch (err) {
    console.error('[UPDATE SETTINGS] Error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update settings' });
  }
};
// ================= SEED ADMIN (DEV ONLY) =================
export const seedAdmin = async (req, res) => {
  try {
    // Only allow in development or if a special seed token is provided
    const seedToken = req.headers['x-seed-token'];
    const isDev = process.env.NODE_ENV === 'development';
    
    if (!isDev && seedToken !== process.env.SEED_TOKEN) {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    const adminEmail = 'admin@asaplogis.com';
    const adminPassword = 'admin123';
    
    // Hash the password
    const saltRounds = 10;
    const passwordHash = await bcryptjs.hash(adminPassword, saltRounds);
    
    // Check if admin already exists
    const existingAdmin = await admin.firestore().collection('users').where('email', '==', adminEmail).limit(1).get();
    
    if (!existingAdmin.empty) {
      const docId = existingAdmin.docs[0].id;
      // Update existing admin with password hash
      await admin.firestore().doc(`users/${docId}`).set({
        passwordHash,
        role: 'admin',
        updatedAt: Date.now(),
      }, { merge: true });
      
      console.log(`✓ [SEED] Updated existing admin user: ${adminEmail}`);
      return res.status(200).json({
        success: true,
        message: 'Admin user updated successfully',
        email: adminEmail,
        uid: docId,
      });
    }
    
    // Create new admin user
    const adminDoc = admin.firestore().collection('users').doc();
    const uid = adminDoc.id;
    
    await adminDoc.set({
      uid,
      email: adminEmail,
      fullName: 'Admin User',
      phone: '+1234567890',
      passwordHash,
      role: 'admin',
      walletBalance: 0,
      referralCode: `admin_${makeDebugId()}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    
    console.log(`✓ [SEED] Created new admin user: ${adminEmail} (${uid})`);
    
    return res.status(201).json({
      success: true,
      message: 'Admin user created successfully',
      email: adminEmail,
      uid,
      credentials: {
        email: adminEmail,
        password: adminPassword,
      },
    });
  } catch (err) {
    console.error('[SEED ADMIN] Error:', err);
    return res.status(500).json({ success: false, message: 'Seed failed' });
  }
};