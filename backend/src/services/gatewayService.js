const GATEWAY_URL = process.env.GATEWAY_URL || 'http://gateway:4000';
const GATEWAY_TIMEOUT_MS = parseInt(process.env.GATEWAY_TIMEOUT_MS || '5000', 10);

/**
 * Calls the fake payment gateway to process a charge.
 * Handles timeouts, network failures, and gateway error responses gracefully.
 */
async function chargePayment(tenantId, amount) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);

  console.log(`[BACKEND-GATEWAY-SERVICE] Requesting charge of ₹${amount} for tenant ${tenantId} at ${GATEWAY_URL}...`);

  try {
    const response = await fetch(`${GATEWAY_URL}/charge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        tenant_id: tenantId,
        amount: parseFloat(amount)
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      let errorBody = {};
      try {
        errorBody = await response.json();
      } catch (e) {
        // Response body might not be JSON
      }

      console.warn(`[BACKEND-GATEWAY-SERVICE] Gateway returned error status ${response.status}:`, errorBody);
      return {
        success: false,
        error: errorBody.error || `Payment gateway rejected charge with status ${response.status}`,
        error_code: errorBody.code || 'GATEWAY_ERROR'
      };
    }

    const data = await response.json();
    console.log(`[BACKEND-GATEWAY-SERVICE] Gateway charge successful: Txn ${data.transaction_id}`);
    return {
      success: true,
      transaction_id: data.transaction_id
    };

  } catch (err) {
    clearTimeout(timeoutId);

    if (err.name === 'AbortError') {
      console.error(`[BACKEND-GATEWAY-SERVICE] Gateway call timed out after ${GATEWAY_TIMEOUT_MS}ms`);
      return {
        success: false,
        error: `Payment gateway timed out after ${GATEWAY_TIMEOUT_MS / 1000} seconds`,
        error_code: 'GATEWAY_TIMEOUT'
      };
    }

    if (err.cause?.code === 'ECONNREFUSED' || err.code === 'ECONNREFUSED') {
      console.error(`[BACKEND-GATEWAY-SERVICE] Gateway is unavailable (ECONNREFUSED)`);
      return {
        success: false,
        error: 'Payment gateway service is currently offline or unreachable',
        error_code: 'GATEWAY_UNREACHABLE'
      };
    }

    console.error(`[BACKEND-GATEWAY-SERVICE] Network/Fetch error:`, err.message);
    return {
      success: false,
      error: `Payment gateway communication failed: ${err.message}`,
      error_code: 'NETWORK_ERROR'
    };
  }
}

module.exports = {
  chargePayment
};
