#!/usr/bin/env node
// Usage: node teardown-client.mjs --client=slug
// Deletes the droplet + GitHub repo for a client and removes it from the
// registry. Meant for tearing down test clients created while verifying
// this automation — NOT for real client offboarding without extra thought
// (this is permanent and does not back anything up first).

import { loadRegistry, saveRegistry, findClient, removeClient } from './lib/registry.mjs';
import { loadSecrets } from './lib/secrets.mjs';
import * as digitalocean from './lib/digitalocean.mjs';
import * as github from './lib/github.mjs';

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    args[key] = rest.join('=');
  }
  if (!args.client) throw new Error('Usage: teardown-client.mjs --client=slug');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = loadRegistry();
  const client = findClient(registry, args.client);
  if (!client) throw new Error(`No client "${args.client}" in the registry.`);

  const secrets = loadSecrets();

  console.log(`Deleting droplet ${client.dropletId} (${client.ip})...`);
  await digitalocean.deleteDroplet(secrets.DIGITALOCEAN_TOKEN, client.dropletId);

  const repoMatch = client.repo.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (repoMatch) {
    console.log(`Deleting GitHub repo ${repoMatch[1]}/${repoMatch[2]}...`);
    await github.deleteRepo(secrets.GITHUB_TOKEN, repoMatch[1], repoMatch[2]);
  }

  console.log('NOTE: the DNS A record was not auto-removed (delete it manually in the Go54 panel if it was added).');

  removeClient(registry, client.name);
  saveRegistry(registry);
  console.log(`Removed "${client.name}" from the registry.`);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
