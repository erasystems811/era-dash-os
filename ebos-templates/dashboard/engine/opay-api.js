// OPay's own "Bank Transfer Payment" product -- a real, per-order dynamic
// virtual account, same shape as Monnify's (see monnify-api.js). Chidera,
// 2026-09-23: "so what of opay?". Every endpoint/field name here was
// confirmed directly against OPay's own docs (documentation.opaycheckout.com),
// not guessed -- see the comments below for what each one actually said,
// and NOT YET tested against a real OPay account (no credentials exist
// yet) -- verify against a real sandbox response before relying on this
// live.
import crypto from 'node:crypto';

// The endpoint path says "international" but the request body's own
// country/currency fields (NG/NGN) are what actually target Nigeria --
// confirmed directly in OPay's docs' own worked example, not a guess. Same
// base host serves both.
const OPAY_BASE_URL = process.env.OPAY_BASE_URL || 'https://liveapi.opaycheckout.com';

// Chidera, 2026-09-23: "monify first" -- OPay came second, so its request
// signing was checked directly against the same docs Monnify's was, not
// assumed to match. Confirmed here: OUTGOING request signing is plain
// HMAC-SHA512 (hex), keyed with the OPay Secret/Private Key, over the exact
// JSON string sent as the body -- a DIFFERENT algorithm from the INCOMING
// callback signature below (HMAC-SHA3-512), despite both being called
// "the secret key" in OPay's own docs. This isn't a typo -- don't "fix" it
// to match.
function signRequestBody(secretKey, bodyString) {
  return crypto.createHmac('sha512', secretKey).update(bodyString).digest('hex');
}

function emailFor(customer) {
  return customer.phone_number
    ? `${customer.phone_number.replace(/\D/g, '')}@ebos-customer.com`
    : `customer-${customer.id}@ebos-customer.com`;
}

// One real call to OPay's own API -- initializes a payment with
// payMethod: "BankTransfer" directly (unlike Monnify's two-step
// init-then-request-account, OPay returns the dynamic account in the SAME
// response). Throws on a real failure; callers decide their own fallback,
// same shape as callPaystackInitialize / callMonnifyDynamicAccount.
export async function callOpayBankTransfer({ customer, amount, referencePrefix }) {
  const merchantId = process.env.OPAY_MERCHANT_ID;
  const secretKey = process.env.OPAY_SECRET_KEY;
  if (!merchantId || !secretKey) return null; // caller falls back to bank transfer instructions

  const reference = `${referencePrefix}-O${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const body = {
    amount: { currency: 'NGN', total: Math.round(Number(amount)) },
    callbackUrl: process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}/webhook/opay` : undefined,
    country: 'NG',
    customerName: customer.name || 'EBOS customer',
    payMethod: 'BankTransfer',
    product: { name: 'Order payment', description: `Order payment ${referencePrefix}` },
    reference,
    userInfo: {
      userEmail: emailFor(customer),
      userId: String(customer.id),
      userMobile: customer.phone_number || '',
      userName: customer.name || 'EBOS customer',
    },
  };
  const bodyString = JSON.stringify(body);
  const signature = signRequestBody(secretKey, bodyString);

  const res = await fetch(`${OPAY_BASE_URL}/api/v1/international/payment/create`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${signature}`,
      merchantid: merchantId,
    },
    body: bodyString,
  });
  if (!res.ok) throw new Error(`OPay bank-transfer create failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const action = data?.data?.nextAction;
  if (data?.code !== '00000' || !action?.transferAccountNumber) {
    throw new Error(`OPay bank-transfer create returned no account: ${JSON.stringify(data)}`);
  }
  return {
    reference,
    accountNumber: action.transferAccountNumber,
    bankName: action.transferBankName,
    expiresAt: action.expiredTimestamp ? new Date(action.expiredTimestamp) : null,
  };
}

// Chidera, 2026-09-23: confirmed directly against OPay's own docs (cross-
// checked on two separate doc mirrors, identical both times) -- the
// callback signature is NOT in a header. OPay POSTs { payload: {...},
// sha512 } and the sha512 field is itself the signature to check, computed
// as HMAC-SHA3-512 (their docs state this explicitly, twice -- an unusual
// choice next to the plain SHA512 used for outgoing requests above, but
// consistent enough across sources to trust) over this EXACT, non-JSON
// template string built from 8 specific payload fields in this order:
// {Amount:"...",Currency:"...",Reference:"...",Refunded:t/f,Status:"...",
// Timestamp:"...",Token:"...",TransactionID:"..."} -- Refunded is the bare
// letter t or f, unquoted, everything else double-quoted. Because the
// mount for this route is a normal express.json() route (no header to read
// the raw body against), this recomputes from the ALREADY-PARSED payload
// object instead of a raw body string.
export function verifyOpayCallbackSignature(payload, receivedSha512) {
  const secretKey = process.env.OPAY_SECRET_KEY;
  if (!secretKey || !receivedSha512 || !payload) return false;
  const refunded = payload.refunded ? 't' : 'f';
  const template =
    `{Amount:"${payload.amount}",Currency:"${payload.currency}",Reference:"${payload.reference}",` +
    `Refunded:${refunded},Status:"${payload.status}",Timestamp:"${payload.timestamp}",` +
    `Token:"${payload.token}",TransactionID:"${payload.transactionId}"}`;
  const hash = crypto.createHmac('sha3-512', secretKey).update(template).digest('hex');
  return hash === receivedSha512;
}
