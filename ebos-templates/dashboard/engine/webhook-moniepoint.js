// Moniepoint POS sync (Chidera, 2026-09-16): pulls a business's real POS
// terminal sales into the dashboard as an itemized transaction list, not
// just a revenue number -- separate from payment.js/PAYMENT_PROVIDER, which
// is money collected FROM a customer through the bot, not sales that
// already happened on a physical terminal.
//
// Chidera, 2026-09-20: "how do we integrate the pos now, we really need to
// figure that out." Her real Moniepoint account already has an ACTIVE
// webhook subscription, correctly pointed at this exact route -- created
// through Moniepoint's own Settings UI (atm.moniepoint.com), not the
// API-key-based "POS as a Platform" system scripts/add-pos-sync.mjs was
// originally built for (which never worked -- every one of 7 generated
// keys came back "Invalid key provided" against docs.pos.moniepoint.com,
// root cause never resolved). This UI-created subscription authenticates
// with HMAC-SHA256 signature verification instead of Basic auth
// (confirmed against Moniepoint's own Webhooks documentation,
// teamapt.atlassian.net/wiki/spaces/EI/pages/1492648078): concatenate
// `${moniepoint-webhook-id header}__${moniepoint-webhook-timestamp
// header}__${raw request body}`, HMAC-SHA256 it with the subscription's
// own secret (retrieved once via "Re-Generate API Secret" on the
// subscription's own page), base64-encode, compare against the
// moniepoint-webhook-signature header. Needs the RAW body for this to
// verify correctly -- server.js mounts this route with express.raw()
// before the global express.json() parser, same reasoning/pattern as
// webhook-paystack.js's own HMAC verification.
import crypto from 'node:crypto';
import express from 'express';
import { pool } from '../lib/db.js';
import { matchPosTransactionToPayment } from './flow.js';

export const router = express.Router();

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifySignature({ rawBody, webhookId, timestamp, signature, secret }) {
  if (!secret || !webhookId || !timestamp || !signature) return false;
  const payload = `${webhookId}__${timestamp}__${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64');
  return timingSafeEqualStr(expected, signature);
}

// Confirmed against Moniepoint's own real documented example (Webhooks
// page above): {"eventId", "eventType": "V1_POS_TRANSFER_TRANSACTION",
// "data": {"transactionReference", "amount", "transactionTime",
// "transactionStatus"}, "createdAt"} -- genuinely different field names
// than the OLD (never-reached-live) parsing this replaces, which was
// written against the API-key system's own docs instead of this one.
// transactionStatus, when present, gates out anything not actually
// COMPLETED (a pending/failed attempt is not a real payment). amount's
// minor-unit convention (kobo, matching every other provider in this
// codebase) is NOT yet confirmed against a real captured delivery --
// raw_payload keeps the full original body regardless, specifically so
// this is checkable and fixable the moment a real transaction arrives,
// same discipline the original comment here already established.
function extractTransaction(body) {
  const data = body?.data || body?.payload || body;
  const reference = data?.transactionReference || data?.merchantReference || data?.id;
  const amountRaw = data?.actualAmount ?? data?.requestAmount ?? data?.amount;
  const occurredRaw = body?.createdAt || data?.transactionTime || data?.createdAt || data?.modifiedAt;
  const status = data?.transactionStatus;
  if (!reference || amountRaw === undefined || amountRaw === null) return null;
  if (status && status !== 'COMPLETED') return null;
  return {
    reference: String(reference),
    amount: Number(amountRaw) / 100,
    occurredAt: occurredRaw ? new Date(occurredRaw) : new Date(),
  };
}

router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const { rows } = await pool.query(
    `select webhook_secret from pos_sync_config where enabled = true and webhook_secret is not null limit 1`
  );
  const config = rows[0];
  if (!config) return res.sendStatus(404);

  const ok = verifySignature({
    rawBody: req.body,
    webhookId: req.get('moniepoint-webhook-id'),
    timestamp: req.get('moniepoint-webhook-timestamp'),
    signature: req.get('moniepoint-webhook-signature'),
    secret: config.webhook_secret,
  });
  if (!ok) return res.sendStatus(401);

  res.sendStatus(200); // acknowledge immediately, same reasoning as the other webhooks

  let parsedBody;
  try {
    parsedBody = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    console.error('Moniepoint webhook: body was not valid JSON', err.message);
    return;
  }

  try {
    const tx = extractTransaction(parsedBody);
    if (!tx) {
      console.error('Moniepoint webhook: could not parse transaction from payload', JSON.stringify(parsedBody));
      return;
    }
    const { rows: inserted } = await pool.query(
      `insert into pos_transaction (provider, provider_reference, amount, occurred_at, raw_payload)
       values ('moniepoint', $1, $2, $3, $4)
       on conflict (provider, provider_reference) do nothing
       returning id`,
      [tx.reference, tx.amount, tx.occurredAt, parsedBody]
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
