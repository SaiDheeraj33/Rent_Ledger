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
 * Assesses late fees (5% of unpaid bill amount) when a payment is made late.
 * Uses FIFO — walks bills oldest-first, subtracts prior successful payments,
 * and only generates a late fee for bills not already covered by prior payments.
 */
async function assessLateFeesIfOverdue(tenantId, paymentDate, trx) {
  const queryExecutor = trx || db;

  // Get total successful payments made BEFORE this payment date (not including current)
  const paidResult = await queryExecutor('payments')
    .where('tenant_id', tenantId)
    .where('gateway_status', 'success')
    .where('payment_date', '<', paymentDate)
    .sum('amount as total');

  let remainingPaid = parseFloat(paidResult[0]?.total || 0);

  // Get all rent/maintenance bills due before paymentDate, oldest first (FIFO)
  const overdueBills = await queryExecutor('bills')
    .where('tenant_id', tenantId)
    .whereIn('bill_type', ['rent', 'maintenance'])
    .where('due_date', '<', paymentDate)
    .orderBy('due_date', 'asc');

  const lateFeesCreated = [];

  // Group overdue bills by period_start to respect table constraint: unique(['tenant_id', 'bill_type', 'period_start'])
  const periodMap = new Map();
  for (const bill of overdueBills) {
    if (!periodMap.has(bill.period_start)) {
      periodMap.set(bill.period_start, {
        period_start: bill.period_start,
        period_end: bill.period_end,
        due_date: bill.due_date,
        descriptions: [],
        totalAmount: 0
      });
    }
    const period = periodMap.get(bill.period_start);
    period.descriptions.push(bill.description);
    period.totalAmount += parseFloat(bill.amount);
  }

  for (const [periodStart, period] of periodMap.entries()) {
    const periodAmount = period.totalAmount;

    if (remainingPaid >= periodAmount) {
      // This period's bills were fully covered by prior payments — no late fee
      remainingPaid -= periodAmount;
      continue;
    }

    const unpaidAmount = Math.max(periodAmount - remainingPaid, 0);
    remainingPaid = 0; // consumed all prior payment credit

    // Check if a late_fee bill already exists for this tenant & period_start
    const existingLateFee = await queryExecutor('bills')
      .where('tenant_id', tenantId)
      .where('bill_type', 'late_fee')
      .where('period_start', periodStart)
      .first();

    if (!existingLateFee && unpaidAmount > 0) {
      const feeAmount = Math.round((unpaidAmount * 0.05) * 100) / 100;

      if (feeAmount > 0) {
        const [newFee] = await queryExecutor('bills').insert({
          tenant_id: tenantId,
          bill_type: 'late_fee',
          amount: feeAmount,
          due_date: paymentDate, // Late fee is due on the date payment was finally made
          period_start: period.period_start,
          period_end: period.period_end,
          description: `Late Fee: Overdue ${period.descriptions.join(' & ')} (5%)`
        }).returning('*');

        lateFeesCreated.push(newFee);
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
