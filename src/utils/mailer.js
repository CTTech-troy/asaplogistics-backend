import dotenv from 'dotenv';
dotenv.config();

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM } = process.env;

let transporter;
let smtpConfigured = false;

try {
  // Dynamically import nodemailer so app can still start if package isn't installed
  const { createTransport } = await import('nodemailer');
  if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    transporter = createTransport({
      host: SMTP_HOST,
      port: parseInt(SMTP_PORT || '587', 10),
      secure: SMTP_PORT === '465', // use TLS for 587, SSL for 465 
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
      // Enable detailed logging for SMTP debugging
      logger: true,
      debug: true,
    });

    // Log SMTP connection events
    transporter.verify((err, success) => {
      if (err) {
        console.error('[Mailer] SMTP connection test failed:', err.message);
      } else if (success) {
        console.log('[Mailer] SMTP connection verified successfully');
      }
    });

    smtpConfigured = true;
    console.log('[Mailer] SMTP configured:', {
      host: SMTP_HOST,
      port: parseInt(SMTP_PORT || '587', 10),
      user: SMTP_USER,
      secure: SMTP_PORT === '465' ? 'SSL' : 'TLS',
    });
  } else {
    console.warn('[Mailer] SMTP not configured. Missing:', {
      SMTP_HOST: !SMTP_HOST,
      SMTP_USER: !SMTP_USER,
      SMTP_PASS: !SMTP_PASS,
    });
  }
} catch (err) {
  console.error('[Mailer] Failed to import nodemailer:', err.message);
}

// Fallback transporter for development/testing
if (!transporter) {
  transporter = {
    sendMail: async (msg) => {
      console.log('\n=== [MAILER FALLBACK - DEV MODE] ===');
      console.log('To:', msg.to);
      console.log('Subject:', msg.subject);
      console.log('---');
      console.log(msg.text || msg.html);
      console.log('===================================\n');
      return Promise.resolve();
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
 * Send OTP via email with HTML template and detailed logging
 */
export async function sendOtpByEmail({ to, otp }) {
  if (!to || !otp) {
    throw new Error('Email recipient and OTP are required');
  }

  const from = EMAIL_FROM || 'noreply@asaplogistics.com';
  const subject = 'Your ASAP Logistics Verification Code';
  const html = getOtpEmailHtml(otp);
  const text = `Your 4-digit verification code is: ${otp}\nIt expires in 5 minutes.`;

  const mailOptions = {
    from,
    to,
    subject,
    text,
    html,
  };

  try {
    console.log('[Mailer] Attempting to send OTP email:', {
      from,
      to,
      subject,
      timestamp: new Date().toISOString(),
      smtpConfigured,
    });

    const result = await transporter.sendMail(mailOptions);

    if (smtpConfigured) {
      console.log('[Mailer] ✓ OTP email sent successfully:', {
        to,
        messageId: result.messageId,
        response: result.response,
        timestamp: new Date().toISOString(),
      });
    } else {
      console.log('[Mailer] [FALLBACK MODE] OTP logged to console (SMTP not configured)');
    }
    return true;
  } catch (err) {
    console.error('[Mailer] ✗ Failed to send OTP email:', {
      to,
      errorCode: err.code,
      errorMessage: err.message,
      errorCommand: err.command,
      errorResponse: err.response,
      timestamp: new Date().toISOString(),
    });
    throw err;
  }
}
