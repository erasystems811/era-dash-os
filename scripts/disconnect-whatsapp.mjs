#!/usr/bin/env node
// Usage:
//   node disconnect-whatsapp.mjs --client=slug
//
// Reverses add-whatsapp.mjs: severs a client's link to their current
// WhatsApp number. Clears their META_* env vars (so their own bot stops
// trying to send with that token) and restarts their container, then
// clears whatsappPhoneNumberId/whatsappBusinessAccountId/needsWhatsapp in
// the registry (so panel/server.js's shared /webhook/whatsapp router no
// longer forwards that number's messages to them). Does NOT unsubscribe
// ERA's Meta app from the WABA or touch anything in Meta Business
// Manager -- that's the business's own number/app to manage; if the goal
// is reassigning the same number to a different client, do that in Meta
// first, then run add-whatsapp.mjs for the new client.

import { loadRegistry, saveRegistry, findClient, upsertClient } from './lib/registry.mjs';
import { readRemote, runRemote, copyToRemote } from './lib/ssh.mjs';
import { patchEnv } from './lib/env-patch.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    if (eq === -1) continue;
    args[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  if (!args.client) throw new Error('Usage: disconnect-whatsapp.mjs --client=slug');
  return args;
}

function mktemp() {
  return mkdtempSync(path.join(os.tmpdir(), 'era-wa-disconnect-'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = loadRegistry();
  const client = findClient(registry, args.client);
  if (!client) throw new Error(`No client "${args.client}" in the registry. Check registry.json.`);

  const disconnectedPhoneNumberId = client.whatsappPhoneNumberId || null;
  if (!disconnectedPhoneNumberId) {
    console.log(`"${client.name}" has no WhatsApp number connected in the registry already -- nothing to do there.`);
  }

  const remoteDir = `/opt/${client.name}`;
  const current = await readRemote(client.ip, `${remoteDir}/.env`);
  const patched = patchEnv(current, {
    META_ACCESS_TOKEN: '',
    META_PHONE_NUMBER_ID: '',
    META_WEBHOOK_VERIFY_TOKEN: '',
  });

  const tmpDir = mktemp();
  const tmpFile = path.join(tmpDir, '.env');
  writeFileSync(tmpFile, patched);
  await copyToRemote(client.ip, tmpFile, `${remoteDir}/.env`);
  await runRemote(client.ip, `chmod 600 ${remoteDir}/.env && cd ${remoteDir} && docker compose up -d`);

  upsertClient(registry, {
    name: client.name,
    needsWhatsapp: false,
    whatsappPhoneNumberId: null,
    whatsappBusinessAccountId: null,
  });
  saveRegistry(registry);

  console.log(`WhatsApp env vars cleared for "${client.name}" and container restarted.`);
  if (disconnectedPhoneNumberId) {
    console.log(`Removed phone_number_id ${disconnectedPhoneNumberId} from the registry -- the shared router will no longer forward it here.`);
  }
  console.log('Remaining manual step (only if this number is moving to another client): release/reassign it in Meta Business Manager, then run add-whatsapp.mjs for the new client.');
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
