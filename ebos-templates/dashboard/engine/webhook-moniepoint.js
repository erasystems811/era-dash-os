// Moniepoint POS sync (Chidera, 2026-09-16): pulls a business's real POS
// terminal sales into the dashboard as an itemized transaction list, not
// just a revenue number -- separate from payment.js/PAYMENT_PROVIDER, which
// is money collected FROM a customer through the bot, not sales that
// already happened on a physical terminal.
//
// Moniepoint's Webhook Subscription Groups (docs.pos.moniepoint.com)
// authenticate their call to US with plain HTTP Basic auth (username/
// password we generate at registration time -- scripts/add-pos-sync.mjs),
// not an HMAC signature like Paystack's -- so this route can use the
// normal parsed express.json() body, no raw-body mount needed.
import crypto from 'node:crypto';
import express from 'express';
import { pool } from '../lib/db.js';
import { matchPosTransactionToPayment } from './flow.js';

export const router = express.Router();

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Confirmed against docs.pos.moniepoint.com's GET
// /v1/transactions/merchants/{merchantReference} response schema (the
// closest real example of this object's shape Moniepoint's docs expose --
// the webhook event body itself isn't documented field-by-field, but events
// and transaction lookups clearly share the same underlying object).
// transactionReference is Moniepoint's own id for the transaction;
// merchantReference/id used as a fallback in case a given event only
// carries one of the two. actualAmount (what really settled) is preferred
// over requestAmount (what was asked for) when both are present -- amounts
// are in kobo, same minor-unit convention as Paystack elsewhere in this
// codebase, hence the /100. Whatever isn't recognized here is still kept
// in full via raw_payload, so a wrong guess is visible and fixable once
// real traffic arrives instead of silently dropping the transaction.
function extractTransaction(body) {
  const data = body?.data || body?.payload || body;
  const reference = data?.transactionReference || data?.merchantReference || data?.id;
  const amountKobo = data?.actualAmount ?? data?.requestAmount ?? data?.amount;
  const occurredRaw = data?.createdAt || data?.modifiedAt;
  if (!reference || amountKobo === undefined || amountKobo === null) return null;
  return {
    reference: String(reference),
    amount: Number(amountKobo) / 100,
    occurredAt: occurredRaw ? new Date(occurredRaw) : new Date(),
  };
}

router.post('/', async (req, res) => {
  const { rows } = await pool.query(
    `select webhook_username, webhook_password from pos_sync_config
     where enabled = true and webhook_username is not null and webhook_password is not null limit 1`
  );
  const config = rows[0];
  if (!config) return res.sendStatus(404);

  const authHeader = req.get('authorization') || '';
  const [scheme, encoded] = authHeader.split(' ');
  const [user, pass] = scheme === 'Basic' && encoded
    ? Buffer.from(encoded, 'base64').toString('utf8').split(':')
    : [null, null];
  if (!timingSafeEqual(user, config.webhook_username) || !timingSafeEqual(pass, config.webhook_password)) {
    return res.sendStatus(401);
  }

  res.sendStatus(200); // acknowledge immediately, same reasoning as the other webhooks

  try {
    if (req.body?.eventType && !String(req.body.eventType).includes('POS_TRANSACTION')) return;
    const tx = extractTransaction(req.body);
    if (!tx) {
      console.error('Moniepoint webhook: could not parse transaction from payload', JSON.stringify(req.body));
      return;
    }
    const { rows: inserted } = await pool.query(
      `insert into pos_transaction (provider, provider_reference, amount, occurred_at, raw_payload)
       values ('moniepoint', $1, $2, $3, $4)
       on conflict (provider, provider_reference) do nothing
       returning id`,
      [tx.reference, tx.amount, tx.occurredAt, req.body]
    );
    // Joint dine-in, Stage 3 -- only on a genuinely NEW transaction, not a
    // retried webhook delivery for one already logged (on conflict do
    // nothing above returns no row for those) -- matching/auto-confirming
    // twice for the same real payment would double-count it.
    if (inserted.length) await matchPosTransactionToPayment(tx);
  } catch (err) {
    console.error('Moniepoint webhook processing failed:', err);
  }
});
