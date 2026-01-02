import admin from '../config/firebase.js';

// Verify Firebase ID token from Authorization header and attach decoded token to req.user
export async function verifyToken(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ message: 'Missing or invalid authorization header' });
    const idToken = auth.split(' ')[1];
    // Support two token types:
    // - Firebase ID tokens (opaque strings)
    // - Server session tokens we issue that start with 'sess_'
    if (String(idToken).startsWith('sess_')) {
      // session token: look up user document with matching currentSession
      try {
        const qSnap = await admin.firestore().collection('users').where('currentSession', '==', idToken).limit(1).get();
        if (qSnap.empty) return res.status(401).json({ message: 'Invalid session' });
        const udoc = qSnap.docs[0].data();
        req.user = { uid: udoc.uid, role: udoc.role, fullName: udoc.fullName, email: udoc.email, session: idToken };
        return next();
      } catch (e) {
        console.error('Session token verification failed', e);
        return res.status(401).json({ message: 'Unauthorized' });
      }
    }

    // Otherwise treat as Firebase ID token
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.user = decoded;
    return next();
  } catch (err) {
    console.warn('Token verification failed', err && err.message ? err.message : err);
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
