// Script to generate payment keys
import crypto from 'crypto';

// Generate 64-byte HMAC key
const hmacKey = crypto.randomBytes(64);
console.log('PAYMENT_HMAC_KEY=' + hmacKey.toString('base64'));

// Generate 32-byte encryption key
const encKey = crypto.randomBytes(32);
console.log('PAYMENT_ENC_KEY=' + encKey.toString('base64'));