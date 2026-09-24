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

// Chidera, 2026-09-24: "the monnify account that was sent is unavailable
// and invalid and cant it be a link like paystack? so the auto confirm can
// be obvious." The dynamic bank-transfer ACCOUNT this used to chain a
// second call for (bank-transfer/init-payment) is what kept coming back
// broken/unusable live. Init-transaction's own response already carries a
// real hosted checkout link (checkoutUrl -- Monnify's own "Pay with
// Monnify" page, same page the Web SDK modal itself loads), confirmed
// directly against Monnify's docs, not guessed -- same shape as Paystack's
// authorization_url, so this drops the second call entirely instead of
// trying to fix the account-only flow.
export async function callMonnifyCheckoutLink({ customer, amount, referencePrefix }) {
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
      // No paymentMethods restriction (used to be ACCOUNT_TRANSFER only,
      // matching the old account-only flow) -- the hosted checkout page
      // shows whatever's enabled on the contract (card, transfer, USSD),
      // same "let Monnify's own page handle it" idea as Paystack's page.
    }),
  });
  if (!initRes.ok) throw new Error(`Monnify init-transaction failed ${initRes.status}: ${await initRes.text()}`);
  const initData = await initRes.json();
  const checkoutUrl = initData?.responseBody?.checkoutUrl;
  if (!checkoutUrl) throw new Error('Monnify init-transaction succeeded but returned no checkoutUrl.');

  return { paymentReference, checkoutUrl };
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
