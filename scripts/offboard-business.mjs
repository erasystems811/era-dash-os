#!/usr/bin/env node
// Usage: node offboard-business.mjs --client=slug
//
// The SAFE offboarding step -- exports everything that business owns
// (same bundle their own Settings > Download my data produces) to a local
// file, and marks the business offboarded in the registry. Deliberately
// does NOT touch the server, database, or WhatsApp connection -- deleting
// the server is a separate, later, deliberate decision (teardown-
// client.mjs), made once the handover is actually confirmed done, never
// bundled into this.
//
// What this does NOT automate, on purpose (it's Meta's own account, not
// something reachable from here): releasing/transferring the WhatsApp
// number out of ERA's own Meta Business Manager (confirmed: numbers sit
// under ERA's manager, not the business's own). That's a real, manual
// step in Meta Business Manager -- do it once the export below is safely
// in the business's hands.

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry, saveRegistry, findClient, upsertClient } from './lib/registry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (arg.startsWith('--client=')) args.client = arg.slice('--client='.length);
  }
  if (!args.client) throw new Error('Usage: offboard-business.mjs --client=slug');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = loadRegistry();
  const client = findClient(registry, args.client);
  if (!client) throw new Error(`No client "${args.client}" in the registry.`);
  if (!client.ebosAdminToken) throw new Error(`"${client.name}" has no ebosAdminToken in the registry -- can't authenticate the export request.`);

  console.log(`Exporting ${client.name}'s data (server and database are not touched)...`);
  const res = await fetch(`https://${client.subdomain}/api/export`, {
    headers: { 'x-era-admin-token': client.ebosAdminToken },
  });
  if (!res.ok) {
    throw new Error(`Export request failed: ${res.status} ${await res.text()}`);
  }
  const bundle = await res.text();

  const outDir = path.join(__dirname, '..', '..', 'offboarding-exports');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${client.name}-export-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(outFile, bundle);

  upsertClient(registry, { name: client.name, offboarded: true, offboardedAt: new Date().toISOString() });
  saveRegistry(registry);

  console.log(`Export saved: ${outFile}`);
  console.log(`"${client.name}" marked offboarded in the registry -- server and database are untouched, still running.`);
  console.log('Remaining manual step: release/transfer this business\'s WhatsApp number in Meta Business Manager.');
  console.log(`When (and only when) you're ready to actually delete the server, that's a separate, deliberate step: node teardown-client.mjs --client=${client.name}`);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
