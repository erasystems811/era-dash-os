#!/usr/bin/env node
// Usage:
//   node get-env.mjs --client=slug
//
// Prints the client's current env vars as JSON on stdout: [{key, value}].
// Values whose key looks sensitive (SECRET/KEY/TOKEN/PASSWORD/PASS) are
// masked to their last 4 characters -- this is meant to be read by the
// panel to show what's already set before someone edits it, not to hand
// real secrets back over an HTTP response.

import { loadRegistry, findClient } from './lib/registry.mjs';
import { readRemote } from './lib/ssh.mjs';

const SENSITIVE = /SECRET|KEY|TOKEN|PASSWORD|PASS\b/i;

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    if (eq === -1) continue;
    args[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  if (!args.client) throw new Error('Usage: get-env.mjs --client=slug');
  return args;
}

function mask(value) {
  if (value.length <= 4) return '****';
  return `****${value.slice(-4)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = loadRegistry();
  const client = findClient(registry, args.client);
  if (!client) throw new Error(`No client "${args.client}" in the registry. Check registry.json.`);

  const envPath = client.envPath || `/opt/${client.name}/.env`;
  const text = await readRemote(client.ip, envPath);

  const entries = text
    .split('\n')
    .map((line) => {
      const eq = line.indexOf('=');
      if (eq === -1) return null;
      const key = line.slice(0, eq).trim();
      if (!key || key.startsWith('#')) return null;
      const value = line.slice(eq + 1);
      return { key, value: SENSITIVE.test(key) ? mask(value) : value };
    })
    .filter(Boolean);

  console.log(JSON.stringify(entries));
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
