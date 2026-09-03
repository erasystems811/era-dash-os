// Payment provider keys are encrypted at rest (pgp_sym_encrypt/decrypt from
// the pgcrypto extension, see schema.sql) because this one EBOS deployment
// holds many businesses' keys at once -- unlike a normal ERA client app,
// which has exactly one set of secrets living in its own .env. The
// encryption key itself is a per-deployment secret, PAYMENT_ENCRYPTION_KEY.
import { pool } from './db.js';

function requireKey() {
  const key = process.env.PAYMENT_ENCRYPTION_KEY;
  if (!key) throw new Error('PAYMENT_ENCRYPTION_KEY is not set for this deployment.');
  return key;
}

export async function encryptPaymentValue(plaintext) {
  if (!plaintext) return null;
  const { rows } = await pool.query('select pgp_sym_encrypt($1, $2) as value', [plaintext, requireKey()]);
  return rows[0].value;
}

export async function decryptPaymentValue(encrypted) {
  if (!encrypted) return null;
  const { rows } = await pool.query('select pgp_sym_decrypt($1, $2) as value', [encrypted, requireKey()]);
  return rows[0].value;
}
