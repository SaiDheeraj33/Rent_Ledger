const express = require('express');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'fake-payment-gateway' });
});

app.post('/charge', (req, res) => {
  const { amount, tenant_id } = req.body;
  const roll = Math.random();

  console.log(`[GATEWAY] Charge request received for tenant ${tenant_id}, amount ₹${amount} (Roll: ${roll.toFixed(2)})`);

  // 1. 20% Chance: Gateway Error (HTTP 500)
  if (roll < 0.20) {
    console.log(`[GATEWAY] Simulating failure (500) for tenant ${tenant_id}`);
    return res.status(500).json({
      error: 'Gateway transaction failed: Internal payment processor error',
      code: 'GATEWAY_ERROR'
    });
  }

  // 2. 10% Chance: Slow response (3 to 6 seconds delay)
  if (roll < 0.30) {
    const delayMs = 3000 + Math.floor(Math.random() * 3000);
    console.log(`[GATEWAY] Simulating latency delay of ${delayMs}ms for tenant ${tenant_id}`);
    return setTimeout(() => {
      res.json({
        status: 'success',
        transaction_id: `txn_${uuidv4().substring(0, 8)}`,
        amount,
        processed_at: new Date().toISOString()
      });
    }, delayMs);
  }

  // 3. 70% Chance: Fast Success
  console.log(`[GATEWAY] Success for tenant ${tenant_id}`);
  return res.json({
    status: 'success',
    transaction_id: `txn_${uuidv4().substring(0, 8)}`,
    amount,
    processed_at: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Fake Payment Gateway server running on port ${PORT}`);
});
