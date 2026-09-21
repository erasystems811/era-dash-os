import express from 'express';
import { verifyPaystackSignature, findOrderByPaymentReference, findTopupByPaymentReference, findOrderPaymentByPaymentReference } from './payment.js';
import { completePayment, completeTopupPayment, confirmOrderPayment } from './flow.js';

export const router = express.Router();

// Needs the raw request body to verify Paystack's HMAC signature -- server.js
// mounts this route before the global express.json() body parser for that
// reason (see server.js's comment at the mount point).
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.get('x-paystack-signature');
  if (!verifyPaystackSignature(req.body, signature)) return res.sendStatus(401);

  res.sendStatus(200); // acknowledge immediately, same reasoning as the WhatsApp webhook

  try {
    const event = JSON.parse(req.body.toString('utf8'));
    if (event.event !== 'charge.success') return;
    // A topup's own reference never matches a real order row (it's keyed
    // off order_topup.id, not order.reference) -- checked first since it's
    // the narrower, more specific match; falls through to the main order
    // path for every charge that was never a topup at all.
    const topup = await findTopupByPaymentReference(event.data.reference);
    if (topup) {
      await completeTopupPayment(topup.id);
      return;
    }
    // Chidera, 2026-09-21: "LET DINE IN SUPPORT PAYSTACK O" -- same
    // narrower-first reasoning as the topup check above; a dine-in
    // payment's own reference never matches a real order row either.
    const orderPayment = await findOrderPaymentByPaymentReference(event.data.reference);
    if (orderPayment) {
      await confirmOrderPayment(orderPayment.id);
      return;
    }
    const order = await findOrderByPaymentReference(event.data.reference);
    if (order) await completePayment(order.id);
  } catch (err) {
    console.error('Paystack webhook processing failed:', err);
  }
});
