import express from 'express';
import { verifyOpayCallbackSignature } from './opay-api.js';
import { findOrderByPaymentReference } from './payment.js';
import { completePayment } from './flow.js';

export const router = express.Router();

// UNLIKE Paystack/Moniepoint/Monnify's webhooks, OPay's signature isn't in
// a header over the raw body -- it's a "sha512" field INSIDE the parsed
// JSON body itself (see opay-api.js's verifyOpayCallbackSignature for the
// exact algorithm). Nothing here needs the raw body, so this mounts as a
// perfectly normal route below the global express.json() parser, not
// moved above it like the others.
router.post('/', async (req, res) => {
  res.sendStatus(200); // acknowledge immediately, same reasoning as the other webhooks

  try {
    const { payload, sha512 } = req.body || {};
    if (!verifyOpayCallbackSignature(payload, sha512)) return;
    if (payload.status !== 'SUCCESS') return;
    // Order-level only for now -- engine/payment.js's
    // initializeOpayTransaction is the only caller that ever writes an
    // OPay reference anywhere (no topup/dine-in OPay support yet). Extend
    // here the same way webhook-paystack.js grew: only once OPay is
    // actually wired into those flows too.
    const order = await findOrderByPaymentReference(payload.reference);
    if (order) await completePayment(order.id);
  } catch (err) {
    console.error('OPay webhook processing failed:', err);
  }
});
