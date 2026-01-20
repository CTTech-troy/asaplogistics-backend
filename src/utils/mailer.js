import dotenv from 'dotenv';
import { Resend } from 'resend';
import nodemailer from 'nodemailer';

dotenv.config();

const {
  RESEND_API_KEY,
  RESEND_FROM_EMAIL,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  EMAIL_FROM,
  NODE_ENV
} = process.env;

// Default from emails
const DEFAULT_RESEND_FROM_EMAIL = RESEND_FROM_EMAIL || 'noreply@asaplogistics.com.ng';
const DEFAULT_SMTP_FROM_EMAIL = EMAIL_FROM || 'noreply@asaplogistics.com';

let resend;
let smtpTransporter;
let resendConfigured = false;
let smtpConfigured = false;

// ================= RESEND SETUP (FOR OTP) =================
try {
  if (!RESEND_API_KEY) {
    console.warn('[Mailer] RESEND_API_KEY not configured - OTP emails will fall back to console');
  } else {
    resend = new Resend(RESEND_API_KEY);
    resendConfigured = true;
    console.log('[Mailer] ✓ Resend initialized for OTP emails');
  }
} catch (err) {
  console.warn('[Mailer] Failed to initialize Resend:', err && err.message ? err.message : err);
}

// ================= SMTP SETUP (FOR BULK EMAILS) =================
try {
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    console.warn('[Mailer] SMTP credentials not fully configured - bulk emails will fall back to console');
    console.log('[Mailer] Required SMTP vars:', {
      SMTP_HOST: !!SMTP_HOST,
      SMTP_PORT: !!SMTP_PORT,
      SMTP_USER: !!SMTP_USER,
      SMTP_PASS: !!SMTP_PASS,
    });
    
    // Fallback transporter for console logging
    smtpTransporter = {
      sendMail: async (mailOptions) => {
        console.log('\n=== [MAILER FALLBACK - SMTP DEV MODE] ===');
        console.log('From:', mailOptions.from);
        console.log('To:', mailOptions.to);
        console.log('Subject:', mailOptions.subject);
        console.log('---');
        console.log(mailOptions.text || mailOptions.html);
        console.log('========================================\n');
        return Promise.resolve({ fallback: true, messageId: 'dev-' + Date.now() });
      },
    };
    smtpConfigured = false;
  } else {
    // Create SMTP transporter
    smtpTransporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: parseInt(SMTP_PORT, 10),
      secure: parseInt(SMTP_PORT, 10) === 465,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
    });

    // Verify connection
    smtpTransporter.verify((error, success) => {
      if (error) {
        console.warn('[Mailer] SMTP verification failed:', error.message);
        smtpConfigured = false;
      } else {
        console.log('[Mailer] ✓ SMTP initialized for emails');
        console.log('[Mailer] SMTP Server:', SMTP_HOST + ':' + SMTP_PORT);
        console.log('[Mailer] From email:', DEFAULT_SMTP_FROM_EMAIL);
        smtpConfigured = true;
      }
    });
  }
} catch (err) {
  console.warn('[Mailer] Failed to initialize SMTP:', err && err.message ? err.message : err);
  
  // Fallback console logger
  smtpTransporter = {
    sendMail: async (mailOptions) => {
      console.log('\n=== [MAILER FALLBACK - SMTP ERROR MODE] ===');
      console.log('From:', mailOptions.from);
      console.log('To:', mailOptions.to);
      console.log('Subject:', mailOptions.subject);
      console.log('Error: SMTP not configured');
      console.log('=========================================\n');
      return Promise.resolve({ fallback: true, messageId: 'dev-' + Date.now() });
    },
  };
  smtpConfigured = false;
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
          <p><a href="https://asaplogis.netlify.app/">Visit our website</a></p>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Send OTP via Resend (for authentication)
 */
export async function sendOtpByEmail({ to, otp }) {
  if (!to || !otp) {
    throw new Error('Email recipient and OTP are required');
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`[OTP] Sending OTP to: ${to}`);
  console.log(`[OTP] Code: ${otp}`);
  console.log(`[OTP] Expires: 5 minutes`);
  console.log(`${'='.repeat(50)}\n`);

  const subject = 'Your ASAP Logistics Verification Code';
  const html = getOtpEmailHtml(otp);
  const text = `Your 4-digit verification code is: ${otp}\nIt expires in 5 minutes.`;

  try {
    console.log('[Mailer] Attempting to send OTP via Resend to:', to);

    if (!resendConfigured) {
      console.log('[Mailer] Resend not configured, logging OTP instead:');
      console.log('[Mailer] OTP:', otp, 'To:', to);
      return true;
    }

    const result = await resend.emails.send({
      from: `ASAP Logistics <${DEFAULT_RESEND_FROM_EMAIL}>`,
      to,
      subject,
      html,
      text,
    });

    console.log('[Mailer] ✓ OTP email sent successfully via Resend:', {
      to,
      messageId: result.id,
      timestamp: new Date().toISOString(),
    });
    
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
 * Send bulk emails via SMTP with sequential sending and rate limiting
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
  console.log(`[Bulk Email] Sequential send via SMTP with 500ms delay between emails`);
  console.log(`[Bulk Email] SMTP Configured: ${smtpConfigured}`);
  console.log(`${'='.repeat(50)}\n`);

  const results = {
    sent: [],
    failed: [],
  };

  /**
   * Send individual email with exponential backoff retry
   */
  const sendWithRetry = async (to, maxRetries = 3) => {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const mailOptions = {
          from: `ASAP Logistics <${DEFAULT_SMTP_FROM_EMAIL}>`,
          to,
          subject,
          html,
          text,
        };

        const result = await smtpTransporter.sendMail(mailOptions);
        
        console.log(`[Mailer] ✓ Email sent to ${to} (messageId: ${result.messageId})`);
        return result;
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries) {
          const backoffMs = Math.pow(2, attempt - 1) * 1000;
          console.warn(`[Mailer] Error sending to ${to} on attempt ${attempt}, retrying in ${backoffMs}ms:`, err.message);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    }
    throw lastError;
  };

  try {
    console.log(`[Bulk Email] Starting sequential send to ${recipients.length} recipients...`);
    
    for (let i = 0; i < recipients.length; i++) {
      const to = recipients[i];
      try {
        await sendWithRetry(to, 3);
        results.sent.push(to);
      } catch (err) {
        results.failed.push({ email: to, error: err.message });
        console.error(`[Mailer] ✗ Failed to send to ${to}:`, err.message);
      }
      
      // Add delay between emails to avoid rate limiting (500ms)
      if (i < recipients.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    console.log(`\n[Bulk Email] Summary:`);
    console.log(`  - Sent: ${results.sent.length}/${recipients.length}`);
    console.log(`  - Failed: ${results.failed.length}/${recipients.length}`);
    console.log(`[Bulk Email] Completed at: ${new Date().toISOString()}\n`);

    return results;
  } catch (err) {
    console.error('[Mailer] ✗ Bulk email operation failed:', {
      recipientCount: recipients.length,
      errorMessage: err.message,
      timestamp: new Date().toISOString(),
    });
    throw err;
  }
}

export default { sendOtpByEmail, sendBulkEmail };

// Generic email sending function
export async function sendEmail({ to, subject, html, text }) {
  try {
    // Try SMTP first if configured
    if (smtpConfigured && smtpTransporter) {
      const result = await smtpTransporter.sendMail({
        from: DEFAULT_SMTP_FROM_EMAIL,
        to,
        subject,
        html,
        text
      });
      console.log(`[Mailer] ✓ Email sent via SMTP to ${to} (messageId: ${result.messageId})`);
      return result;
    }

    // Fallback to Resend if configured
    if (resendConfigured && resend) {
      const result = await resend.emails.send({
        from: DEFAULT_RESEND_FROM_EMAIL,
        to: [to],
        subject,
        html,
        text
      });
      console.log(`[Mailer] ✓ Email sent via Resend to ${to} (id: ${result.data?.id})`);
      return result;
    }

    // Fallback to console logging in development
    console.log(`[Mailer] 📧 Email would be sent to ${to}:`);
    console.log(`Subject: ${subject}`);
    console.log(`HTML: ${html}`);
    console.log(`Text: ${text}`);
    console.log(`[Mailer] ⚠️ No email service configured - email logged to console only`);

    return { messageId: 'console-logged', logged: true };

  } catch (error) {
    console.error(`[Mailer] ✗ Failed to send email to ${to}:`, error);
    throw error;
  }
}
 