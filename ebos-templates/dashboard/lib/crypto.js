// Encrypts the delivery add-on's own secrets at rest -- a rider's real bank
// account details (many people, not one business) and a business's own
// transfer-API provider keys (delivery_config.provider_keys), unlike every
// existing per-business secret in this codebase (Paystack's key, Chowdeck's
// key), which lives in this deployment's own .env and never touches the
// database. Keyed off PAYMENT_ENCRYPTION_KEY -- already generated and
// shipped into every EBOS deployment's .env by create-client.mjs, unused by
// anything until now.
import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended for GCM

function key() {
  const raw = process.env.PAYMENT_ENCRYPTION_KEY;
  if (!raw) throw new Error('PAYMENT_ENCRYPTION_KEY is not set for this deployment.');
  // The key is a random string (scripts/lib/random.mjs's randomSecret), not
  // already 32 raw bytes -- sha256 gives AES-256-GCM the exact key length
  // it needs regardless of the source string's own length.
  return crypto.createHash('sha256').update(raw).digest();
}

// Returns a single self-contained string ("iv:authTag:ciphertext", each hex)
// so one text column holds everything needed to decrypt later -- no second
// column for the IV to keep in sync.
export function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decrypt(stored) {
  if (!stored) return null;
  const [ivHex, authTagHex, ciphertextHex] = stored.split(':');
  if (!ivHex || !authTagHex || !ciphertextHex) throw new Error('Malformed encrypted value.');
  const decipher = crypto.createDecipheriv(ALGORITHM, key(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]);
  return plaintext.toString('utf8');
}
