// Flat copy of scripts/lib/google-auth.mjs -- this deployment's own copy,
// needed because engine/sheet-sync.js's 15-minute sync job runs INSIDE
// this dashboard process, which has no access to the control server's
// scripts/lib/ (that's provision-time-only code, used once by
// create-client.mjs / scripts/lib/esf-sheet.mjs to create the sheet in the
// first place). Same "flat copy, not a live import" convention already
// used for bot-engine/ -- keep both copies in sync by hand if this changes.

import { sign } from 'node:crypto';

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function signJwt(serviceAccountJson, scopes) {
  const { client_email: iss, private_key: privateKey } = serviceAccountJson;
  if (!iss || !privateKey) throw new Error('Service account JSON is missing client_email or private_key.');

  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss,
    scope: scopes,
    aud: 'https://oauth2.googleapis.com/token',
    exp: nowSeconds + 3600,
    iat: nowSeconds,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claimSet))}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  const signatureB64 = signature.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${signingInput}.${signatureB64}`;
}

export async function getAccessToken(serviceAccountJson, scopes) {
  const jwt = signJwt(serviceAccountJson, scopes);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}
