import express from 'express';
import { verifyMonnifySignature } from './monnify-api.js';
import { findOrderByPaymentReference } from './payment.js';
import { completePayment } from './flow.js';

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
    // Order-level only for now -- engine/payment.js's
    // initializeMonnifyTransaction is the only caller that ever writes a
    // Monnify reference anywhere (no topup/dine-in Monnify support yet).
    // Extend here the same way webhook-paystack.js grew: only once Monnify
    // is actually wired into those flows too.
    const order = await findOrderByPaymentReference(reference);
    if (order) await completePayment(order.id);
  } catch (err) {
    console.error('Monnify webhook processing failed:', err);
  }
});
