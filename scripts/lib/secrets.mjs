import { readFileSync, writeFileSync } from 'node:fs';
import { patchEnv } from './env-patch.mjs';

const SECRETS_PATH = process.env.ERA_SECRETS_PATH || '/opt/era-control/secrets.env';

export function loadSecrets(path = SECRETS_PATH) {
  const text = readFileSync(path, 'utf8');
  const secrets = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    secrets[key] = value;
  }
  return secrets;
}

export function requireSecrets(secrets, keys) {
  const missing = keys.filter((k) => !secrets[k]);
  if (missing.length) {
    throw new Error(`Missing required secrets in ${SECRETS_PATH}: ${missing.join(', ')}`);
  }
}

// Surgical, single-key-at-a-time updates (same patchEnv used for a live
// client's .env) -- the panel's job here is narrow (e.g. just the two
// Chowdeck keys), never a free-form editor over the whole file, since
// secrets.env also holds HETZNER_TOKEN/GITHUB_TOKEN/etc.
export function patchSecrets(updates, path = SECRETS_PATH) {
  const current = readFileSync(path, 'utf8');
  writeFileSync(path, patchEnv(current, updates));
}
