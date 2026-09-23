const express = require("express");
const router = express.Router();

/**
 * In-memory idempotency store: event IDs already processed.
 * Prevents double-processing when the payment provider retries a webhook call.
 */
const processedEventIds = new Set();


/**
 * POST /webhooks/payment
 * Called by the payment provider on each event. The provider retries up to
 * 5 times if it doesn't get a 200 within 10 seconds, so this handler:
 * - responds fast (before slow side effects) to stay under that window
 * - is idempotent, so a retried event is never processed twice
 */
router.post("/webhooks/payment", express.json(), async (req, res) => {
  const event = req.body;

  if (!isValidEvent(event)) {
    return res.status(400).send("invalid payload");
  }
  if (processedEventIds.has(event.id)) {
    return res.status(200).send("ok");
  }

  if (event.type !== "payment.succeeded") {
    processedEventIds.add(event.id);
    return res.status(200).send("ok");
  }

  const updated = await markBookingAsPaid(req.app.locals.db, event.booking_id);
  if (!updated) {
    return res.status(500).send("internal error");
  }

  processedEventIds.add(event.id);
  res.status(200).send("ok");
  notifyCustomerAndCrm(event);
});

/**
 * Marks a booking as paid in the database.
 * @param {object} db - Database client with a `query` method.
 * @param {string} bookingId
 * @returns {Promise<boolean>} True on success, false if the update failed.
 */
async function markBookingAsPaid(db, bookingId) {
  try {
    await db.query("UPDATE bookings SET status = $1 WHERE id = $2", ["paid", bookingId]);
    return true;
  } catch (err) {
    console.error("Webhook payment: DB update failed", err);
    return false;
  }
}

/**
 * Fires the non-critical side effects (customer email + CRM notification)
 * after the webhook response has already been sent. Each one is isolated
 * in its own catch so a failure in one doesn't block the other.
 * @param {object} event - The payment event received from the provider.
 */
function notifyCustomerAndCrm(event) {
  sendEmail(event.customer_email, "Paiement confirmé", buildReceipt(event)).catch((err) =>
    console.error("Webhook payment: sendEmail failed", err)
  );

  crm.notifyPayment(event).catch((err) =>
    console.error("Webhook payment: crm.notifyPayment failed", err)
  );
}

/**
 * Minimal shape validation for an incoming webhook event.
 * @param {unknown} event - Raw parsed request body.
 * @returns {boolean} True if the event has the required fields for its type.
 */
function isValidEvent(event) {
  if (!event || typeof event.id !== "string" || typeof event.type !== "string") {
    return false;
  }
  if (event.type === "payment.succeeded") {
    return event.booking_id !== undefined && typeof event.customer_email === "string";
  }
  return true;
}

async function sendEmail(_to, _subject, _body) {}
function buildReceipt(_event) {
  return "";
}
const crm = {
  async notifyPayment(_event) {},
};

module.exports = router;