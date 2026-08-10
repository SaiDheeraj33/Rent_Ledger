const express = require('express');
const path = require('path');
const tenantsRouter = require('./routes/tenants');
const paymentsRouter = require('./routes/payments');

const app = express();

// Middleware
app.use(express.json());

// Serve static frontend files from 'public' directory
app.use(express.static(path.join(__dirname, '../public')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'rent-ledger-backend' });
});

// API Routes
app.use('/tenants', tenantsRouter);
app.use('/payments', paymentsRouter);

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('[BACKEND ERROR]', err.stack || err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
