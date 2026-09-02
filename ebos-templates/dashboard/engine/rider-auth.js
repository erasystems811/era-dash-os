// Rider sign-in: a phone number and a one-time code, nothing else -- no
// password to forget, no app-store install (spec B3: cheapest possible
// Android, one thumb, at a junction). A rider is pre-registered by the
// restaurant first (routes/delivery.js's rider roster), so "sign in" here
// only ever authenticates someone already on file, never creates a rider.
//
// The OTP goes out as a WhatsApp AUTHENTICATION-category template, not the
// shared env credentials' plain text send -- a rider has never messaged the
// business's WhatsApp number before their first sign-in, and Meta will not
// deliver a freeform message to a number that hasn't opened a conversation
// window. ERA must submit a template with exactly this name to Meta for a
// business's WABA (per-business, same one-off manual step category as
// add-whatsapp.mjs's own Meta verification) before this can send for real --
// EBOS_SANDBOX=1 prints instead, same as every other WhatsApp send in this
// codebase, so the rest of the flow can be built and tested before that
// approval exists.
import { pool } from '../lib/db.js';
import { sendWhatsAppTemplate } from './whatsapp-send.js';
import { getWhatsAppCredentials } from './branch-channel.js';

const RIDER_OTP_TEMPLATE = 'rider_login_otp';
const OTP_TTL_MINUTES = 10;

function generateOtp() {
  // 6 digits, zero-padded -- a rider reads this off a WhatsApp message and
  // types it back, so it stays short and unambiguous (no letters that look
  // alike on a small cheap screen).
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

export async function requestRiderOtp(phone) {
  const { rows } = await pool.query('select id, branch_id from rider where phone = $1 and status != \'suspended\'', [phone]);
  const rider = rows[0];
  // Never reveal whether a phone number is a real rider -- same principle
  // as any login surface. The caller always gets the same "check your
  // WhatsApp" response either way (see routes/rider.js); this function
  // simply does nothing when there's no match instead of erroring.
  if (!rider) return;

  const code = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
  await pool.query('update rider set otp_code = $1, otp_expires_at = $2 where id = $3', [code, expiresAt, rider.id]);

  const credentials = await getWhatsAppCredentials(rider.branch_id);
  await sendWhatsAppTemplate(
    phone,
    RIDER_OTP_TEMPLATE,
    'en_US',
    [{ type: 'body', parameters: [{ type: 'text', text: code }] }],
    credentials
  );
}

// Returns the rider row on success, null on a wrong/expired/missing code --
// never throws for a bad guess, that's an ordinary login failure, not an
// error.
export async function verifyRiderOtp(phone, code) {
  const { rows } = await pool.query(
    `select * from rider where phone = $1 and otp_code = $2 and otp_expires_at > now() and status != 'suspended'`,
    [phone, code]
  );
  const rider = rows[0];
  if (!rider) return null;
  // One-time -- a code already used (or expired) can never be replayed.
  await pool.query('update rider set otp_code = null, otp_expires_at = null where id = $1', [rider.id]);
  return rider;
}
