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
import { runScaffoldBot } from './lib/scaffold-runner.mjs';
import { createOutreachTemplate } from './lib/whatsapp-templates.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    args[key] = rest.join('=');
  }
  if (!args.client || !args.token || !args['phone-id'] || !args['verify-token'] || !args['waba-id']) {
    throw new Error('Usage: add-whatsapp.mjs --client=slug --token=... --phone-id=... --verify-token=... --waba-id=...');
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

  // Chidera, 2026-09-16: "i texted pomodoro no reply" -- root cause was
  // here. Embedded Signup (panel/server.js's /api/connect/:token/complete)
  // subscribes ERA's Meta app to the WABA as part of that flow; this
  // manual-entry path never did, so Meta never sends a single webhook
  // event for a client connected this way -- routing/server health is
  // irrelevant, the message never leaves Meta's side. Same call as that
  // flow, idempotent (safe to POST even if already subscribed).
  const subRes = await fetch(`https://graph.facebook.com/v21.0/${args['waba-id']}/subscribed_apps`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.token}` },
  });
  const subData = await subRes.json();
  if (!subRes.ok || !subData.success) {
    throw new Error(`WABA subscription failed: ${subData.error?.message || subRes.status} -- WhatsApp env vars were still saved, but Meta will not deliver any messages until this succeeds. Re-run this script to retry.`);
  }
  console.log('Subscribed ERA\'s app to this WABA -- Meta will now deliver webhook events for this number.');

  // whatsappPhoneNumberId is what panel/server.js's shared WhatsApp router
  // (/webhook/whatsapp) matches an inbound message's phone_number_id
  // against to know which client it belongs to -- without this, a client
  // added through this script is invisible to that router and any message
  // for their number falls through to its Nexa fallback instead of ever
  // reaching them. Confirmed missing here (this call used to only set
  // needsWhatsapp) while building that router's Instagram counterpart.
  upsertClient(registry, {
    name: client.name,
    needsWhatsapp: true,
    whatsappPhoneNumberId: args['phone-id'],
    whatsappBusinessAccountId: args['waba-id'],
  });
  saveRegistry(registry);

  if (!client.hasBotEngine) {
    console.log('Setting up bot-engine (first time WhatsApp has been enabled for this client)...');
    await runScaffoldBot(client.name);
  }

  // Lets this business message a customer first, any time, outside the
  // normal 24-hour reply window -- Meta requires an approved template for
  // that. One submission per business, right when its own WABA is known;
  // review happens async, this call doesn't block on it.
  try {
    await createOutreachTemplate({ accessToken: args.token, wabaId: args['waba-id'], businessName: client.displayName });
    console.log('Submitted "business_outreach" message template for Meta review (pending approval, usually quick).');
  } catch (err) {
    console.log(`WARNING: could not submit the outreach template automatically: ${err.message}`);
    console.log('WhatsApp itself still works -- this only affects the "message a customer first" feature.');
  }

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
