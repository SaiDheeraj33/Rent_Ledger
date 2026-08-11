# Rent Ledger — Containerized Financial Application

A containerized rent ledger service built with Node.js, Express, PostgreSQL, Knex, and Vanilla JS, along with an unreliable mock payment gateway.

---

## 1. How to Run It

Assume a machine with **Docker** and **Docker Compose** installed.

```bash
# 1. Clone the repository and navigate into the directory
git clone https://github.com/SaiDheeraj33/Rent_Ledger.git
cd Rent_Ledger

# 2. Start all services (Database, Gateway, Backend API & Frontend)
docker compose up --build
```

- **Frontend Dashboard**: Open [http://localhost:3000](http://localhost:3000) in your browser.
- **Backend API**: Accessible at `http://localhost:3000` (`/tenants`, `/tenants/:id/statement?asOf=YYYY-MM-DD`, `/payments`).
- **Fake Payment Gateway**: Runs internally on container port `4000`.

Database migrations and initial seed data run automatically upon `docker compose up`.

To reset the database and seed data:
```bash
docker compose down -v && docker compose up --build
```

---

## 2. Rules Invented (Domain Decisions)

Because Section 3 of the brief was intentionally open-ended, I have defined the following rules and implemented them.

1. **Late Fee Rule (5% on Overdue Portion Settled)**:
   - **Decision**: When a payment settles overdue bills, a 5% late fee is assessed only on the overdue portion that the current payment covers — not on the full bill amount. Prior on-time payments are FIFO-consumed first and do not trigger late fees. One late fee is assessed per billing period (never re-assessed on subsequent payments to the same period).
   - **Example**: Tenant owes ₹20,000 for June (overdue). Prior payments already covered March–May on time. A new ₹300 payment goes toward June's remaining ₹8,000 unpaid balance → late fee = 5% × ₹300 = ₹15. Balance decreases by ₹285.
   - **Why**: This ensures any payment always reduces the tenant's balance (late fee ≤ 5% of payment), preventing the counterintuitive scenario where a small payment increases the total owed. Simple flat percentage avoids predatory compounding. Trade-off acknowledged: a tenant making many small payments pays less total late fees than one making a single large payment — but this encourages partial payment over non-payment, which is the better outcome for a landlord.

2. **No Late Fees on Late Fees**:
   - **Decision**: Late fee bills do not accumulate further late fees if unpaid.
   - **Why**: Prevents runaway snowballing debt for tenants while preserving audit integrity.

3. **Payment Allocation (FIFO - Oldest Bills First)**:
   - **Decision**: Partial or full payments reduce balance against the tenant's oldest outstanding bills first.
   - **Why**: Standard accounting practice (First-In, First-Out). Prevents tenants from clearing new rent bills while leaving months-old debt open.

4. **Overpayment & Advance Credit**:
   - **Decision**: If a tenant pays more than their outstanding balance, the extra money is credited to their account as a negative balance, automatically reducing future bills.
   - **Why**: Tenants sometimes make advance payments or round up amounts. Rejecting money is hostile UX.

5. **Monthly Maintenance Charge**:
   - **Decision**: Monthly maintenance is generated as a distinct bill entry on the 1st of each month alongside monthly rent.
   - **Why**: Keeping maintenance distinct from base rent ensures transparent line-item auditing in tenant statements.

6. **Historical `asOf` Query Rule**:
   - **Decision**: `GET /tenants/:id/statement?asOf=YYYY-MM-DD` filters both `bills` by `due_date <= asOf` and `payments` by `payment_date <= asOf` AND `gateway_status = 'success'`.
   - **Why**: Guarantees that historical queries accurately reconstruct what the tenant's balance was on that exact calendar date, regardless of future transactions.

7. **Gateway Failure Resilience**:
   - **Decision**: When the gateway fails (HTTP 500, timeout > 5s, or connection refused), the payment is saved in the database with status `'failed'`. Failed payments **do not** decrease the tenant's outstanding balance.
   - **Why**: Money did not move, so the ledger balance must not decrease. However, recording the failed attempt in the database enables retry capabilities and audit logs.

8. **Idempotency & Double-Click Protection**:
   - **Decision**: `POST /payments` accepts an optional `idempotency_key`. Subsequent requests with the same key return the recorded payment attempt rather than re-executing the gateway charge.
   - **Why**: Protects against double-charging when users click "Pay" multiple times during gateway latency.

9. **Bill Immutability**:
   - **Decision**: Once a bill is generated, its `amount` and `due_date` cannot be modified or overwritten.
   - **Why**: Audit integrity. If rent changes, a new bill entry is created — old bills remain historical financial records. Otherwise, historical `asOf` queries become unreliable.

10. **Tenant Active/Inactive Status**:
   - **Decision**: Inactive tenants stop receiving new monthly bills, but their historical balance and ledger statement remain fully queryable.
   - **Why**: Covers the edge case of a tenant who moved out mid-month while preserving complete historical audit trails.

11. **Definition of "Paid in Full"**:
   - **Decision**: A bill or tenant account is considered "Paid in Full" if and only if `SUM(successful payments) >= SUM(all bills + maintenance + late fees)`.
   - **Why**: Provides an explicit definition for seed data ("tenant who has paid in full") and for the frontend status badge (`Paid` vs `Due`).

---

## 3. What Was Left Out & Next Steps

### What was deliberately left out:
- **Authentication & Authorization**: Explicitly prohibited by Section 6 of the brief.
- **Complex UI Frameworks / Build Toolchain**: React/Vite/Webpack were intentionally excluded as an unstyled HTML interface fulfills requirements without build overhead.

### Next Steps I Would Implement (Given 2 More Days):

1. **No Outbox Pattern for Gateway Calls**
   - **Explanation**: Right now, if the server crashes after the gateway succeeds but before the DB status update, the payment is lost in limbo — gateway charged the tenant, DB still says pending.
   - **What I would do next**: Transactional outbox pattern — write the payment intent and the gateway job in the same DB transaction. A separate worker processes the job and updates status. Now crash-safety is guaranteed.

2. **No Reconciliation Mechanism**
   - **Explanation**: The fake gateway has no `/status/:id` endpoint. In reality, if my backend times out waiting for a response, I don't know if the money actually moved. I need a way to ask the gateway later — "did payment X go through?"
   - **What I would do next**: A background reconciliation job that polls the gateway for all pending/timed-out payments older than 10 minutes and resolves their status.

3. **Balance is Computed, Not Stored**
   - **Explanation**: Tenant balance is currently derived at query time from bills and payments. This is correct for this scale, but at 10,000 tenants with 5 years of history, the query gets expensive.
   - **What I would do next**: A materialized `running_balance` column updated on every successful payment, with the computed query as the fallback/verification.

4. **No Audit Log**
   - **Explanation**: There's no record of who changed what and when. If a payment goes from pending → failed, one cannot tell if it was a timeout, a gateway rejection, or a manual override.
   - **What I would do next**: An `audit_events` table — every status transition logged with timestamp, old value, new value, and reason code.

5. **No Rate Limiting on POST /payments**
   - **Explanation**: Nothing stops a client or malicious script from spamming requests to the payment endpoint 1,000 times a second. Even with idempotency keys, dynamic keys could trigger hundreds of concurrent external gateway calls.
   - **What I would do next**: Implement rate limiting per tenant ID (e.g., max 5 payment attempts per minute using a Redis token bucket middleware) and return HTTP 429 Too Many Requests.

6. **No Automated Recurring Bill Generator Engine**
   - **Explanation**: Monthly rent and maintenance bills are currently seeded up to August 2025. There is no background scheduler engine to issue future bills automatically when a new month begins.
   - **What I would do next**: A recurring cron job daemon (e.g., using `pg_cron` or BullMQ scheduler) that fires on the 1st of each month to generate next month's bill entries for all active tenants.

---

## 4. Things I Am Not Happy With

1. **Eager vs. Lazy Late Fee Generation**: Late fees are assessed when a late payment is processed or seeded. If a tenant is late and never pays, a late fee is not auto-generated until triggered by payment or seed script. A scheduled cron bill generator would solve this cleanly.
2. **Gateway Timeout Ambiguity**: If the gateway call times out after 5 seconds, the backend marks the attempt as `'failed'`. In real life, a timeout could mean the gateway charged the customer but failed to respond in time. A webhook reconciliation protocol is required to handle this safely in production.
