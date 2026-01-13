import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import authRoutes from './src/router/auth.route.js';
import userRoutes from './src/router/user.route.js';
import adminRoutes from './src/router/admin.route.js';
import contactRoutes from './src/router/contact.route.js';
import referralRoutes from './src/router/referral.route.js';

dotenv.config();

const app = express();

// Dynamically load optional security middlewares so server can start
// even if dev hasn't installed them yet. If unavailable we'll fall back.
let helmetPkg = null;
let rateLimitPkg = null;
let xssPkg = null;
let hppPkg = null;
let morganPkg = null;

try {
  helmetPkg = (await import('helmet')).default;
} catch (e) {
  console.warn('Optional package "helmet" not installed — skipping helmet middleware');
}
try {
  rateLimitPkg = (await import('express-rate-limit')).default;
} catch (e) {
  console.warn('Optional package "express-rate-limit" not installed — skipping rate limiting');
}
try {
  xssPkg = (await import('xss-clean')).default;
} catch (e) {
  console.warn('Optional package "xss-clean" not installed — skipping xss-clean');
}
try {
  hppPkg = (await import('hpp')).default;
} catch (e) {
  console.warn('Optional package "hpp" not installed — skipping hpp');
}
try {
  morganPkg = (await import('morgan')).default;
} catch (e) {
  console.warn('Optional package "morgan" not installed — skipping request logging');
}

// Security middlewares (apply only when available)
if (helmetPkg) app.use(helmetPkg());
if (xssPkg) app.use(xssPkg());
if (hppPkg) app.use(hppPkg());

// Logging (only in development)
if (process.env.NODE_ENV !== 'production' && morganPkg) app.use(morganPkg('dev'));

app.use(cors({ 
  origin: [
    'http://localhost:5173', 
    'http://localhost:5174', 
    'https://your-frontend-domain.netlify.app',
    'https://asaplogis.netlify.app'
  ],
  credentials: true 
}));
// Allow configurable JSON body size for endpoints that may accept larger form data.
// Default is 100kb; override with CONTACT_MAX_BODY_KB in .env (value in KB).
const contactMaxKb = Number(process.env.CONTACT_MAX_BODY_KB) || 100;
app.use(express.json({ limit: `${contactMaxKb}kb` }));

// Rate limiting (use if available, otherwise no-op passthrough)
const globalLimiter = rateLimitPkg
  ? rateLimitPkg({
      windowMs: 15 * 60 * 1000,
      max: 1000,
      // respond with JSON so client can parse errors consistently
      handler: (req, res) => res.status(429).json({ success: false, message: 'Too many requests, please try again later.' }),
    })
  : (req, res, next) => next();
// authLimiter kept stricter but more lenient for development; returns JSON on limit
const authLimiter = rateLimitPkg
  ? rateLimitPkg({
      windowMs: 60 * 1000,
      max: 30,
      handler: (req, res) => res.status(429).json({ success: false, message: 'Too many requests to auth endpoints, please wait a moment.' }),
    })
  : (req, res, next) => next();

app.use(globalLimiter);

// Mount auth routes with a stricter limiter
app.use('/api/auth', authLimiter, authRoutes);

// Mount user routes (orders, wallet, history) with global limiter
app.use('/api/user', globalLimiter, userRoutes);

// Mount referral routes
app.use('/api/referral', globalLimiter, referralRoutes);

// Admin routes
app.use('/api/admin', globalLimiter, adminRoutes);

// Public contact form endpoint
app.use('/api/contact', globalLimiter, contactRoutes);

app.get('/', (req, res) => {
  res.send('API running...');
});

// Development-only test endpoint to send a test OTP/email.
// Dynamic import used so server won't fail on startup if mailer is misconfigured in production.
if (process.env.NODE_ENV !== 'production') {
  app.post('/dev/test-email', async (req, res) => {
    try {
      const to = req.body?.to || req.query?.to;
      if (!to) return res.status(400).json({ success: false, message: 'Missing `to` email param' });
      const { sendOtpByEmail } = await import('./src/utils/mailer.js');
      const otp = String(Math.floor(1000 + Math.random() * 9000));
      await sendOtpByEmail({ to, otp });
      return res.status(200).json({ success: true, message: 'Test OTP email sent', to });
    } catch (err) {
      console.error('[DEV TEST EMAIL] Error sending test email:', err && err.message ? err.message : err);
      return res.status(500).json({ success: false, message: 'Failed to send test email', error: err && err.message ? err.message : String(err) });
    }
  });
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));


