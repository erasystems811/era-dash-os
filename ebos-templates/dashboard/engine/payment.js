// Paystack integration. Keys live in this deployment's own .env (set via
// add-payment.mjs, same as any other era-dash-os client) -- no per-business
// encryption needed once there's only one business per deployment.
import crypto from 'node:crypto';
import { pool } from '../lib/db.js';

// Chidera, 2026-09-16: "no paystack link for payment??" -- root cause,
// confirmed by testing directly against Paystack's own live API: the
// .local TLD here is rejected outright by Paystack's email validator
// ("email must be a valid email"), even though it's a syntactically
// normal-looking address. .local is a reserved special-use domain (RFC
// 6762, mDNS), not a real TLD, and Paystack's validator specifically
// won't accept it -- every single order silently fell back to "let me
// get someone to confirm payment details" instead, indistinguishable from
// a config problem unless you actually read the caught error.
function emailFor(customer) {
  return customer.phone_number
    ? `${customer.phone_number.replace(/\D/g, '')}@ebos-customer.com`
    : `customer-${customer.id}@ebos-customer.com`;
}

// Shared by both initializePaystackTransaction and
// initializePaystackTopupTransaction below -- one real call to Paystack's
// API, one place that decides what a genuinely unique reference looks
// like. Throws on a real failure; callers decide their own fallback.
async function callPaystackInitialize({ customer, amount, referencePrefix }) {
  const secretKey = process.env.PAYMENT_SECRET_KEY;
  if (process.env.PAYMENT_PROVIDER !== 'paystack' || !secretKey) return null; // caller falls back to bank transfer instructions

  // Chidera, 2026-09-20: "the first time paystack was sent the second
  // time account number wass sent" -- root cause, confirmed live against
  // Paystack's own API: this used to send `reference: order.reference`
  // unconditionally, every single call. order.reference never changes, so
  // sendPaymentInstructions running a second time for the same order (an
  // edit, then reconfirming) always sent Paystack the exact same
  // reference it already used the first time -- Paystack's real response
  // to that is a flat 400 "Duplicate Transaction Reference", which
  // buildPayLine's own try/catch quietly swallows and falls back to bank
  // details on, indistinguishable from Paystack genuinely being
  // unavailable. A fresh, genuinely unique reference per call
  // (referencePrefix is still the human-readable order/topup id,
  // findOrderByPaymentReference/findTopupByPaymentReference still resolve
  // it via payment_reference) means every reconfirm-after-edit gets its
  // own real Paystack transaction reflecting the CURRENT amount, never a
  // stale one and never this fallback.
  const reference = `${referencePrefix}-P${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const res = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secretKey}` },
    body: JSON.stringify({ email: emailFor(customer), amount: Math.round(amount * 100), reference }),
  });
  if (!res.ok) throw new Error(`Paystack initialize failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { reference: data.data.reference, authorizationUrl: data.data.authorization_url };
}

export async function initializePaystackTransaction({ order, customer, amount }) {
  const result = await callPaystackInitialize({ customer, amount, referencePrefix: order.reference });
  if (!result) return null;
  // Persisted, not just returned -- the invoice page (routes/documents.js)
  // needs its own "Pay now" link, not only the one sent once in chat. This
  // is also what makes a re-sent invoice never go stale: payment_link_url
  // is overwritten to this fresh, current-amount transaction every time,
  // not left pointing at whatever amount was true the first time around.
  await pool.query('update "order" set payment_reference = $1, payment_link_url = $2 where id = $3', [result.reference, result.authorizationUrl, order.id]);
  return result.authorizationUrl;
}

// Chidera, 2026-09-20: "totally stop sending account number for era demo
// and use just paystack" -- a top-up (extra items added to an already-
// paid order, engine/flow.js's sendTopupInvoice) used to be deliberately
// bank-transfer-only: its own comment said reusing order.reference would
// collide with the original payment. Now that every reference is unique
// per attempt (callPaystackInitialize above), that's no longer a real
// blocker -- the topup gets its own genuine Paystack transaction, keyed
// off its own row (topupId), never the order's.
export async function initializePaystackTopupTransaction({ topupId, order, customer, amount }) {
  const result = await callPaystackInitialize({ customer, amount, referencePrefix: `${order.reference}-TU` });
  if (!result) return null;
  await pool.query('update order_topup set payment_reference = $1, payment_link_url = $2 where id = $3', [result.reference, result.authorizationUrl, topupId]);
  return result.authorizationUrl;
}

// Chidera, 2026-09-21: "LET DINE IN SUPPORT PAYSTACK O" -- dine-in's own
// pay page never had a Paystack option at all, only POS transfer or a
// generic "pay at the counter" line. Same shape as the topup transaction
// above, keyed to one specific order_payment row (a split share or the
// whole table), not the order as a whole -- a table can have more than
// one payment in flight at once, unlike a regular order.
export async function initializeOrderPaymentPaystackTransaction({ orderPayment, order, customer, amount }) {
  const result = await callPaystackInitialize({ customer, amount, referencePrefix: `${order.reference}-DP` });
  if (!result) return null;
  await pool.query('update order_payment set payment_reference = $1, payment_link_url = $2 where id = $3', [result.reference, result.authorizationUrl, orderPayment.id]);
  return result.authorizationUrl;
}

// Chidera, 2026-09-20: "a business can choose pos, flutterwave, paystack,
// or manual". null (no row yet, or provider column itself is null) means
// "not configured -- keep using the legacy PAYMENT_PROVIDER env var",
// exactly like every other caller here already does today. Only once ERA
// actually sets a provider (via the panel -- see payment_config's own
// schema comment for why this is ERA's call, not the business's own) does
// this start overriding that env var at all.
// Chidera, 2026-09-21: "ISNT THERE ALREADY SPACE IN SETTING TO PUT ACCOUNT
// NUMBER AND ALL?" -- yes: business.bank_name/bank_account_number/
// bank_account_name, the same fields the "manual" proof-of-payment flow
// has always used. transfer_account_number/name/bank_name here are read
// straight from there, not a second, duplicate place to type the same
// account in.
export async function getPaymentConfig() {
  const { rows } = await pool.query(
    `select pc.provider,
            b.bank_name as transfer_bank_name,
            b.bank_account_number as transfer_account_number,
            b.bank_account_name as transfer_account_name
     from business b
     left join payment_config pc on pc.business_id = b.id
     limit 1`
  );
  return rows[0] || null;
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

// Checked by the webhook (engine/webhook-paystack.js) alongside
// findOrderByPaymentReference above -- a topup's own reference never
// matches a real "order" row (it's keyed off the topup id, not
// order.reference), so a charge for one needs its own lookup and its own
// confirm path (mark the topup paid, not the whole order -- the order is
// already settled).
export async function findTopupByPaymentReference(reference) {
  const { rows } = await pool.query('select * from order_topup where payment_reference = $1', [reference]);
  return rows[0] || null;
}

// Checked by the webhook alongside the two above -- a dine-in payment's
// own reference never matches a real "order" row either (it's keyed off
// order_payment.id, not order.reference), so a charge for one needs its
// own lookup and its own confirm path (flow.js's confirmOrderPayment,
// which already knows how to close out a table once every split is in).
export async function findOrderPaymentByPaymentReference(reference) {
  const { rows } = await pool.query('select * from order_payment where payment_reference = $1', [reference]);
  return rows[0] || null;
}
