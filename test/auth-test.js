// Simple test script for auth endpoints
// Usage: node test/auth-test.js
// Requires Node 18+ (global fetch) or run with a fetch polyfill

const base = 'http://localhost:5000/api/auth';

async function post(path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(path, '->', res.status, text);
}


async function run() {
  try {
    // Signup (replace phone/email if already used)
    await post('/signup', {
      fullName: 'Test User',
      email: 'test+1@example.com',
      phone: '+15550001234',
      password: 'TestPass123!'
    });

    // Login (get user by phone)
    await post('/login', { phone: '+15550001234' });

    // Verify OTP (will likely fail without a real idToken)
    await post('/verify-otp', { idToken: 'fake-or-empty-token' });
  } catch (err) {
    console.error('Test error', err);
  }
}

run();
