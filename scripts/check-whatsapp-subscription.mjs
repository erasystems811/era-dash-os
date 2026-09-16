#!/usr/bin/env node
// Usage:
//   node check-whatsapp-subscription.mjs --client=slug
//
// Read-only companion to resubscribe-whatsapp.mjs -- confirms whether
// ERA's Meta app is actually subscribed to a client's WABA right now,
// without changing anything. Built 2026-09-16 while chasing why pomodoro
// still wasn't receiving messages after a resubscribe.

import { loadRegistry, findClient } from './lib/registry.mjs';
import { readRemote } from './lib/ssh.mjs';

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    if (eq === -1) continue;
    args[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  if (!args.client) throw new Error('Usage: check-whatsapp-subscription.mjs --client=slug');
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
  if (!wabaId) throw new Error(`"${client.name}" has no whatsappBusinessAccountId in the registry.`);

  const envText = await readRemote(client.ip, `/opt/${client.name}/.env`);
  const accessToken = readEnvVar(envText, 'META_ACCESS_TOKEN');
  const phoneId = readEnvVar(envText, 'META_PHONE_NUMBER_ID');
  const verifyToken = readEnvVar(envText, 'META_WEBHOOK_VERIFY_TOKEN');
  console.log(`registry phoneNumberId: ${client.whatsappPhoneNumberId}`);
  console.log(`.env META_PHONE_NUMBER_ID: ${phoneId}`);
  console.log(`.env has verify token set: ${Boolean(verifyToken)}`);
  if (!accessToken) throw new Error(`"${client.name}" has no META_ACCESS_TOKEN set.`);

  const subRes = await fetch(`https://graph.facebook.com/v21.0/${wabaId}/subscribed_apps`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const subData = await subRes.json();
  console.log(`subscribed_apps for WABA ${wabaId}:`, JSON.stringify(subData));

  // Also check the phone number's own state (verified_name, quality_rating,
  // code_verification_status) -- a number that never completed Meta's own
  // verification step can be fully "subscribed" and still never receive.
  if (phoneId) {
    const numRes = await fetch(`https://graph.facebook.com/v21.0/${phoneId}?fields=verified_name,code_verification_status,quality_rating,platform_type,throughput`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const numData = await numRes.json();
    console.log(`phone number status:`, JSON.stringify(numData));
  }
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
