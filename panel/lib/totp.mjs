// TOTP (RFC 6238) -- the same algorithm Google Authenticator, Authy, and
// every other authenticator app use. Hand-rolled on Node's own crypto
// module rather than an npm package: this panel has exactly two
// dependencies today (express, express-basic-auth), and TOTP is short
// enough (base32 decode + one HMAC-SHA1 + dynamic truncation) that adding
// a third dependency for it isn't worth the extra supply-chain surface.
import { createHmac, randomBytes } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

export function generateSecret() {
  // 20 raw bytes (160 bits) is the RFC 4226 recommendation for the HMAC
  // key length -- base32-encoded so it's typeable/scannable, the same
  // shape every authenticator app expects.
  return base32Encode(randomBytes(20));
}

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input) {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function codeForCounter(secretBytes, counter) {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secretBytes).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const truncated =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(truncated % 10 ** DIGITS).padStart(DIGITS, '0');
}

// window: how many 30-second steps of clock drift either side to accept --
// 1 means the code just before or after "now" also verifies, which covers
// the ordinary case of a phone's clock being a few seconds off without
// opening the door to a much wider guessing window.
export function verifyTotp(base32Secret, token, window = 1) {
  if (!/^\d{6}$/.test(String(token || '').trim())) return false;
  const secretBytes = base32Decode(base32Secret);
  const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  for (let errorWindow = -window; errorWindow <= window; errorWindow++) {
    if (codeForCounter(secretBytes, counter + errorWindow) === String(token).trim()) return true;
  }
  return false;
}

// otpauth:// URI -- what a QR code would encode, and also what every
// authenticator app accepts pasted directly into its own "add manually"
// flow, so no QR generation library is needed either.
export function otpauthUri(secret, accountName, issuer = 'ERA Dash OS') {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=${DIGITS}&period=${STEP_SECONDS}`;
}
