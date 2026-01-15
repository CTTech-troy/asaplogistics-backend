# Stripe Payment Integration Setup

## ⚠️ IMPORTANT: WebSocket-First Payment Flow

**Payments now require WebSocket connection before initiation.** This ensures real-time updates during the payment process.

### Payment Flow Sequence:
1. **Connect to WebSocket** (with auth token)
2. **Wait for connection confirmation**
3. **Initiate payment** (wallet funding or delivery payment)
4. **Complete Stripe payment**
5. **Receive real-time updates** via WebSocket

## Environment Variables

Add these to your `.env` file:

```env
# Stripe Configuration
STRIPE_SECRET_KEY=sk_test_your_stripe_secret_key_here
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret_here  # From Stripe CLI or dashboard
STRIPE_PUBLISHABLE_KEY=pk_test_your_stripe_publishable_key_here
```

## API Endpoints

### 1. Get WebSocket Authentication Token
```http
GET /api/payment/ws-token
Authorization: Bearer <token>
```

Response:
```json
{
  "success": true,
  "wsToken": "eyJhbGciOiJIUzI1NiIs...",
  "wsUrl": "ws://localhost:5000?token=eyJhbGciOiJIUzI1NiIs..."
}
```

### 2. Connect to WebSocket
```javascript
// Use the wsUrl from the token response
const ws = new WebSocket(wsUrl);

// Wait for connection
ws.onopen = () => {
  console.log('WebSocket connected');
  // Now you can initiate payments
};

// Listen for messages
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Received:', data);

  switch(data.event) {
    case 'connected':
      console.log('WebSocket authenticated successfully');
      break;
    case 'transaction_initiated':
      // Payment initiated, proceed with Stripe
      break;
    case 'wallet_funded':
      // Payment successful
      break;
    case 'payment_failed':
      // Payment failed
      break;
  }
};
```

### 3. Initiate Wallet Funding
```http
POST /api/payment/wallet/fund
Authorization: Bearer <token>
Content-Type: application/json

{
  "amount": 100.00
}
```

**Response (only if WebSocket is connected):**
```json
{
  "success": true,
  "transactionId": "uuid",
  "clientSecret": "pi_xxx_secret_xxx",
  "hmac": "signature"
}
```

**Error if WebSocket not connected:**
```json
{
  "message": "WebSocket connection required. Please connect to WebSocket first.",
  "code": "WEBSOCKET_REQUIRED"
}
```

### 4. Initiate Delivery Payment
```http
POST /api/payment/delivery/pay
Authorization: Bearer <token>
Content-Type: application/json

{
  "deliveryId": "delivery-123",
  "amount": 25.00
}
```

## Frontend Implementation Example

```javascript
class PaymentService {
  constructor() {
    this.ws = null;
    this.isConnected = false;
  }

  // Step 1: Get WebSocket token and connect
  async connectWebSocket() {
    try {
      // Get WebSocket authentication token
      const tokenResponse = await fetch('/api/payment/ws-token', {
        headers: {
          'Authorization': `Bearer ${this.authToken}`
        }
      });

      const { wsUrl } = await tokenResponse.json();

      // Connect to WebSocket
      this.ws = new WebSocket(wsUrl);

      return new Promise((resolve, reject) => {
        this.ws.onopen = () => {
          this.isConnected = true;
          console.log('WebSocket connected');
          resolve();
        };

        this.ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          this.handleWebSocketMessage(data);
        };

        this.ws.onerror = (error) => {
          console.error('WebSocket error:', error);
          reject(error);
        };

        this.ws.onclose = () => {
          this.isConnected = false;
          console.log('WebSocket disconnected');
        };
      });

    } catch (error) {
      console.error('Failed to connect WebSocket:', error);
      throw error;
    }
  }

  // Step 2: Handle WebSocket messages
  handleWebSocketMessage(data) {
    switch(data.event) {
      case 'connected':
        console.log('WebSocket authenticated');
        break;
      case 'transaction_initiated':
        console.log('Payment initiated:', data.data);
        // Proceed with Stripe payment
        this.processStripePayment(data.data.clientSecret);
        break;
      case 'wallet_funded':
        console.log('Wallet funded successfully:', data.data);
        // Update UI
        break;
      case 'payment_failed':
        console.error('Payment failed:', data.data);
        // Show error
        break;
    }
  }

  // Step 3: Initiate wallet funding (only after WebSocket connected)
  async fundWallet(amount) {
    if (!this.isConnected) {
      throw new Error('WebSocket not connected. Please connect first.');
    }

    const response = await fetch('/api/payment/wallet/fund', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.authToken}`
      },
      body: JSON.stringify({ amount })
    });

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.message);
    }

    return result;
  }

  // Step 4: Process Stripe payment
  async processStripePayment(clientSecret) {
    // Use Stripe Elements to complete payment
    // This will trigger webhooks and WebSocket updates
  }
}

// Usage in your component
const paymentService = new PaymentService();

// When user clicks "Top Up Wallet"
async function handleTopUp(amount) {
  try {
    // Step 1: Connect WebSocket first
    await paymentService.connectWebSocket();

    // Step 2: Now initiate payment
    await paymentService.fundWallet(amount);

    // Step 3: Stripe payment will be handled via WebSocket updates
  } catch (error) {
    console.error('Payment flow failed:', error);
  }
}
```

## WebSocket Events

### Connection Events:
- `connected` - WebSocket authenticated and ready
- `payment_ready` - Server confirms ready for payments

### Payment Events:
- `transaction_initiated` - Payment intent created, includes `clientSecret`
- `wallet_funded` - Payment successful, includes new balance
- `delivery_paid` - Delivery payment successful
- `payment_failed` - Payment failed

## Security Features

- **JWT WebSocket Authentication**: Short-lived tokens (5 minutes)
- **WebSocket Connection Required**: Payments fail without active connection
- **HMAC Verification**: Each transaction has a server-generated HMAC signature
- **Transaction Locking**: Prevents duplicate processing using Firebase Realtime DB
- **Immutable Requests**: Transaction data cannot be modified after creation
- **User Authorization**: Users can only fund their wallet or pay for their deliveries

## Testing

Use Stripe test cards:
- Success: `4242 4242 4242 4242`
- Failure: `4000 0000 0000 0002`

## Production Deployment

1. Replace test keys with live keys
2. Update webhook endpoint URL
3. Configure domain in Stripe Dashboard
4. Update WebSocket URL in production
5. Test with small amounts first