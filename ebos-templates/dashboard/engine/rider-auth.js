// Rider sign-in: a phone number and a PIN staff set for them, nothing else
// -- no password to forget, no app-store install (spec B3: cheapest
// possible Android, one thumb, at a junction). A rider is pre-registered by
// the restaurant first (routes/delivery.js's rider roster, which is also
// where the PIN gets set), so "sign in" here only ever authenticates
// someone already on file, never creates a rider.
//
// Was a WhatsApp AUTHENTICATION-template OTP -- switched 2026-09-02
// (Chidera's call): a rider already has to be added by staff before they
// can sign in at all, so the OTP's only real job on top of that was
// proving whoever's typing the number actually owns that phone. A PIN
// staff hands the rider directly (in person, when adding them) gives the
// same "you have to actually be this rider" property without a Meta
// template approval this codebase otherwise has no use for, and without a
// per-sign-in WhatsApp send at all.
//
// Same lockout shape as staff's own PIN accounts (lib/auth.js's
// verifyPin) -- looked up by phone number, which is unique per rider, so
// this already has the same anti-brute-force property that function's own
// comment describes (an attacker is stuck guessing against exactly one
// account, never a bare-PIN scan across every rider).
import bcrypt from 'bcryptjs';
import { pool } from '../lib/db.js';

const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 15 * 60 * 1000;

export function hashRiderPin(pin) {
  return bcrypt.hash(pin, 10);
}

// Returns the rider row on success, null on a wrong/expired/missing/
// locked-out PIN -- never throws for a bad guess, that's an ordinary
// login failure, not an error. Never reveals whether a phone number
// belongs to a real rider (a wrong phone and a wrong PIN look identical
// to the caller), same principle as any login surface.
export async function verifyRiderPin(phone, pin) {
  const { rows } = await pool.query(`select * from rider where phone = $1 and status != 'suspended'`, [phone]);
  const rider = rows[0];
  if (!rider || !rider.pin_hash) return null;

  // Checked before ever comparing the PIN -- a locked row refuses outright
  // rather than doing (and timing) a real bcrypt compare, so a locked-out
  // attacker learns nothing more from retrying.
  if (rider.pin_locked_until && new Date(rider.pin_locked_until) > new Date()) return null;

  const ok = await bcrypt.compare(pin, rider.pin_hash);
  if (ok) {
    await pool.query('update rider set pin_failed_attempts = 0, pin_locked_until = null where id = $1', [rider.id]);
    return rider;
  }

  const attempts = rider.pin_failed_attempts + 1;
  if (attempts >= PIN_MAX_ATTEMPTS) {
    await pool.query(
      'update rider set pin_failed_attempts = 0, pin_locked_until = $2 where id = $1',
      [rider.id, new Date(Date.now() + PIN_LOCKOUT_MS)]
    );
  } else {
    await pool.query('update rider set pin_failed_attempts = $2 where id = $1', [rider.id, attempts]);
  }
  return null;
}
