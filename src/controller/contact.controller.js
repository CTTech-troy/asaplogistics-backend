import admin from '../config/firebase.js';
import { broadcastServerLog } from './payment.controller.js';
import { encryptUTF8, sha256hex } from '../utils/crypto.js';

// Simple sanitizer to strip HTML tags and trim. Max lengths are configurable
// via env var `CONTACT_MAX_MESSAGE_LEN` (characters). Defaults to 20k.
function sanitizeString(s, maxLen) {
  const defaultMax = Number(process.env.CONTACT_MAX_MESSAGE_LEN) || 20000;
  const cap = Number(maxLen) || defaultMax;
  if (typeof s !== 'string') return '';
  const stripped = s.replace(/<[^>]*>/g, '').trim();
  return stripped.slice(0, cap);
}

function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  // basic RFC-5322-lite check
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && email.length <= 254;
}

export async function submitContact(req, res) {
  try {
    const { name, email, subject, message } = req.body || {};

    // Basic validation
    const cleanName = sanitizeString(name || '', 300);
    const cleanSubject = sanitizeString(subject || '', 500);
    const cleanMessage = sanitizeString(message || '');
    const cleanEmail = (typeof email === 'string') ? email.trim().toLowerCase() : '';

    if (!cleanName || !cleanEmail || !cleanSubject || !cleanMessage) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }
    if (!isValidEmail(cleanEmail)) {
      return res.status(400).json({ success: false, message: 'Invalid email address' });
    }

    // Encrypt sensitive fields
    let encryptedEmail, encryptedMessage;
    try {
      encryptedEmail = encryptUTF8(cleanEmail);
      encryptedMessage = encryptUTF8(cleanMessage);
    } catch (e) {
      console.error('Encryption error (server misconfiguration)', e.message);
      return res.status(500).json({ success: false, message: 'Server misconfiguration' });
    }

    // Hashes for safe indexing / dedup without storing plaintext
    const emailHash = sha256hex(cleanEmail);
    const ipHash = sha256hex(req.ip || '');

    const doc = {
      name: cleanName,
      subject: cleanSubject,
      email: encryptedEmail,
      message: encryptedMessage,
      emailHash,
      ipHash,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      userAgentHash: sha256hex(req.get('User-Agent') || ''),
    };

    // Safe logging: only non-identifying hashes
    console.info('Contact submission received', { emailHash, ipHash });

    await admin.firestore().collection('contacts').add(doc);

    return res.json({ success: true, message: 'Submission received' });
  } catch (err) {
    // Log safely and return generic message
    console.error('Contact submission failed', { err: err?.message || String(err) });
    return res.status(500).json({ success: false, message: 'Could not process submission' });
  }
}
