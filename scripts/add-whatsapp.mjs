#!/usr/bin/env node
// Usage:
//   node add-whatsapp.mjs --client=slug --token=... --phone-id=... --verify-token=...
//
// Adds WhatsApp (Meta) credentials to an EXISTING client app, any time after
// initial setup. Restarts that client's n8n container to pick up the new
// env vars. Does NOT do Meta's own business/number verification — that's a
// manual step in Meta Business Manager that can't be scripted; this script
// only wires the technical side (env vars + webhook URL) so it's ready the
// moment verification is done.

import { loadRegistry, saveRegistry, findClient, upsertClient } from './lib/registry.mjs';
import { readRemote, runRemote, copyToRemote } from './lib/ssh.mjs';
import { patchEnv } from './lib/env-patch.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    args[key] = rest.join('=');
  }
  if (!args.client || !args.token || !args['phone-id'] || !args['verify-token']) {
    throw new Error('Usage: add-whatsapp.mjs --client=slug --token=... --phone-id=... --verify-token=...');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = loadRegistry();
  const client = findClient(registry, args.client);
  if (!client) throw new Error(`No client "${args.client}" in the registry. Check registry.json.`);

  const remoteDir = `/opt/${client.name}`;
  const current = await readRemote(client.ip, `${remoteDir}/.env`);
  const patched = patchEnv(current, {
    META_ACCESS_TOKEN: args.token,
    META_PHONE_NUMBER_ID: args['phone-id'],
    META_WEBHOOK_VERIFY_TOKEN: args['verify-token'],
  });

  const tmpDir = mktemp();
  const tmpFile = path.join(tmpDir, '.env');
  writeFileSync(tmpFile, patched);
  await copyToRemote(client.ip, tmpFile, `${remoteDir}/.env`);
  await runRemote(client.ip, `chmod 600 ${remoteDir}/.env && cd ${remoteDir} && docker compose up -d`);

  upsertClient(registry, { name: client.name, needsWhatsapp: true });
  saveRegistry(registry);

  console.log(`WhatsApp env vars set for "${client.name}" and containers restarted.`);
  console.log(`Webhook URL for Meta: https://${client.subdomain}/webhook/whatsapp-inbound (adjust if this client's n8n workflow uses a different path)`);
  console.log('Remaining manual step: Meta Business Manager verification/number setup (cannot be automated).');
}

function mktemp() {
  return mkdtempSync(path.join(os.tmpdir(), 'era-wa-'));
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
