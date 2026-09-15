#!/usr/bin/env node
// Usage: node teardown-client.mjs --client=slug
// Deletes the droplet + GitHub repo for a client and removes it from the
// registry. Meant for tearing down test clients created while verifying
// this automation — NOT for real client offboarding without extra thought
// (this is permanent and does not back anything up first).

import { loadRegistry, saveRegistry, findClient, removeClient, clientsOnServer } from './lib/registry.mjs';
import { loadSecrets } from './lib/secrets.mjs';
import * as digitalocean from './lib/digitalocean.mjs';
import * as hetzner from './lib/hetzner.mjs';
import * as oracle from './lib/oracle.mjs';
import * as ovh from './lib/ovh.mjs';
import * as github from './lib/github.mjs';
import * as dns from './lib/dns.mjs';
import { runRemote } from './lib/ssh.mjs';
import { removeSite } from './lib/shared-host.mjs';

const ROOT_DOMAIN = process.env.ERA_ROOT_DOMAIN || 'erasystems.com.ng';

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
  if (client.customDeploy) throw new Error(`${args.client} runs a custom app deploy, not the standard template -- this script would overwrite it. See the client's own repo/deploy setup instead.`);

  const secrets = loadSecrets();

  if (client.serverMode === 'shared') {
    // Other clients may still be live on this same server -- deleting it
    // would take them down too. Tear down only this client's own stack
    // (its containers, volumes, and files) and unhook it from the shared
    // Caddy; the server itself is left running.
    console.log(`${client.name} is on a shared server (${client.ip}) -- removing just this client's own stack, not the server.`);
    const remoteDir = `/opt/${client.name}`;
    try {
      await runRemote(client.ip, `cd ${remoteDir} && docker compose down -v`);
      await runRemote(client.ip, `rm -rf ${remoteDir}`);
    } catch (err) {
      console.log(`  NOTE: couldn't tear down the remote stack (${err.message}) -- it may already be gone, or need manual cleanup on ${client.ip}.`);
    }
    await removeSite(client.ip, client.name);
    console.log('  Removed this client\'s stack and its routing from the shared Caddy.');
    const remaining = clientsOnServer(registry, client.ip).filter((c) => c.name !== client.name);
    if (!remaining.length) {
      console.log(`  NOTE: ${client.ip} now has no other clients on it. It's still running (not auto-deleted, since deleting a server is a bigger decision than tearing down one client) -- either reuse it with --shared-server=${client.ip} for the next client, or delete it by hand (the ${client.provider || 'oracle'} console, or that provider's deleteServer with its server ID) if you want the cost back.`);
    }
  } else {
    const provider = client.provider || 'digitalocean'; // older registry entries predate the provider field
    const serverId = client.serverId ?? client.dropletId;
    console.log(`Deleting ${provider} server ${serverId} (${client.ip})...`);
    if (provider === 'hetzner') {
      await hetzner.deleteServer(secrets.HETZNER_TOKEN, serverId);
    } else if (provider === 'oracle') {
      await oracle.deleteServer(oracle.requireOracleConfig(secrets), serverId);
    } else if (provider === 'ovh') {
      await ovh.deleteServer(ovh.requireOvhConfig(secrets), serverId);
    } else {
      await digitalocean.deleteDroplet(secrets.DIGITALOCEAN_TOKEN, serverId);
    }
  }

  const repoMatch = client.repo ? client.repo.match(/github\.com\/([^/]+)\/([^/]+)/) : null;
  if (repoMatch) {
    console.log(`Deleting GitHub repo ${repoMatch[1]}/${repoMatch[2]}...`);
    await github.deleteRepo(secrets.GITHUB_TOKEN, repoMatch[1], repoMatch[2]);
  }

  try {
    await dns.deleteARecord({ host: secrets.DA_HOST, username: secrets.DA_USERNAME, loginKey: secrets.DA_LOGIN_KEY }, ROOT_DOMAIN, client.name, client.ip);
    console.log('Removed the DNS A record.');
  } catch (err) {
    console.log(`NOTE: DNS A record removal failed (${err.message}) — delete "${client.name}" manually at da17.host-ww.net:2222 > DNS Management if it's still there.`);
  }

  removeClient(registry, client.name);
  saveRegistry(registry);
  console.log(`Removed "${client.name}" from the registry.`);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
