import dotenv from 'dotenv';
import { Resend } from 'resend';

dotenv.config();

const { RESEND_API_KEY, RESEND_FROM_EMAIL, NODE_ENV } = process.env;

// Default from email (production should override with verified domain)
const DEFAULT_FROM_EMAIL = RESEND_FROM_EMAIL || 'noreply@asaplogistics.com.ng';

let resend;
let mailConfigured = false;

// Initialize Resend client
try {
  if (!RESEND_API_KEY) {
    const msg = '[Mailer] RESEND_API_KEY not configured in environment.';
    if (NODE_ENV === 'production') {
      console.error(msg);
      throw new Error('RESEND_API_KEY is required in production');
    } else {
      console.warn(msg);
    }
  } else {
    resend = new Resend(RESEND_API_KEY);
    mailConfigured = true;
    console.log('[Mailer] ✓ Resend initialized successfully');
    console.log(`[Mailer] From email: ${DEFAULT_FROM_EMAIL}`);
  }
} catch (err) {
  console.error('[Mailer] Failed to initialize Resend:', err && err.message ? err.message : err);
  if (NODE_ENV === 'production') {
    throw err;
  }
  // Fallback to console logger in dev
  resend = {
    emails: {
      send: async (msg) => {
        console.log('\n=== [MAILER FALLBACK - DEV MODE] ===');
        console.log('From:', msg.from);
        console.log('To:', msg.to);
        console.log('Subject:', msg.subject);
        console.log('---');
        console.log(msg.text || msg.html);
        console.log('===================================\n');
        return Promise.resolve({ fallback: true, id: 'dev-' + Date.now() });
      },
    },
  };
}

/**
 * Generate HTML email template for OTP
 */
function getOtpEmailHtml(otp) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: Arial, sans-serif; background-color: #f5f5f5; }
        .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 20px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
        .header { text-align: center; margin-bottom: 30px; }
        .logo { font-size: 28px; font-weight: bold; color: #ff6b35; }
        .content { text-align: center; }
        .otp-box { background-color: #fff3cd; border: 2px solid #ff6b35; padding: 20px; margin: 20px 0; border-radius: 8px; }
        .otp-code { font-size: 36px; font-weight: bold; color: #ff6b35; letter-spacing: 4px; font-family: monospace; }
        .footer { font-size: 12px; color: #999; text-align: center; margin-top: 30px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="logo">🚚 ASAP Logistics</div>
        </div>
        <div class="content">
          <h2>Verify Your Account</h2>
          <p>Your one-time verification code is below. This code expires in <strong>5 minutes</strong>.</p>
          <div class="otp-box">
            <div class="otp-code">${otp}</div>
          </div>
          <p style="color: #666; font-size: 14px;">
            If you didn't request this code, please ignore this email. Your account security is important to us.
          </p>
        </div>
        <div class="footer">
          <p>&copy; 2026 ASAP Logistics. All rights reserved.</p>
          <p><a href="https://asaplogistics.com.ng">Visit our website</a></p>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Send OTP via Resend email API (instant delivery, no SMTP delays)
 */
export async function sendOtpByEmail({ to, otp }) {
  if (!to || !otp) {
    throw new Error('Email recipient and OTP are required');
  }

  // Log OTP in console for development/debugging
  console.log(`\n${'='.repeat(50)}`);
  console.log(`[OTP] Sending OTP to: ${to}`);
  console.log(`[OTP] Code: ${otp}`);
  console.log(`[OTP] Expires: 5 minutes`);
  console.log(`${'='.repeat(50)}\n`);

  const subject = 'Your ASAP Logistics Verification Code';
  const html = getOtpEmailHtml(otp);
  const text = `Your 4-digit verification code is: ${otp}\nIt expires in 5 minutes.`;

  try {
    console.log('[Mailer] Attempting to send OTP via Resend:', { to, subject, timestamp: new Date().toISOString(), mailConfigured });

    // Send via Resend API
    const result = await resend.emails.send({
      from: `ASAP Logistics <${DEFAULT_FROM_EMAIL}>`,
      to,
      subject,
      html,
      text,
    });

    if (mailConfigured) {
      console.log('[Mailer] ✓ OTP email sent successfully via Resend:', { to, messageId: result.id, timestamp: new Date().toISOString() });
    } else {
      console.log('[Mailer] [FALLBACK MODE] OTP logged to console (Resend not configured)');
    }
    return true;
  } catch (err) {
    console.error('[Mailer] ✗ Failed to send OTP email:', {
      to,
      errorMessage: err.message,
      timestamp: new Date().toISOString(),
    });
    throw err;
  }
}

/**
 * Send bulk emails to multiple recipients via Resend Batch API with exponential backoff
 */
export async function sendBulkEmail({ recipients, subject, html, text }) {
  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
    throw new Error('Recipients array is required and must not be empty');
  }

  if (!subject) {
    throw new Error('Email subject is required');
  }

  if (!html && !text) {
    throw new Error('Email content (html or text) is required');
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`[Bulk Email] Sending to ${recipients.length} recipients`);
  console.log(`[Bulk Email] Subject: ${subject}`);
  console.log(`[Bulk Email] Using Batch API (Resend recommended method)`);
  console.log(`${'='.repeat(50)}\n`);

  const results = {
    sent: [],
    failed: [],
  };

  // Split recipients into batches of 100 (Resend batch API limit)
  const BATCH_SIZE = 100;
  const batches = [];
  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    batches.push(recipients.slice(i, i + BATCH_SIZE));
  }

  console.log(`[Bulk Email] Splitting into ${batches.length} batch(es) of up to ${BATCH_SIZE} emails`);

  /**
   * Retry function with exponential backoff
   */
  const sendWithRetry = async (emailData, maxRetries = 3) => {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await resend.emails.send(emailData);
        
        if (result.error) {
          lastError = result.error;
          // Check if it's a rate limit error (429)
          if (result.error.message?.includes('429') || result.error.message?.includes('rate limit')) {
            const backoffMs = Math.pow(2, attempt - 1) * 1000; // Exponential backoff: 1s, 2s, 4s
            console.warn(`[Mailer] Rate limited, retrying in ${backoffMs}ms (attempt ${attempt}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            continue;
          }
          throw new Error(result.error.message || 'Unknown error');
        }
        return result;
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries) {
          const backoffMs = Math.pow(2, attempt - 1) * 1000;
          console.warn(`[Mailer] Error on attempt ${attempt}, retrying in ${backoffMs}ms:`, err.message);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    }
    throw lastError;
  };

  try {
    // Send each batch with rate limit protection
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      console.log(`[Bulk Email] Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} recipients)`);

      // Create email list for this batch
      const emails = batch.map(to => ({
        from: `ASAP Logistics <${DEFAULT_FROM_EMAIL}>`,
        to,
        subject,
        html,
        text,
      }));

      try {
        // Send batch via Resend batch API
        const batchResult = await sendWithRetry({ emails }, 3);
        
        if (batchResult.data) {
          // Successful batch send
          batch.forEach(to => results.sent.push(to));
          console.log(`[Mailer] ✓ Batch ${batchIndex + 1} sent successfully (${batch.length} emails)`);
        } else if (batchResult.error) {
          // Batch level error
          batch.forEach(to => {
            results.failed.push({ email: to, error: batchResult.error.message });
          });
          console.error(`[Mailer] ✗ Batch ${batchIndex + 1} failed:`, batchResult.error.message);
        }
      } catch (err) {
        // Individual batch failed
        batch.forEach(to => {
          results.failed.push({ email: to, error: err.message });
        });
        console.error(`[Mailer] ✗ Batch ${batchIndex + 1} error:`, err.message);
      }

      // Add delay between batches to avoid rate limiting
      if (batchIndex < batches.length - 1) {
        const delayMs = 500; // 500ms delay between batches
        console.log(`[Bulk Email] Waiting ${delayMs}ms before next batch...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    console.log(`\n[Bulk Email] Summary:`);
    console.log(`  - Sent: ${results.sent.length}/${recipients.length}`);
    console.log(`  - Failed: ${results.failed.length}/${recipients.length}`);
    console.log(`  - Batches processed: ${batches.length}`);
    console.log(`[Bulk Email] Completed at: ${new Date().toISOString()}\n`);

    return results;
  } catch (err) {
    console.error('[Mailer] ✗ Bulk email operation failed:', {
      recipientCount: recipients.length,
      batchCount: batches.length,
      errorMessage: err.message,
      timestamp: new Date().toISOString(),
    });
    throw err;
  }
}
 