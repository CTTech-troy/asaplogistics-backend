import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import authRoutes from './src/router/auth.route.js';
import userRoutes from './src/router/user.route.js';
import adminRoutes from './src/router/admin.route.js';
import contactRoutes from './src/router/contact.route.js';

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

app.use(cors({ origin: true }));
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

// Admin routes
app.use('/api/admin', globalLimiter, adminRoutes);

// Public contact form endpoint
app.use('/api/contact', globalLimiter, contactRoutes);

app.get('/', (req, res) => {
  res.send('API running...');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
