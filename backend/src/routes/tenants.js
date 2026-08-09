const express = require('express');
const router = express.Router();
const billingService = require('../services/billingService');

/**
 * GET /tenants
 * Endpoint: Every tenant, and what each currently owes.
 */
router.get('/', async (req, res, next) => {
  try {
    const tenants = await billingService.getAllTenantsWithBalance();
    res.json(tenants);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /tenants/:id/statement?asOf=YYYY-MM-DD
 * Endpoint: That tenant's bills and payments, and the balance as of that date, including dates in the past.
 */
router.get('/:id/statement', async (req, res, next) => {
  try {
    const tenantId = parseInt(req.params.id, 10);
    if (isNaN(tenantId)) {
      return res.status(400).json({ error: 'Invalid tenant ID parameter' });
    }

    const { asOf } = req.query;
    const statement = await billingService.getTenantStatement(tenantId, asOf);

    if (!statement) {
      return res.status(404).json({ error: `Tenant with ID ${tenantId} not found` });
    }

    res.json(statement);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
