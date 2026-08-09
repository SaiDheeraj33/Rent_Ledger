const express = require('express');
const router = express.Router();
const db = require('../db');
const gatewayService = require('../services/gatewayService');
const billingService = require('../services/billingService');

/**
 * POST /payments
 * Endpoint: Record a payment against a tenant.
 * Body: { tenant_id, amount, payment_date, idempotency_key }
 */
router.post('/', async (req, res, next) => {
  try {
    const { tenant_id, amount, payment_date, idempotency_key } = req.body;

    // 1. Validation
    const parsedTenantId = parseInt(tenant_id, 10);
    const parsedAmount = parseFloat(amount);

    if (isNaN(parsedTenantId)) {
      return res.status(400).json({ error: 'tenant_id is required and must be an integer' });
    }

    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'amount is required and must be a positive number' });
    }

    const validPaymentDate = (payment_date && !isNaN(Date.parse(payment_date)))
      ? payment_date
      : new Date().toISOString().split('T')[0];

    // Verify tenant exists
    const tenant = await db('tenants').where('id', parsedTenantId).first();
    if (!tenant) {
      return res.status(404).json({ error: `Tenant with ID ${parsedTenantId} not found` });
    }

    // 2. Idempotency Check (if idempotency_key provided)
    if (idempotency_key) {
      const existingPayment = await db('payments').where('idempotency_key', idempotency_key).first();
      if (existingPayment) {
        console.log(`[PAYMENT] Idempotency match found for key: ${idempotency_key}`);
        return res.json({
          message: 'Duplicate payment request detected (Idempotency matched)',
          payment: existingPayment,
          is_duplicate: true
        });
      }
    }

    // 3. Create initial pending payment record inside a DB transaction
    let paymentRecord;
    await db.transaction(async (trx) => {
      const [inserted] = await trx('payments').insert({
        tenant_id: parsedTenantId,
        amount: parsedAmount,
        payment_date: validPaymentDate,
        gateway_status: 'pending',
        idempotency_key: idempotency_key || null
      }).returning('*');
      paymentRecord = inserted;
    });

    // 4. Call external payment gateway
    const gatewayResult = await gatewayService.chargePayment(parsedTenantId, parsedAmount);

    // 5. Update payment record based on gateway outcome
    if (gatewayResult.success) {
      let lateFeesGenerated = [];

      await db.transaction(async (trx) => {
        // Mark payment as success
        await trx('payments')
          .where('id', paymentRecord.id)
          .update({
            gateway_status: 'success',
            gateway_transaction_id: gatewayResult.transaction_id,
            gateway_error: null
          });

        // Assess late fee if payment is made late
        lateFeesGenerated = await billingService.assessLateFeesIfOverdue(
          parsedTenantId,
          validPaymentDate,
          trx
        );
      });

      const updatedPayment = await db('payments').where('id', paymentRecord.id).first();

      return res.status(201).json({
        message: 'Payment processed and recorded successfully.',
        payment: updatedPayment,
        late_fees_assessed: lateFeesGenerated
      });

    } else {
      // Gateway failed, timed out, or was unreachable
      await db('payments')
        .where('id', paymentRecord.id)
        .update({
          gateway_status: 'failed',
          gateway_error: gatewayResult.error
        });

      const updatedPayment = await db('payments').where('id', paymentRecord.id).first();

      // Status 402 Payment Required / 502 Bad Gateway depending on error type
      const httpStatus = gatewayResult.error_code === 'GATEWAY_UNREACHABLE' ? 502 : 402;

      return res.status(httpStatus).json({
        error: `Payment failed: ${gatewayResult.error}`,
        error_code: gatewayResult.error_code,
        payment: updatedPayment,
        retry_allowed: true,
        note: 'Payment failure recorded in database ledger without affecting outstanding balance.'
      });
    }

  } catch (err) {
    next(err);
  }
});

module.exports = router;
