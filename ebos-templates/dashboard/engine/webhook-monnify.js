import express from 'express';
import { verifyMonnifySignature } from './monnify-api.js';
import { findOrderByPaymentReference, findOrderPaymentByPaymentReference } from './payment.js';
import { completePayment, confirmOrderPayment } from './flow.js';

export const router = express.Router();

// Needs the raw request body to verify Monnify's HMAC-SHA512 signature --
// server.js mounts this before the global express.json() body parser, same
// reasoning as the Paystack webhook mount.
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.get('monnify-signature');
  if (!verifyMonnifySignature(req.body, signature)) return res.sendStatus(401);

  res.sendStatus(200); // acknowledge immediately, same reasoning as the other webhooks

  try {
    const event = JSON.parse(req.body.toString('utf8'));
    if (event.eventType !== 'SUCCESSFUL_TRANSACTION') return;
    const reference = event.eventData?.paymentReference;
    if (!reference) return;
    // Chidera, 2026-09-25 (live report): "on dine in when i reach pay,
    // its not linked to the monify or the payment provider set for the
    // business?" -- engine/payment.js's initializeOrderPaymentMonnifyTransaction
    // now writes dine-in's own Monnify reference into order_payment, same
    // narrower-first check webhook-paystack.js already does (a dine-in
    // payment's own reference never matches a real "order" row either).
    const orderPayment = await findOrderPaymentByPaymentReference(reference);
    if (orderPayment) {
      await confirmOrderPayment(orderPayment.id);
      return;
    }
    const order = await findOrderByPaymentReference(reference);
    if (order) await completePayment(order.id);
  } catch (err) {
    console.error('Monnify webhook processing failed:', err);
  }
});
