import crypto from 'crypto';

// Uses AES-256-GCM for authenticated encryption. The key must be provided
// via env var `CONTACT_ENC_KEY` as a base64-encoded 32-byte key.

const KEY_ENV = process.env.CONTACT_ENC_KEY || '';
const key = KEY_ENV ? Buffer.from(KEY_ENV, 'base64') : null;

function ensureKey() {
  if (!key || key.length !== 32) {
    throw new Error('CONTACT_ENC_KEY must be a base64-encoded 32 byte key');
  }
}

export function encryptUTF8(plain) {
  ensureKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64'),
  };
}

export function decryptToUTF8(obj) {
  ensureKey();
  const iv = Buffer.from(obj.iv, 'base64');
  const tag = Buffer.from(obj.tag, 'base64');
  const data = Buffer.from(obj.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

export function sha256hex(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}
