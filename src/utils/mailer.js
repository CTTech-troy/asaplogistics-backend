import dotenv from 'dotenv';
import { Resend } from 'resend';

dotenv.config();

const { RESEND_API_KEY, NODE_ENV } = process.env;

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
      from: 'ASAP Logistics <onboarding@resend.dev>',
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
 