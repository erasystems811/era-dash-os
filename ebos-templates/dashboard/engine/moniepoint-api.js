// Chidera, 2026-09-21: "LET ME TRY ANOTHER ACCOUNT AND SEE IF IT WORKS" --
// the real "POS as a Platform" API, confirmed live: root cause of every
// earlier "Invalid key provided" (7 dead keys, scripts/add-pos-sync.mjs)
// was hitting the wrong base URL (api.pos.moniepoint.com) and sending the
// api_key straight as a bearer token, skipping the actual OAuth exchange
// entirely. The real flow, confirmed against a live account: POST
// https://channel.moniepoint.com/v1/auth with {clientId, clientSecret}
// returns a real bearer accessToken (~24h expiry, scoped
// "erp-integration" -- the same feature that shows blank on the physical
// terminal until this exact credential pair actually works). Token is
// cached in-process only (module-scope, not persisted) -- cheap to
// refetch, not worth a DB round trip or surviving a restart.
import { pool } from '../lib/db.js';

const BASE_URL = 'https://channel.moniepoint.com';

let cachedToken = null; // { accessToken, expiresAt }

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.accessToken;

  const { rows } = await pool.query(
    `select client_id, client_secret from pos_sync_config where enabled = true and client_id is not null and client_secret is not null limit 1`
  );
  const config = rows[0];
  if (!config) throw new Error('No Moniepoint client_id/client_secret configured for this business.');

  const res = await fetch(`${BASE_URL}/v1/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: config.client_id, clientSecret: config.client_secret }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.accessToken) throw new Error(`Moniepoint auth failed ${res.status}: ${JSON.stringify(data)}`);

  cachedToken = { accessToken: data.accessToken, expiresAt: Date.now() + (Number(data.expiresIn) || 3600) * 1000 };
  return cachedToken.accessToken;
}

// GET /v1/transactions/merchants/{merchantReference} -- confirmed live
// (a dummy reference returned a real 404 "Transaction does not exist",
// not an auth error). Every order_payment's own `reference` doubles as
// the merchantReference passed to pushPaymentRequest below, so this is
// the exact same reference used to check on it afterward.
export async function lookupTransactionByReference(reference) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE_URL}/v1/transactions/merchants/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Moniepoint transaction lookup failed ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

// POST /v1/transactions ("Push Payment Request") -- confirmed live: this
// is what actually generates a real, ONE-TIME account number for a single
// payment (asked for by terminalSerial + amount + our own reference),
// instead of quoting the same static account to every customer. Chidera,
// 2026-09-21: confirmed this also visibly flashes a "Transfer or Card"
// screen on the physical terminal itself -- unavoidable (Moniepoint gave
// no way to suppress it), but nobody needs to act on it; her own words,
// "dont worry build it". Success is 202 with an empty body -- the actual
// account details only show up on a follow-up lookupTransactionByReference
// call, done separately by the caller (flow.js's ensureDynamicPosAccount).
// A 400 "Transaction exists" means a request under this exact reference
// is already live on Moniepoint's own side (not really a failure) -- the
// caller should just look it up instead of treating this as an error.
export async function pushPaymentRequest({ terminalSerial, amountKobo, merchantReference }) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE_URL}/v1/transactions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      terminalSerial,
      amount: amountKobo,
      merchantReference,
      transactionType: 'PURCHASE',
      paymentMethod: 'POS_TRANSFER',
    }),
  });
  if (res.status === 202) return;
  const data = await res.json().catch(() => ({}));
  if (res.status === 400 && /exists/i.test(data.message || '')) return;
  throw new Error(`Moniepoint push payment request failed ${res.status}: ${JSON.stringify(data)}`);
}
