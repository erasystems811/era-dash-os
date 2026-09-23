#!/usr/bin/env node
// Usage:
//   node resubscribe-whatsapp.mjs --client=slug
//
// Re-subscribes ERA's Meta app to a client's existing WABA, using whatever
// META_ACCESS_TOKEN/META_WEBHOOK_BUSINESS_ACCOUNT_ID is already live in
// their .env -- unlike add-whatsapp.mjs this never touches the phone
// number/verify-token/env vars at all, so it's safe to run any time a
// client's messages stop arriving without risking their existing webhook
// verification. Built 2026-09-16 after discovering add-whatsapp.mjs's
// manual-entry path never did this in the first place (see its own
// comment) -- pomodoro's first real inbound message never reached the bot
// because of exactly this gap.

import { loadRegistry, findClient } from './lib/registry.mjs';
import { readRemote } from './lib/ssh.mjs';

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    if (eq === -1) continue;
    args[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  if (!args.client) throw new Error('Usage: resubscribe-whatsapp.mjs --client=slug');
  return args;
}

function readEnvVar(text, key) {
  const line = text.split('\n').find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = loadRegistry();
  const client = findClient(registry, args.client);
  if (!client) throw new Error(`No client "${args.client}" in the registry.`);

  const wabaId = client.whatsappBusinessAccountId;
  if (!wabaId) throw new Error(`"${client.name}" has no whatsappBusinessAccountId in the registry -- connect WhatsApp first.`);

  const envText = await readRemote(client.ip, `/opt/${client.name}/.env`);
  const accessToken = readEnvVar(envText, 'META_ACCESS_TOKEN');
  if (!accessToken) throw new Error(`"${client.name}" has no META_ACCESS_TOKEN set yet -- connect WhatsApp first.`);

  const subRes = await fetch(`https://graph.facebook.com/v21.0/${wabaId}/subscribed_apps`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const subData = await subRes.json();
  if (!subRes.ok || !subData.success) {
    throw new Error(`WABA subscription failed: ${subData.error?.message || subRes.status}`);
  }
  console.log(`Subscribed ERA's app to "${client.name}"'s WABA (${wabaId}) -- Meta will now deliver webhook events for this number.`);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
