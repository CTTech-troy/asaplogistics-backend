import Stripe from 'stripe';
import dotenv from 'dotenv';

dotenv.config();

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

if (!stripeSecretKey) {
  throw new Error('STRIPE_SECRET_KEY must be set in environment variables');
}

if (!stripeWebhookSecret) {
  throw new Error('STRIPE_WEBHOOK_SECRET must be set in environment variables');
}

const stripe = new Stripe(stripeSecretKey);

// Test Stripe connection
(async () => {
  try {
    // Test the connection by making a simple API call
    await stripe.balance.retrieve();
    console.log('✅ Stripe connected successfully!');
    console.log('🔗 Stripe mode:', stripeSecretKey.startsWith('sk_test_') ? 'TEST' : 'LIVE');
  } catch (error) {
    console.error('❌ Stripe connection failed:', error.message);
    console.error('💡 Make sure your STRIPE_SECRET_KEY is correct and you have internet connection');
  }
})();

export { stripe, stripeWebhookSecret };
export default stripe;