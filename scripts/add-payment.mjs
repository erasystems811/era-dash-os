#!/usr/bin/env node
// Usage:
//   node add-payment.mjs --client=slug --provider=flutterwave|paystack --secret-key=... --public-key=...
//   node add-payment.mjs --client=slug --provider=monnify --api-key=... --secret-key=... --contract-code=...
//   node add-payment.mjs --client=slug --provider=opay --merchant-id=... --secret-key=...
//
// Adds a payment provider to an EXISTING client app, any time after initial
// setup. Restarts that client's containers. Does NOT do the provider's own
// business/KYC verification — that's a manual step on Flutterwave's,
// Paystack's, Monnify's, or OPay's dashboard that can't be scripted; this
// script only wires the technical side (env vars) so it's ready the moment
// verification is done.
//
// Monnify and OPay each use their OWN env var names (MONNIFY_*/OPAY_*), not
// the generic PAYMENT_* ones Flutterwave/Paystack share -- deliberately, so
// a business can have several providers' credentials set at once;
// payment_config.provider (Settings, "How this client gets paid") decides
// which is actually active, not which env vars merely exist.

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
  if (!args.client || !args.provider) {
    throw new Error(
      'Usage: add-payment.mjs --client=slug --provider=flutterwave|paystack --secret-key=... --public-key=...\n' +
        '       add-payment.mjs --client=slug --provider=monnify --api-key=... --secret-key=... --contract-code=...\n' +
        '       add-payment.mjs --client=slug --provider=opay --merchant-id=... --secret-key=...'
    );
  }
  if (!['flutterwave', 'paystack', 'monnify', 'opay'].includes(args.provider)) {
    throw new Error('--provider must be "flutterwave", "paystack", "monnify", or "opay"');
  }
  if (args.provider === 'monnify') {
    if (!args['api-key'] || !args['secret-key'] || !args['contract-code']) {
      throw new Error('monnify requires --api-key, --secret-key, and --contract-code');
    }
  } else if (args.provider === 'opay') {
    if (!args['merchant-id'] || !args['secret-key']) {
      throw new Error('opay requires --merchant-id and --secret-key');
    }
  } else if (!args['secret-key'] || !args['public-key']) {
    throw new Error(`${args.provider} requires --secret-key and --public-key`);
  }
  return args;
}

function envForProvider(args) {
  if (args.provider === 'monnify') {
    return {
      MONNIFY_API_KEY: args['api-key'],
      MONNIFY_SECRET_KEY: args['secret-key'],
      MONNIFY_CONTRACT_CODE: args['contract-code'],
    };
  }
  if (args.provider === 'opay') {
    return {
      OPAY_MERCHANT_ID: args['merchant-id'],
      OPAY_SECRET_KEY: args['secret-key'],
    };
  }
  return {
    PAYMENT_PROVIDER: args.provider,
    PAYMENT_SECRET_KEY: args['secret-key'],
    PAYMENT_PUBLIC_KEY: args['public-key'],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = loadRegistry();
  const client = findClient(registry, args.client);
  if (!client) throw new Error(`No client "${args.client}" in the registry. Check registry.json.`);

  const remoteDir = `/opt/${client.name}`;
  const current = await readRemote(client.ip, `${remoteDir}/.env`);
  const patched = patchEnv(current, envForProvider(args));

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'era-pay-'));
  const tmpFile = path.join(tmpDir, '.env');
  writeFileSync(tmpFile, patched);
  await copyToRemote(client.ip, tmpFile, `${remoteDir}/.env`);
  await runRemote(client.ip, `chmod 600 ${remoteDir}/.env && cd ${remoteDir} && docker compose up -d`);

  upsertClient(registry, { name: client.name, needsPayment: true, paymentProvider: args.provider });
  saveRegistry(registry);

  console.log(`${args.provider} keys set for "${client.name}" and containers restarted.`);
  console.log('Remaining manual step: business/KYC verification on the provider\'s dashboard (cannot be automated).');
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
