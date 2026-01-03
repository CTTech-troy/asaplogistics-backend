import express from 'express';
import { submitContact } from '../controller/contact.controller.js';

let rateLimitPkg = null;
try {
  rateLimitPkg = (await import('express-rate-limit')).default;
} catch (e) {
  // optional: package not installed — proceed without route limiter
}

const router = express.Router();

const contactLimiter = rateLimitPkg
  ? rateLimitPkg({ windowMs: 60 * 60 * 1000, max: 10, handler: (req, res) => res.status(429).json({ success: false, message: 'Too many contact requests. Try later.' }) })
  : (req, res, next) => next();

// Public endpoint for contact submissions
router.post('/', contactLimiter, submitContact);

export default router;
