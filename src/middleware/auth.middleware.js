import admin from '../config/firebase.js';

// Verify Firebase ID token from Authorization header and attach decoded token to req.user
export async function verifyToken(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      console.warn('[AUTH] Missing or invalid authorization header');
      return res.status(401).json({ message: 'Missing or invalid authorization header' });
    }
    const token = auth.split(' ')[1];
    console.log('[AUTH] Token received:', token.substring(0, 20) + '...');
    
    // Support two token types:
    // - Server session tokens we issue that start with 'sess_'
    // - Firebase ID tokens (opaque strings)
    
    if (String(token).startsWith('sess_')) {
      console.log('[AUTH] Attempting session token lookup...');
      // Session token: look up user document with matching currentSession
      try {
        const usersRef = admin.firestore().collection('users');
        const qSnap = await usersRef.where('currentSession', '==', token).limit(1).get();
        
        if (qSnap.empty) {
          console.warn('[AUTH] Session token not found in database:', token.substring(0, 20) + '...');
          return res.status(401).json({ message: 'Invalid session' });
        }
        
        const userDoc = qSnap.docs[0];
        const udoc = userDoc.data();
        console.log('[AUTH] Session token verified for user:', udoc.email, 'Role:', udoc.role);
        
        req.user = { 
          uid: userDoc.id,
          role: udoc.role, 
          fullName: udoc.fullName, 
          email: udoc.email, 
          phone: udoc.phone,
          session: token,
          admin: udoc.role === 'admin',
          isAdmin: udoc.role === 'admin'
        };
        console.log('[AUTH] User authenticated:', { uid: req.user.uid, role: req.user.role, isAdmin: req.user.isAdmin });
        return next();
      } catch (e) {
        console.error('[AUTH] Session token verification failed:', e.message);
        return res.status(401).json({ message: 'Unauthorized' });
      }
    }

    // Otherwise treat as Firebase ID token
    console.log('[AUTH] Attempting Firebase ID token verification...');
    try {
      const decoded = await admin.auth().verifyIdToken(token);
      console.log('[AUTH] Firebase token verified for user:', decoded.email);
      req.user = {
        uid: decoded.uid,
        email: decoded.email,
        ...decoded
      };
      return next();
    } catch (firebaseErr) {
      // Check if it's a custom token error - give helpful message
      if (firebaseErr.message && firebaseErr.message.includes('custom token')) {
        console.warn('[AUTH] Custom token detected (not allowed). Admin must use session token. Token:', token.substring(0, 50) + '...');
        return res.status(401).json({ 
          message: 'Invalid token. Admin must log in via /api/auth/admin-login endpoint to receive a session token (starting with "sess_").',
          hint: 'Use the adminLogin endpoint with email and password to obtain a valid session token.'
        });
      }
      console.warn('[AUTH] Firebase token verification failed:', firebaseErr.message);
      return res.status(401).json({ message: 'Unauthorized' });
    }
  } catch (err) {
    console.error('[AUTH] Token verification error:', err && err.message ? err.message : err);
    return res.status(401).json({ message: 'Unauthorized' });
  }
}

// Middleware factory to ensure the caller is the resource owner or an admin
export function requireSelfOrAdmin(paramField = 'uid') {
  return (req, res, next) => {
    const targetUid = req.params[paramField] || req.body.uid || req.query.uid;
    if (!req.user) return res.status(401).json({ message: 'Unauthorized' });
    const isAdmin = Boolean(req.user.admin || req.user.isAdmin || req.user.role === 'admin');
    if (isAdmin) return next();
    if (!targetUid) return res.status(400).json({ message: 'Missing target uid' });
    if (req.user.uid === targetUid) return next();
    return res.status(403).json({ message: 'Forbidden' });
  };
}

// Simple admin check middleware
export function isAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ message: 'Unauthorized' });
  const isAdminUser = Boolean(req.user.admin || req.user.isAdmin || req.user.role === 'admin');
  if (!isAdminUser) return res.status(403).json({ message: 'Admin required' });
  return next();
}
