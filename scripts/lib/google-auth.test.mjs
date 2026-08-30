#!/usr/bin/env node
// Regression check for google-auth.mjs -- same convention as
// bot-engine/lib/lib.test.mjs (a file next to what it tests, run directly
// with node, not a test framework). Only signJwt is covered: it's pure and
// verifiable with a throwaway RSA keypair, no real Google service account
// needed. getAccessToken's actual network call to Google is NOT covered
// here -- there is no way to test that without a real service account key,
// which this repo does not have as of this writing. Flagged, not silently
// skipped.

import { generateKeyPairSync, verify } from 'node:crypto';
import { signJwt } from './google-auth.mjs';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok: ${name}`);
}

function b64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const fakeServiceAccount = {
  client_email: 'esf-sheets@fake-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs1', format: 'pem' }),
};
const scopes = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file';

const jwt = signJwt(fakeServiceAccount, scopes);
const [headerB64, claimB64, sigB64] = jwt.split('.');

check('JWT has exactly three dot-separated parts', () => {
  if (jwt.split('.').length !== 3) throw new Error(`expected header.claims.signature, got: ${jwt}`);
});

check('header is {"alg":"RS256","typ":"JWT"}', () => {
  const header = JSON.parse(b64urlDecode(headerB64));
  if (header.alg !== 'RS256' || header.typ !== 'JWT') throw new Error(`unexpected header: ${JSON.stringify(header)}`);
});

check('claim set has the right iss/scope/aud and exp is exactly 3600s after iat', () => {
  const claims = JSON.parse(b64urlDecode(claimB64));
  if (claims.iss !== fakeServiceAccount.client_email) throw new Error(`wrong iss: ${claims.iss}`);
  if (claims.scope !== scopes) throw new Error(`wrong scope: ${claims.scope}`);
  if (claims.aud !== 'https://oauth2.googleapis.com/token') throw new Error(`wrong aud: ${claims.aud}`);
  if (claims.exp - claims.iat !== 3600) throw new Error(`expected a 3600s lifetime, got ${claims.exp - claims.iat}`);
});

check('signature verifies against the keypair\'s public key (real RS256, not a stub)', () => {
  const signingInput = `${headerB64}.${claimB64}`;
  const signature = Buffer.from(sigB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const ok = verify('RSA-SHA256', Buffer.from(signingInput), publicKey, signature);
  if (!ok) throw new Error('signature did not verify against the public key -- signJwt is producing an invalid RS256 signature');
});

check('signature does NOT verify against a different keypair (not a no-op check)', () => {
  const { publicKey: otherPublicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const signingInput = `${headerB64}.${claimB64}`;
  const signature = Buffer.from(sigB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const ok = verify('RSA-SHA256', Buffer.from(signingInput), otherPublicKey, signature);
  if (ok) throw new Error('signature verified against the WRONG public key -- the verify check above is not actually discriminating');
});

console.log(`\n${passed} checks passed.`);
