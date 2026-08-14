#!/usr/bin/env node
// Usage:
//   node set-env.mjs --client=slug --KEY=value [--KEY2=value2 ...]
//
// Generic env-var setter for ANY existing client, not just WhatsApp/payment
// (those two scripts are really just this operation with fixed key names).
// Patches the client's remote .env and restarts its stack. This is meant to
// be the standing, always-available way to change env vars from the panel
// -- no server access needed for routine key rotation or adding a new
// integration's secret.
//
// A client can override where its env file lives and how it restarts by
// setting `envPath` / `restartCommand` in the registry -- the default
// (/opt/<name>/.env, `docker compose up -d`) only fits the standard
// n8n+Postgres+PostgREST bot-client template this engine provisions.
// Anything deployed a different way (e.g. a plain Node process manager)
// needs those two fields set once in registry.json.

import { loadRegistry, findClient } from './lib/registry.mjs';
import { readRemote, runRemote, copyToRemote } from './lib/ssh.mjs';
import { patchEnv } from './lib/env-patch.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function parseArgs(argv) {
  const args = { client: undefined, updates: {} };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) continue;
    const key = arg.slice(2, eq);
    const value = arg.slice(eq + 1);
    if (key === 'client') args.client = value;
    else args.updates[key] = value;
  }
  if (!args.client) throw new Error('Usage: set-env.mjs --client=slug --KEY=value [--KEY2=value2 ...]');
  if (Object.keys(args.updates).length === 0) throw new Error('Provide at least one --KEY=value to set.');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = loadRegistry();
  const client = findClient(registry, args.client);
  if (!client) throw new Error(`No client "${args.client}" in the registry. Check registry.json.`);

  const envPath = client.envPath || `/opt/${client.name}/.env`;
  const restartCommand = client.restartCommand || `cd /opt/${client.name} && docker compose up -d`;

  const current = await readRemote(client.ip, envPath);
  const patched = patchEnv(current, args.updates);

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'era-env-'));
  const tmpFile = path.join(tmpDir, '.env');
  writeFileSync(tmpFile, patched);
  await copyToRemote(client.ip, tmpFile, envPath);
  await runRemote(client.ip, `chmod 600 ${envPath} && ${restartCommand}`);

  console.log(`Set ${Object.keys(args.updates).join(', ')} for "${client.name}" and restarted.`);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
