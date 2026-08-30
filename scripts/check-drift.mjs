#!/usr/bin/env node
// Usage:
//   node check-drift.mjs --client=slug
//   node check-drift.mjs --all-ebos
//
// The actual proof, not an assumption: hashes the CANONICAL template
// (ebos-templates/dashboard, the one source of truth push-update.mjs
// copies from) and hashes what's ACTUALLY sitting on each business's own
// server right now, then says definitively whether they match. This is
// the answer to "if I fix one bot and push, am I 100% sure every business
// is running that exact code without having to go check myself" -- run
// this and it tells you, instead of you having to SSH into 100 servers.
//
// The hash is over file CONTENTS only, sorted by path, ignoring mtimes/
// permissions -- two copies of the same code hash identically even if one
// was deployed an hour before the other. node_modules/dist/.git are
// excluded on both sides since push-update.mjs never ships those anyway
// (see lib/ssh.mjs's copyToRemote).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { loadRegistry } from './lib/registry.mjs';
import { templatesDirFor } from './lib/templates-dir.mjs';
import { runRemote } from './lib/ssh.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same exclusion set on both sides -- a business's server never has
// node_modules/dist checked out at all (push-update.mjs's copyToRemote
// excludes them), but excluding them here too is cheap insurance against
// this script ever being pointed at a directory that does have them.
const HASH_PIPELINE = `find . -type f ! -path './node_modules/*' ! -path './dist/*' ! -path './client/node_modules/*' ! -path './client/dist/*' | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1`;

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (arg.startsWith('--client=')) args.client = arg.slice('--client='.length);
    else if (arg === '--all-ebos') args.allEbos = true;
  }
  if (!args.client && !args.allEbos) throw new Error('Usage: check-drift.mjs --client=slug | --all-ebos');
  return args;
}

async function canonicalHash(templatesDir) {
  const dashboardDir = path.join(templatesDir, 'dashboard');
  const { stdout } = await execFileAsync('bash', ['-c', HASH_PIPELINE], { cwd: dashboardDir, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

async function remoteHash(client) {
  const remoteDashboardDir = `/opt/${client.name}/dashboard`;
  const { stdout } = await runRemote(client.ip, `cd ${remoteDashboardDir} && (${HASH_PIPELINE})`);
  return stdout.trim();
}

async function checkOne(client, canonicalHashesByTemplate) {
  const templateKind = client.isEbos ? 'ebos' : 'default';
  if (!(templateKind in canonicalHashesByTemplate)) {
    canonicalHashesByTemplate[templateKind] = await canonicalHash(templatesDirFor(templateKind));
  }
  const expected = canonicalHashesByTemplate[templateKind];
  try {
    const actual = await remoteHash(client);
    const inSync = actual === expected;
    console.log(`  ${client.name}: ${inSync ? 'IN SYNC' : 'OUT OF SYNC'}`);
    return { name: client.name, inSync, expected, actual };
  } catch (err) {
    console.log(`  ${client.name}: COULD NOT CHECK (${err.message})`);
    return { name: client.name, inSync: null, error: err.message };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = loadRegistry();

  const targets = args.allEbos
    ? registry.clients.filter((c) => c.isEbos && !c.customDeploy)
    : [registry.clients.find((c) => c.name === args.client)].filter(Boolean);

  if (!targets.length) {
    throw new Error(args.allEbos ? 'No client in the registry is marked isEbos: true.' : `No client "${args.client}" in the registry.`);
  }

  console.log(`Checking ${targets.length} business(es) against the canonical template...`);
  const canonicalHashesByTemplate = {};
  const results = [];
  for (const client of targets) {
    results.push(await checkOne(client, canonicalHashesByTemplate));
  }

  const outOfSync = results.filter((r) => r.inSync === false);
  const uncheckable = results.filter((r) => r.inSync === null);
  console.log(`\n=== Summary ===`);
  console.log(`  ${results.length - outOfSync.length - uncheckable.length}/${results.length} in sync`);
  if (outOfSync.length) console.log(`  OUT OF SYNC: ${outOfSync.map((r) => r.name).join(', ')}`);
  if (uncheckable.length) console.log(`  Could not check: ${uncheckable.map((r) => r.name).join(', ')}`);

  if (outOfSync.length) process.exit(1);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
