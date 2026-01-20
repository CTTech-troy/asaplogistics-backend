import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const opayPublicKey = process.env.OPAY_PUBLIC_KEY;
const opayMerchantId = process.env.OPAY_MERCHANT_ID;
const opayBaseUrl = process.env.OPAY_BASE_URL;
const opaySecretKey = process.env.OPAY_SECRET_KEY || process.env.OPAY_WEBHOOK_SECRET;

if (!opayPublicKey) {
  throw new Error('OPAY_PUBLIC_KEY must be set in environment variables');
}

if (!opayMerchantId) {
  throw new Error('OPAY_MERCHANT_ID must be set in environment variables');
}

// OPay API client for Nigeria
const opayClient = axios.create({
  baseURL: opayBaseUrl,
  headers: {
    'Authorization': `Bearer ${opayPublicKey}`,
    'MerchantId': opayMerchantId,
    'Content-Type': 'application/json'
  },
  timeout: 30000 // 30 second timeout
});

// Add request interceptor for logging
opayClient.interceptors.request.use(
  (config) => {
    console.log(`🔗 OPay API Request: ${config.method?.toUpperCase()} ${config.url}`);
    return config;
  },
  (error) => {
    console.error('❌ OPay API Request Error:', error);
    return Promise.reject(error);
  }
);

// Add response interceptor for logging
opayClient.interceptors.response.use(
  (response) => {
    console.log(`✅ OPay API Response: ${response.status} ${response.statusText}`);
    return response;
  },
  (error) => {
    console.error('❌ OPay API Response Error:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      message: error.message
    });
    return Promise.reject(error);
  }
);

// Test OPay connection
(async () => {
  try {
    console.log('✅ OPay configured successfully!');
    console.log('🔗 OPay mode:', opayBaseUrl.includes('testapi') ? 'TEST' : 'LIVE');
    console.log('🏪 Merchant ID:', opayMerchantId);
  } catch (error) {
    console.error('❌ OPay configuration failed:', error.message);
  }
})();

export { opayClient, opayPublicKey, opayMerchantId, opayBaseUrl, opaySecretKey };
export default opayClient;