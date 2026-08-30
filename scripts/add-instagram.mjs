#!/usr/bin/env node
// Usage:
//   node add-instagram.mjs --client=slug --user-id=... --token=... --verify-token=...
//
// Adds Instagram (Meta) credentials to an EXISTING client app, any time
// after initial setup -- same channel-agnostic engine as WhatsApp
// (engine/instagram-send.js, engine/webhook-instagram.js), no bot logic
// changes needed, just the env vars. Patches only those three keys in the
// live .env (never a wholesale re-render -- see push-update.mjs's header
// for why that distinction matters) and restarts the stack to pick them
// up. Does NOT do Meta's own account verification/permissions review --
// that's a manual step in Meta Business Manager that can't be scripted;
// this only wires the technical side so it's ready the moment that's done.

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
  if (!args.client || !args['user-id'] || !args.token || !args['verify-token']) {
    throw new Error('Usage: add-instagram.mjs --client=slug --user-id=... --token=... --verify-token=...');
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
    INSTAGRAM_USER_ID: args['user-id'],
    INSTAGRAM_ACCESS_TOKEN: args.token,
    INSTAGRAM_WEBHOOK_VERIFY_TOKEN: args['verify-token'],
  });

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'era-ig-'));
  const tmpFile = path.join(tmpDir, '.env');
  writeFileSync(tmpFile, patched);
  await copyToRemote(client.ip, tmpFile, `${remoteDir}/.env`);
  await runRemote(client.ip, `chmod 600 ${remoteDir}/.env && cd ${remoteDir} && docker compose up -d`);

  // instagramUserId is what panel/server.js's shared Instagram router
  // (/webhook/instagram) matches an inbound message's recipient.id against
  // to know which client it belongs to -- same reasoning as
  // add-whatsapp.mjs's whatsappPhoneNumberId, needed the moment a second
  // business connects Instagram to the same shared Meta app.
  upsertClient(registry, { name: client.name, needsInstagram: true, instagramUserId: args['user-id'] });
  saveRegistry(registry);

  console.log(`Instagram env vars set for "${client.name}" and containers restarted.`);
  console.log(`Webhook URL for Meta: https://${client.subdomain}/webhook/instagram`);
  console.log('Remaining manual step: Meta Business Manager account verification/permissions (cannot be automated).');
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
