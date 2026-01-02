import dotenv from 'dotenv';
dotenv.config();

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM } = process.env;

let transporter;
try {
  // Dynamically import nodemailer so app can still start if package isn't installed
  const { createTransport } = await import('nodemailer');
  if (SMTP_HOST && SMTP_USER) {
    transporter = createTransport({
      host: SMTP_HOST,
      port: parseInt(SMTP_PORT || '587', 10),
      secure: false,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
    });
  }
} catch (err) {
  // nodemailer not available or import failed - fall back to console transporter
  transporter = undefined;
}

if (!transporter) {
  transporter = {
    sendMail: async (msg) => {
      console.log('=== Mailer fallback - email not sent (dev mode) ===');
      console.log('To:', msg.to);
      console.log('Subject:', msg.subject);
      console.log('Text:', msg.text);
      return Promise.resolve();
    },
  };
}

export async function sendOtpByEmail({ to, otp }) {
  const from = EMAIL_FROM || 'no-reply@asap-logistics.local';
  const subject = 'Your ASAP Logistics OTP';
  const text = `Your 4-digit verification code is: ${otp}\nIt expires in 5 minutes.`;

  try {
    await transporter.sendMail({ from, to, subject, text });
    return true;
  } catch (err) {
    console.error('Failed to send OTP email', err);
    throw err;
  }
}
