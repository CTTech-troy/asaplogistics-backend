import crypto from 'crypto';

// 64-byte key for HMAC-SHA256 (512 bits)
const PAYMENT_KEY_ENV = process.env.PAYMENT_HMAC_KEY || '';
const hmacKey = PAYMENT_KEY_ENV ? Buffer.from(PAYMENT_KEY_ENV, 'base64') : null;

// 32-byte key for AES-256-GCM
const ENC_KEY_ENV = process.env.PAYMENT_ENC_KEY || '';
const encKey = ENC_KEY_ENV ? Buffer.from(ENC_KEY_ENV, 'base64') : null;

function ensureHmacKey() {
  if (!hmacKey || hmacKey.length !== 64) {
    throw new Error('PAYMENT_HMAC_KEY must be a base64-encoded 64-byte key');
  }
}

function ensureEncKey() {
  if (!encKey || encKey.length !== 32) {
    throw new Error('PAYMENT_ENC_KEY must be a base64-encoded 32-byte key');
  }
}

// Generate HMAC for transaction integrity
export function generateHmac(data) {
  ensureHmacKey();
  return crypto.createHmac('sha256', hmacKey).update(JSON.stringify(data)).digest('hex');
}

// Verify HMAC
export function verifyHmac(data, hmac) {
  ensureHmacKey();
  const expected = generateHmac(data);
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hmac, 'hex'));
}

// Encrypt sensitive data
export function encryptData(plain) {
  ensureEncKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64'),
  };
}

// Decrypt data
export function decryptData(obj) {
  ensureEncKey();
  const iv = Buffer.from(obj.iv, 'base64');
  const tag = Buffer.from(obj.tag, 'base64');
  const data = Buffer.from(obj.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

// Generate secure transaction ID
export function generateTransactionId() {
  return crypto.randomUUID();
}