// Automatic rider payout -- one function per provider, called from routes/
// rider.js's own DELIVERED transition. Every function here returns
// { ok: true, reference } or { ok: false, error }, NEVER throws -- the
// caller writes that straight onto the rider_payout row (status SENT/
// FAILED), so a provider outage or a bad account number becomes a visible,
// retryable row on the Payouts tab, never a crashed request or a silently
// lost payment (spec B7: "never silently dropped, rule 0.4").
//
// ERA never holds, receives, or routes the money at any point in any of
// these -- every call here is ERA's code issuing an instruction against the
// RESTAURANT'S OWN provider account (delivery_config.provider_keys, the
// restaurant's own keys, encrypted -- see lib/crypto.js), landing directly
// in the rider's own bank account. If you find yourself wanting to hold a
// balance/float here, stop -- that's exactly what spec B2 rules out.
//
// Paystack and Flutterwave's transfer-out APIs are implemented for real,
// confirmed against their actual current reference docs (paystack.com/docs,
// developer.flutterwave.com) before writing this, same discipline as every
// other real third-party integration in this codebase (see engine/
// delivery.js's own Chowdeck comment). Moniepoint's business transfer-out
// API was NOT independently confirmed against real docs before this was
// written -- rather than guess at a shape for real money movement (this
// spec's own rule 0.4: never guess), it fails closed with a clear message
// instead of pretending to work. Confirm the real API first if a business
// actually needs this provider.
import { decrypt } from '../lib/crypto.js';

export async function sendPayout({ provider, providerKeys, rider, amount, reference }) {
  const keys = JSON.parse(decrypt(providerKeys) || '{}');
  switch (provider) {
    case 'paystack':
      return paystackPayout({ keys, rider, amount, reference });
    case 'flutterwave':
      return flutterwavePayout({ keys, rider, amount, reference });
    case 'moniepoint':
      return { ok: false, error: 'Moniepoint automatic payout is not built yet -- confirm the real transfer API against their docs first, then use manual payout until it is.' };
    default:
      return { ok: false, error: `Unknown payout provider "${provider}".` };
  }
}

// Paystack requires a "transfer recipient" object before a transfer can
// reference it -- two calls, not one. A fresh recipient is created per
// payout rather than cached/reused: riders can change their bank details
// (routes/delivery.js's rider edit), and a stale cached recipient code
// pointing at an old account is exactly the kind of silent-wrong-money bug
// this file exists to avoid.
async function paystackPayout({ keys, rider, amount, reference }) {
  if (!keys.secretKey) return { ok: false, error: 'No Paystack secret key configured for this business.' };
  if (!rider.bankAccountNumber || !rider.bankCode) return { ok: false, error: 'This rider has no bank details on file.' };
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${keys.secretKey}` };

  try {
    const recipientRes = await fetch('https://api.paystack.co/transferrecipient', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'nuban',
        name: rider.accountName || rider.name,
        account_number: rider.bankAccountNumber,
        bank_code: rider.bankCode,
        currency: 'NGN',
      }),
    });
    const recipientData = await recipientRes.json();
    if (!recipientRes.ok || !recipientData.status) {
      return { ok: false, error: `Could not add ${rider.name} as a transfer recipient: ${recipientData.message || recipientRes.status}` };
    }
    const recipientCode = recipientData.data.recipient_code;

    const transferRes = await fetch('https://api.paystack.co/transfer', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        source: 'balance',
        amount: Math.round(Number(amount) * 100), // Paystack amounts are in kobo, same convention as engine/payment.js
        recipient: recipientCode,
        reference,
        reason: `Delivery payout -- ${rider.name}`,
      }),
    });
    const transferData = await transferRes.json();
    if (!transferRes.ok || !transferData.status) {
      return { ok: false, error: `Transfer failed: ${transferData.message || transferRes.status}` };
    }
    return { ok: true, reference: transferData.data.reference || reference };
  } catch (err) {
    return { ok: false, error: `Paystack request failed: ${err.message}` };
  }
}

// Flutterwave's transfer API is a single call (no separate recipient step)
// -- bank code and account number go straight on the transfer itself.
async function flutterwavePayout({ keys, rider, amount, reference }) {
  if (!keys.secretKey) return { ok: false, error: 'No Flutterwave secret key configured for this business.' };
  if (!rider.bankAccountNumber || !rider.bankCode) return { ok: false, error: 'This rider has no bank details on file.' };

  try {
    const res = await fetch('https://api.flutterwave.com/v3/transfers', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${keys.secretKey}` },
      body: JSON.stringify({
        account_bank: rider.bankCode,
        account_number: rider.bankAccountNumber,
        amount: Number(amount),
        currency: 'NGN',
        reference,
        narration: `Delivery payout -- ${rider.name}`,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') {
      return { ok: false, error: `Transfer failed: ${data.message || res.status}` };
    }
    return { ok: true, reference: data.data?.reference || reference };
  } catch (err) {
    return { ok: false, error: `Flutterwave request failed: ${err.message}` };
  }
}
