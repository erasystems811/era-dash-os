import express from 'express';
import { verifyPaystackSignature, findOrderByPaymentReference } from './payment.js';
import { completePayment } from './flow.js';

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
    const order = await findOrderByPaymentReference(event.data.reference);
    if (order) await completePayment(order.id);
  } catch (err) {
    console.error('Paystack webhook processing failed:', err);
  }
});
