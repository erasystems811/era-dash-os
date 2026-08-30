import { sign } from 'node:crypto';

// Google service-account OAuth2 (the "JWT Bearer" flow), implemented with
// node:crypto + fetch only -- no googleapis/google-auth-library dependency,
// matching every other integration in scripts/lib/ (github.mjs, hetzner.mjs,
// dns.mjs are all raw fetch, and this directory has no package.json/
// node_modules at all). RS256-signing a JWT needs real crypto, which
// node:crypto does natively (crypto.sign) -- no SDK required for that
// either.

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// serviceAccountJson: the parsed JSON key file downloaded from Google Cloud
// Console (IAM & Admin > Service Accounts > Keys) -- needs client_email and
// private_key. scopes: space-separated string, e.g.
// 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file'.
export function signJwt(serviceAccountJson, scopes) {
  const { client_email: iss, private_key: privateKey } = serviceAccountJson;
  if (!iss || !privateKey) throw new Error('Service account JSON is missing client_email or private_key.');

  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss,
    scope: scopes,
    aud: 'https://oauth2.googleapis.com/token',
    // 3600s is Google's own max lifetime for this grant type -- a longer
    // exp is simply rejected, not extended.
    exp: nowSeconds + 3600,
    iat: nowSeconds,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claimSet))}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  const signatureB64 = signature.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${signingInput}.${signatureB64}`;
}

// Exchanges the signed JWT for a short-lived (1h) access token. Real network
// call -- not unit-testable without a real service account, unlike signJwt
// above (see google-auth.test.mjs, which tests signJwt's shape and
// signature directly with a throwaway keypair, and stops there on purpose).
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
