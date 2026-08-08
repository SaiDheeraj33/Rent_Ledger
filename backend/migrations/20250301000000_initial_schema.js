exports.up = async function(knex) {
  // 1. Tenants table
  await knex.schema.createTable('tenants', (table) => {
    table.increments('id').primary();
    table.string('name', 255).notNullable();
    table.string('unit', 100).notNullable();
    table.decimal('monthly_rent', 12, 2).notNullable();
    table.decimal('monthly_maintenance', 12, 2).notNullable().defaultTo(0);
    table.date('lease_start_date').notNullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  // 2. Bills table
  await knex.schema.createTable('bills', (table) => {
    table.increments('id').primary();
    table.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.enum('bill_type', ['rent', 'maintenance', 'late_fee']).notNullable();
    table.decimal('amount', 12, 2).notNullable();
    table.date('due_date').notNullable();
    table.date('period_start').notNullable();
    table.date('period_end').notNullable();
    table.string('description', 255).notNullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['tenant_id', 'bill_type', 'period_start']);
    table.index(['tenant_id', 'due_date']);
  });

  // 3. Payments table
  await knex.schema.createTable('payments', (table) => {
    table.increments('id').primary();
    table.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.decimal('amount', 12, 2).notNullable();
    table.date('payment_date').notNullable();
    table.string('gateway_status', 20).notNullable().defaultTo('pending');
    table.string('gateway_transaction_id', 255).nullable();
    table.text('gateway_error').nullable();
    table.string('idempotency_key', 255).nullable().unique();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index(['tenant_id', 'payment_date']);
    table.index(['gateway_status']);
  });
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('payments');
  await knex.schema.dropTableIfExists('bills');
  await knex.schema.dropTableIfExists('tenants');
};
