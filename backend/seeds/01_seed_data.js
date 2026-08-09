exports.seed = async function(knex) {
  // Clear existing data cleanly
  await knex('payments').del();
  await knex('bills').del();
  await knex('tenants').del();

  // Reset auto-increment IDs
  await knex.raw('ALTER SEQUENCE tenants_id_seq RESTART WITH 1');
  await knex.raw('ALTER SEQUENCE bills_id_seq RESTART WITH 1');
  await knex.raw('ALTER SEQUENCE payments_id_seq RESTART WITH 1');

  // 1. Insert 4 Tenants
  const tenants = await knex('tenants').insert([
    {
      id: 1,
      name: 'Priya Sharma',
      unit: 'A-101',
      monthly_rent: 25000.00,
      monthly_maintenance: 3000.00,
      lease_start_date: '2025-03-01'
    },
    {
      id: 2,
      name: 'Rahul Verma',
      unit: 'B-202',
      monthly_rent: 20000.00,
      monthly_maintenance: 0.00,
      lease_start_date: '2025-03-01'
    },
    {
      id: 3,
      name: 'Anita Desai',
      unit: 'C-303',
      monthly_rent: 30000.00,
      monthly_maintenance: 5000.00,
      lease_start_date: '2025-03-01'
    },
    {
      id: 4,
      name: 'Vikram Singh',
      unit: 'D-404',
      monthly_rent: 18000.00,
      monthly_maintenance: 2000.00,
      lease_start_date: '2025-03-01'
    }
  ]).returning('*');

  // Generate monthly bills for March 2025 through August 2025
  const months = [
    { start: '2025-03-01', end: '2025-03-31', due: '2025-03-01', name: 'March 2025' },
    { start: '2025-04-01', end: '2025-04-30', due: '2025-04-01', name: 'April 2025' },
    { start: '2025-05-01', end: '2025-05-31', due: '2025-05-01', name: 'May 2025' },
    { start: '2025-06-01', end: '2025-06-30', due: '2025-06-01', name: 'June 2025' },
    { start: '2025-07-01', end: '2025-07-31', due: '2025-07-01', name: 'July 2025' },
    { start: '2025-08-01', end: '2025-08-31', due: '2025-08-01', name: 'August 2025' }
  ];

  const bills = [];

  for (const t of tenants) {
    for (const m of months) {
      // Rent bill
      bills.push({
        tenant_id: t.id,
        bill_type: 'rent',
        amount: t.monthly_rent,
        due_date: m.due,
        period_start: m.start,
        period_end: m.end,
        description: `${m.name} Rent`
      });

      // Maintenance bill (if > 0)
      if (parseFloat(t.monthly_maintenance) > 0) {
        bills.push({
          tenant_id: t.id,
          bill_type: 'maintenance',
          amount: t.monthly_maintenance,
          due_date: m.due,
          period_start: m.start,
          period_end: m.end,
          description: `${m.name} Maintenance`
        });
      }
    }
  }

  // Add explicit Late Fee bills for Tenant 3 (Anita - Late) and Tenant 4 (Vikram - Never paid)
  // Anita paid March bill late (on March 25), incurring a 5% fee on Rent (₹1,500)
  bills.push({
    tenant_id: 3,
    bill_type: 'late_fee',
    amount: 1500.00,
    due_date: '2025-03-25',
    period_start: '2025-03-01',
    period_end: '2025-03-31',
    description: 'Late Fee: March 2025 Rent (5%)'
  });

  // Vikram never paid March or April bill, incurring late fees on March rent (5% of 18000 = ₹900)
  bills.push({
    tenant_id: 4,
    bill_type: 'late_fee',
    amount: 900.00,
    due_date: '2025-03-15',
    period_start: '2025-03-01',
    period_end: '2025-03-31',
    description: 'Late Fee: March 2025 Rent (5%)'
  });

  await knex('bills').insert(bills);

  // 2. Insert Payments
  const payments = [];

  // Tenant 1 (Priya): Paid in full for all months (Mar to Aug) on the due date
  for (const m of months) {
    payments.push({
      tenant_id: 1,
      amount: 28000.00, // 25000 rent + 3000 maint
      payment_date: m.due,
      gateway_status: 'success',
      gateway_transaction_id: `txn_priya_${m.name.split(' ')[0].toLowerCase()}`
    });
  }

  // Tenant 2 (Rahul): Part-paid
  // Paid March, April, May in full (₹20,000). Paid June partially (₹12,000). July & Aug unpaid.
  payments.push({ tenant_id: 2, amount: 20000.00, payment_date: '2025-03-01', gateway_status: 'success', gateway_transaction_id: 'txn_rahul_mar' });
  payments.push({ tenant_id: 2, amount: 20000.00, payment_date: '2025-04-01', gateway_status: 'success', gateway_transaction_id: 'txn_rahul_apr' });
  payments.push({ tenant_id: 2, amount: 20000.00, payment_date: '2025-05-01', gateway_status: 'success', gateway_transaction_id: 'txn_rahul_may' });
  payments.push({ tenant_id: 2, amount: 12000.00, payment_date: '2025-06-05', gateway_status: 'success', gateway_transaction_id: 'txn_rahul_june_part' });

  // Tenant 3 (Anita): Late
  // Paid March rent + maint + late fee late on March 25 (total ₹36,500). Paid April rent + maint late on May 10 (₹35,000). May-Aug unpaid.
  payments.push({ tenant_id: 3, amount: 36500.00, payment_date: '2025-03-25', gateway_status: 'success', gateway_transaction_id: 'txn_anita_mar_late' });
  payments.push({ tenant_id: 3, amount: 35000.00, payment_date: '2025-05-10', gateway_status: 'success', gateway_transaction_id: 'txn_anita_apr_late' });

  // Tenant 4 (Vikram): Never paid anything (0 payments)

  await knex('payments').insert(payments);

  console.log('Seed data successfully inserted: 4 tenants, 50 bills/fees, 12 payments.');
};
