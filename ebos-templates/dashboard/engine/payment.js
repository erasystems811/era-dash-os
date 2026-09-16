// Paystack integration. Keys live in this deployment's own .env (set via
// add-payment.mjs, same as any other era-dash-os client) -- no per-business
// encryption needed once there's only one business per deployment.
import crypto from 'node:crypto';
import { pool } from '../lib/db.js';

export async function initializePaystackTransaction({ order, customer, amount }) {
  const secretKey = process.env.PAYMENT_SECRET_KEY;
  if (process.env.PAYMENT_PROVIDER !== 'paystack' || !secretKey) return null; // caller falls back to bank transfer instructions

  // Chidera, 2026-09-16: "no paystack link for payment??" -- root cause,
  // confirmed by testing directly against Paystack's own live API: the
  // .local TLD here is rejected outright by Paystack's email validator
  // ("email must be a valid email"), even though it's a syntactically
  // normal-looking address. .local is a reserved special-use domain (RFC
  // 6762, mDNS), not a real TLD, and Paystack's validator specifically
  // won't accept it -- every single order silently fell back to "let me
  // get someone to confirm payment details" instead, indistinguishable
  // from a config problem unless you actually read the caught error.
  const email = customer.phone_number
    ? `${customer.phone_number.replace(/\D/g, '')}@ebos-customer.com`
    : `customer-${customer.id}@ebos-customer.com`;

  const res = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secretKey}` },
    body: JSON.stringify({ email, amount: Math.round(amount * 100), reference: order.reference }),
  });
  if (!res.ok) throw new Error(`Paystack initialize failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  // Persisted, not just returned -- the invoice page (routes/documents.js)
  // needs its own "Pay now" link, not only the one sent once in chat.
  await pool.query('update "order" set payment_reference = $1, payment_link_url = $2 where id = $3', [data.data.reference, data.data.authorization_url, order.id]);
  return data.data.authorization_url;
}

export function verifyPaystackSignature(rawBody, signatureHeader) {
  const secretKey = process.env.PAYMENT_SECRET_KEY;
  if (!secretKey || !signatureHeader) return false;
  const hash = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
  return hash === signatureHeader;
}

export async function findOrderByPaymentReference(reference) {
  const { rows } = await pool.query('select * from "order" where reference = $1 or payment_reference = $1', [reference]);
  return rows[0] || null;
}
