// Monnify "Pay with Bank Transfer" integration -- a real, per-transaction
// dynamic virtual account (NOT Reserved Accounts, which needs the
// customer's own BVN/NIN). Chidera, 2026-09-23: "then we wont use reserved
// we will use dynamic". Every endpoint/field name here was confirmed
// directly against Monnify's own docs (developers.monnify.com +
// their Confluence API reference), not guessed -- see the comments below
// for what each one actually said.
import crypto from 'node:crypto';

const MONNIFY_BASE_URL = process.env.MONNIFY_BASE_URL || 'https://api.monnify.com';

// Module-level, not per-request -- Monnify's own token is valid for a full
// hour; asking for a fresh one on every single payment would just be
// wasted API calls for no benefit.
let cachedToken = null; // { token, expiresAt }

async function getAccessToken() {
  const apiKey = process.env.MONNIFY_API_KEY;
  const secretKey = process.env.MONNIFY_SECRET_KEY;
  if (!apiKey || !secretKey) return null;
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;

  const basic = Buffer.from(`${apiKey}:${secretKey}`).toString('base64');
  const res = await fetch(`${MONNIFY_BASE_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}` },
  });
  if (!res.ok) throw new Error(`Monnify auth failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const token = data?.responseBody?.accessToken;
  if (!token) throw new Error('Monnify auth succeeded but returned no accessToken.');
  const expiresIn = data?.responseBody?.expiresIn || 3600;
  // Refreshed a minute early so a call in flight never races an
  // about-to-expire token.
  cachedToken = { token, expiresAt: Date.now() + (expiresIn - 60) * 1000 };
  return token;
}

// Same reasoning as payment.js's own emailFor (Paystack) -- Monnify's
// customerEmail is also validated, and a real customer phone number is all
// EBOS actually has.
function emailFor(customer) {
  return customer.phone_number
    ? `${customer.phone_number.replace(/\D/g, '')}@ebos-customer.com`
    : `customer-${customer.id}@ebos-customer.com`;
}

// Two real calls to Monnify's own API, chained: initialize a transaction,
// then immediately request ITS dynamic bank-transfer account -- "Pay with
// Bank Transfer" needs an already-initialized transaction's reference, per
// Monnify's own docs. Throws on a real failure; callers decide their own
// fallback, same shape as payment.js's callPaystackInitialize.
export async function callMonnifyDynamicAccount({ customer, amount, referencePrefix }) {
  const contractCode = process.env.MONNIFY_CONTRACT_CODE;
  const accessToken = await getAccessToken();
  if (!accessToken || !contractCode) return null; // caller falls back to bank transfer instructions

  // A fresh, genuinely unique reference per call -- same reference-reuse
  // bug Paystack's own callPaystackInitialize already fixed (a reconfirm
  // after an edit reusing the same reference gets rejected by the
  // provider), same fix applied here up front instead of discovering it
  // live later.
  const paymentReference = `${referencePrefix}-M${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const initRes = await fetch(`${MONNIFY_BASE_URL}/api/v1/merchant/transactions/init-transaction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      amount: Number(amount),
      customerName: customer.name || 'EBOS customer',
      customerEmail: emailFor(customer),
      paymentReference,
      paymentDescription: `Order payment ${referencePrefix}`,
      currencyCode: 'NGN',
      contractCode,
      paymentMethods: ['ACCOUNT_TRANSFER'],
    }),
  });
  if (!initRes.ok) throw new Error(`Monnify init-transaction failed ${initRes.status}: ${await initRes.text()}`);
  const initData = await initRes.json();
  const transactionReference = initData?.responseBody?.transactionReference;
  if (!transactionReference) throw new Error('Monnify init-transaction succeeded but returned no transactionReference.');

  const acctRes = await fetch(`${MONNIFY_BASE_URL}/api/v1/merchant/bank-transfer/init-payment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ transactionReference }),
  });
  if (!acctRes.ok) throw new Error(`Monnify bank-transfer init failed ${acctRes.status}: ${await acctRes.text()}`);
  const acctData = await acctRes.json();
  const body = acctData?.responseBody;
  if (!body?.accountNumber) throw new Error('Monnify bank-transfer init succeeded but returned no accountNumber.');

  // Monnify's own confirmed max is 2400 seconds (40 minutes) --
  // accountDurationSeconds is however many of those are actually left for
  // this specific call.
  const expiresAt = new Date(Date.now() + (body.accountDurationSeconds || 2400) * 1000);
  return {
    paymentReference,
    accountNumber: body.accountNumber,
    accountName: body.accountName,
    bankName: body.bankName,
    expiresAt,
  };
}

// Header name and algorithm confirmed directly against Monnify's own docs:
// HMAC-SHA512 keyed with the client SECRET key (not a plain concatenated
// hash, despite some third-party writeups describing it that way), over the
// raw request body. One documented gap: Monnify's SANDBOX webhook calls
// reportedly omit this header entirely -- only live/production is expected
// to always send it, so a sandbox test that never fires this webhook is a
// known Monnify limitation, not a bug here.
export function verifyMonnifySignature(rawBody, signatureHeader) {
  const secretKey = process.env.MONNIFY_SECRET_KEY;
  if (!secretKey || !signatureHeader) return false;
  const hash = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
  return hash === signatureHeader;
}
