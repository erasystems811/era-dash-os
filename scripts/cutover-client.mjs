// The deliberate second half of migrate-client.mjs: flips real traffic
// (DNS) and the registry's idea of where a client lives, over to a
// destination migrate-client.mjs already stood up and that a human has
// since verified actually works. Never run this against a migration that
// hasn't been checked -- there is no automatic verification here on
// purpose, since "does the real app actually work" isn't something safe to
// infer from inside a script.
//
// The old server is left running, untouched -- decommissioning it is a
// separate, later, deliberate step (a rollback window), not part of this.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadSecrets, requireSecrets } from './lib/secrets.mjs';
import { loadRegistry, saveRegistry, findClient, upsertClient } from './lib/registry.mjs';
import * as dns from './lib/dns.mjs';

const ROOT_DOMAIN = process.env.ERA_ROOT_DOMAIN || 'erasystems.com.ng';
const PENDING_PATH = process.env.ERA_PENDING_MIGRATIONS_PATH || '/opt/era-control/migrations-pending.json';

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (arg.startsWith('--client=')) args.client = arg.slice('--client='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.client) throw new Error('--client=<slug> is required.');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = loadRegistry();
  const client = findClient(registry, args.client);
  if (!client) throw new Error(`No client "${args.client}" in the registry.`);

  if (!existsSync(PENDING_PATH)) throw new Error(`No pending migration recorded at ${PENDING_PATH} -- run migrate-client.mjs first.`);
  const pending = JSON.parse(readFileSync(PENDING_PATH, 'utf8'));
  const move = pending[args.client];
  if (!move) throw new Error(`No pending migration for "${args.client}" -- run migrate-client.mjs first.`);

  const oldIp = client.ip;
  console.log(`Cutting over ${args.client}: ${oldIp} -> ${move.ip}`);

  if (client.isCustomDomain) {
    console.log(dns.customDomainInstructions(client.subdomain, move.ip));
  } else {
    const secrets = loadSecrets();
    requireSecrets(secrets, ['DA_USERNAME', 'DA_LOGIN_KEY', 'DA_HOST']);
    const daConfig = { host: secrets.DA_HOST, username: secrets.DA_USERNAME, loginKey: secrets.DA_LOGIN_KEY };
    console.log(`Updating DNS: removing ${args.client} -> ${oldIp}, adding ${args.client} -> ${move.ip}...`);
    try {
      await dns.deleteARecord(daConfig, ROOT_DOMAIN, args.client, oldIp);
    } catch (err) {
      console.log(`  NOTE: couldn't remove the old A record (${err.message}) -- may need manual cleanup, continuing to add the new one.`);
    }
    await dns.addARecord(daConfig, ROOT_DOMAIN, args.client, move.ip);
    console.log('  DNS updated. Propagation/TTL means some visitors may still briefly hit the old server.');
  }

  upsertClient(registry, {
    name: args.client,
    ip: move.ip,
    hostedOn: move.ip,
    provider: move.provider,
    serverId: move.serverId,
    sharedPorts: move.sharedPorts,
  });
  saveRegistry(registry);

  delete pending[args.client];
  writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2) + '\n');

  console.log('');
  console.log(`DONE. ${args.client} now points at ${move.ip} in DNS and the registry.`);
  console.log(`${oldIp} is still running, untouched -- keep it as a rollback for a few days, then tear down just that one client's old stack there once you're confident.`);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
