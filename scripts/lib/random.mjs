import { randomBytes } from 'node:crypto';

export function randomSecret(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

export function randomPassword(bytes = 18) {
  return randomBytes(bytes).toString('base64url');
}

// n8n requires a 32-hex-char (or longer) string for N8N_ENCRYPTION_KEY.
export function randomEncryptionKey() {
  return randomBytes(32).toString('hex');
}

export function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
