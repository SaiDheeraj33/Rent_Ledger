const db = require('../db');

/**
 * Returns all tenants with their aggregated total billed, total paid (success only), and current balance.
 */
async function getAllTenantsWithBalance() {
  const tenants = await db('tenants as t')
    .select(
      't.id',
      't.name',
      't.unit',
      't.monthly_rent',
      't.monthly_maintenance',
      't.lease_start_date',
      't.is_active'
    )
    .select(
      db.raw(`COALESCE((
        SELECT SUM(amount) FROM bills WHERE tenant_id = t.id
      ), 0) as total_billed`),
      db.raw(`COALESCE((
        SELECT SUM(amount) FROM payments WHERE tenant_id = t.id AND gateway_status = 'success'
      ), 0) as total_paid`)
    )
    .orderBy('t.id', 'asc');

  return tenants.map(t => {
    const monthlyRent = parseFloat(t.monthly_rent);
    const monthlyMaintenance = parseFloat(t.monthly_maintenance);
    const totalBilled = parseFloat(t.total_billed);
    const totalPaid = parseFloat(t.total_paid);
    const currentBalance = Math.round((totalBilled - totalPaid) * 100) / 100;
    const isPaidInFull = currentBalance <= 0;

    return {
      id: t.id,
      name: t.name,
      unit: t.unit,
      monthly_rent: monthlyRent,
      monthly_maintenance: monthlyMaintenance,
      monthly_total: monthlyRent + monthlyMaintenance,
      lease_start_date: t.lease_start_date,
      is_active: t.is_active,
      total_billed: totalBilled,
      total_paid: totalPaid,
      current_balance: currentBalance,
      is_paid_in_full: isPaidInFull
    };
  });
}

function formatDateString(d) {
  if (!d) return '';
  if (typeof d === 'string') return d.split('T')[0];
  if (d instanceof Date) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return String(d).split('T')[0];
}

/**
 * Generates a tenant statement as of a specific date YYYY-MM-DD.
 * Filters bills by due_date <= asOfDate and payments by payment_date <= asOfDate.
 */
async function getTenantStatement(tenantId, asOfDate) {
  // Validate tenant existence
  const tenant = await db('tenants').where('id', tenantId).first();
  if (!tenant) {
    return null;
  }

  // Target asOf date string (default to today if missing or invalid)
  const targetDate = (asOfDate && !isNaN(Date.parse(asOfDate)))
    ? asOfDate
    : new Date().toISOString().split('T')[0];

  // Fetch bills due on or before targetDate
  const bills = await db('bills')
    .where('tenant_id', tenantId)
    .where('due_date', '<=', targetDate)
    .select(
      'id',
      'due_date as date',
      db.raw("'bill' as entry_type"),
      'bill_type',
      'description',
      'amount'
    );

  // Fetch successful payments made on or before targetDate
  const payments = await db('payments')
    .where('tenant_id', tenantId)
    .where('gateway_status', 'success')
    .where('payment_date', '<=', targetDate)
    .select(
      'id',
      'payment_date as date',
      db.raw("'payment' as entry_type"),
      db.raw("NULL as bill_type"),
      db.raw("'Payment received' as description"),
      'amount'
    );

  // Format and merge entries
  const allEntries = [];

  for (const b of bills) {
    allEntries.push({
      id: `bill_${b.id}`,
      raw_id: b.id,
      date: formatDateString(b.date),
      entry_type: 'bill',
      bill_type: b.bill_type,
      description: b.description,
      amount: parseFloat(b.amount) // Bills increase balance
    });
  }

  for (const p of payments) {
    allEntries.push({
      id: `payment_${p.id}`,
      raw_id: p.id,
      date: formatDateString(p.date),
      entry_type: 'payment',
      bill_type: null,
      description: p.description,
      amount: -parseFloat(p.amount) // Payments decrease balance
    });
  }

  // Sort entries chronologically. If date is identical, bills precede payments.
  allEntries.sort((a, b) => {
    if (a.date !== b.date) {
      return a.date.localeCompare(b.date);
    }
    if (a.entry_type !== b.entry_type) {
      return a.entry_type === 'bill' ? -1 : 1;
    }
    return a.raw_id - b.raw_id;
  });

  // Calculate running balance entry by entry
  let runningBalance = 0;
  const ledgerEntries = allEntries.map(entry => {
    runningBalance += entry.amount;
    return {
      ...entry,
      running_balance: Math.round(runningBalance * 100) / 100
    };
  });

  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      unit: tenant.unit,
      monthly_rent: parseFloat(tenant.monthly_rent),
      monthly_maintenance: parseFloat(tenant.monthly_maintenance)
    },
    asOf: targetDate,
    entries: ledgerEntries,
    balance: Math.round(runningBalance * 100) / 100
  };
}

/**
 * Assesses late fees (5% of overdue amount) when a payment settles overdue bills.
 *
 * Key insight: prior payments that already settled earlier bills on time must NOT
 * trigger late fees. Only the CURRENT payment touching still-unpaid overdue bills
 * should generate late fees — and only on the portion it covers.
 *
 * Algorithm:
 *  1. Calculate prior successful payments (everything except the current payment).
 *  2. FIFO-allocate prior payments to overdue bills — these were on-time, no late fees.
 *  3. FIFO-allocate the current payment to remaining unpaid overdue bills.
 *  4. For each overdue period the current payment touches, assess a 5% late fee
 *     on the amount being settled (if no late fee already exists for that period).
 *
 * This guarantees: late_fees_created <= 5% × currentPaymentAmount,
 * so the tenant's balance always decreases with any payment.
 */
async function assessLateFeesIfOverdue(tenantId, paymentDate, currentPaymentAmount, trx) {
  const queryExecutor = trx || db;

  // Sum ALL successful payments up to paymentDate (includes the current one just marked success)
  const allPaidResult = await queryExecutor('payments')
    .where('tenant_id', tenantId)
    .where('gateway_status', 'success')
    .where('payment_date', '<=', paymentDate)
    .sum('amount as total');

  const totalPaid = parseFloat(allPaidResult[0]?.total || 0);
  // Prior payments = everything except the current payment
  const priorPaid = totalPaid - currentPaymentAmount;

  // Get all rent/maintenance bills due before paymentDate, oldest first (FIFO)
  const overdueBills = await queryExecutor('bills')
    .where('tenant_id', tenantId)
    .whereIn('bill_type', ['rent', 'maintenance'])
    .where('due_date', '<', paymentDate)
    .orderBy('due_date', 'asc');

  // Group overdue bills by period_start (respects unique constraint on bills table)
  const periods = [];
  const periodMap = new Map();
  for (const bill of overdueBills) {
    const key = formatDateString(bill.period_start);
    if (!periodMap.has(key)) {
      const p = {
        period_start: bill.period_start,
        period_end: bill.period_end,
        due_date: bill.due_date,
        descriptions: [],
        totalAmount: 0
      };
      periodMap.set(key, p);
      periods.push(p);
    }
    const period = periodMap.get(key);
    period.descriptions.push(bill.description);
    period.totalAmount += parseFloat(bill.amount);
  }

  // --- FIFO two-pass allocation ---
  let remainingPriorCredit = priorPaid;
  let remainingCurrentCredit = currentPaymentAmount;
  const lateFeesCreated = [];

  for (const period of periods) {
    const periodAmount = period.totalAmount;

    // Pass 1: Consume prior payments first (these settled bills on time — no late fee)
    if (remainingPriorCredit >= periodAmount) {
      remainingPriorCredit -= periodAmount;
      continue; // Fully covered by earlier payments
    }

    // Prior payments partially cover (or don't cover) this period
    const uncoveredByPrior = periodAmount - remainingPriorCredit;
    remainingPriorCredit = 0;

    // Pass 2: Apply current payment to the uncovered overdue portion
    if (remainingCurrentCredit <= 0) break; // Current payment fully consumed

    const paidByCurrentPayment = Math.min(remainingCurrentCredit, uncoveredByPrior);
    remainingCurrentCredit -= paidByCurrentPayment;

    // Only assess late fee if the current payment is actually settling overdue bills
    if (paidByCurrentPayment > 0) {
      const existingLateFee = await queryExecutor('bills')
        .where('tenant_id', tenantId)
        .where('bill_type', 'late_fee')
        .where('period_start', period.period_start)
        .first();

      if (!existingLateFee) {
        // Late fee = 5% of the overdue amount being settled by this payment
        const feeAmount = Math.round((paidByCurrentPayment * 0.05) * 100) / 100;

        if (feeAmount > 0) {
          const [newFee] = await queryExecutor('bills').insert({
            tenant_id: tenantId,
            bill_type: 'late_fee',
            amount: feeAmount,
            due_date: paymentDate,
            period_start: period.period_start,
            period_end: period.period_end,
            description: `Late Fee: Overdue ${period.descriptions.join(' & ')} (5%)`
          }).returning('*');

          lateFeesCreated.push(newFee);
        }
      }
    }
  }

  return lateFeesCreated;
}

module.exports = {
  getAllTenantsWithBalance,
  getTenantStatement,
  assessLateFeesIfOverdue
};
