// Moves an existing shared-mode EBOS client to a different (usually new)
// shared server, preserving its REAL data and secrets exactly -- unlike
// create-client.mjs's --shared-server=ip join path, which always generates
// fresh secrets and an empty database for a brand new client. This script
// is for a live client that already has real customers/orders/WhatsApp
// connections and must not lose or regenerate any of that.
//
// Deliberately split from cutover-client.mjs: this script only stands the
// client up on the destination server (a real, byte-for-byte copy of its
// database and its exact .env), and never touches DNS or the registry's
// idea of where the client "lives". That happens only in cutover-client.mjs,
// after a human has verified the new deployment actually works -- a bad
// migration should never be able to take the live site down.
//
// Chidera, 2026-09-20: moving "pomodoro" and "dee" off Hetzner onto free
// Oracle capacity, sharing one box like they already do today ("let them
// share in that my free space o, dont open any paid server space for
// them").
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { loadSecrets } from './lib/secrets.mjs';
import { loadRegistry, saveRegistry, findClient, findServer, upsertServer } from './lib/registry.mjs';
import { provisionExistingServer } from './lib/manual-server.mjs';
import { runRemote, copyToRemote, readRemote } from './lib/ssh.mjs';
import { bootstrapSharedHost, allocatePorts, renderSiteBlock, addSite } from './lib/shared-host.mjs';
import { backupClient } from './lib/backup.mjs';
import { templatesDirFor } from './lib/templates-dir.mjs';

// Small side-channel between this script and cutover-client.mjs -- holds
// the new server's ip/provider/serverId/ports for a client that has been
// migrated but not yet cut over, so cutover-client.mjs never has to
// re-derive that (fragile) from a running docker-compose.yml on the
// destination. Cleared once cutover actually runs.
const PENDING_PATH = process.env.ERA_PENDING_MIGRATIONS_PATH || '/opt/era-control/migrations-pending.json';

function loadPending() {
  if (!existsSync(PENDING_PATH)) return {};
  return JSON.parse(readFileSync(PENDING_PATH, 'utf8'));
}

function savePending(pending) {
  writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2) + '\n');
}

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (arg.startsWith('--client=')) args.client = arg.slice('--client='.length);
    else if (arg.startsWith('--ip=')) args.ip = arg.slice('--ip='.length);
    else if (arg.startsWith('--shared-server=')) args.sharedServer = arg.slice('--shared-server='.length);
    else if (arg === '--new-shared-server') args.newSharedServer = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.client) throw new Error('--client=<slug> is required.');
  if (!args.sharedServer && !args.newSharedServer) {
    throw new Error('Pass either --shared-server=ip (an existing shared server this client should join) or --new-shared-server --ip=<already-created-server-ip>.');
  }
  if (args.sharedServer && args.newSharedServer) {
    throw new Error('Pass either --shared-server=ip or --new-shared-server, not both.');
  }
  if (args.newSharedServer && !args.ip) {
    throw new Error('--new-shared-server needs --ip= -- create the server by hand first, then pass its address here. See scripts/lib/manual-server.mjs.');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = loadRegistry();
  const client = findClient(registry, args.client);
  if (!client) throw new Error(`No client "${args.client}" in the registry.`);
  if (client.serverMode !== 'shared') {
    throw new Error(`"${args.client}" isn't a shared-mode client (serverMode=${client.serverMode}) -- this script only knows how to move shared-mode EBOS clients so far.`);
  }
  if (!client.isEbos) throw new Error(`"${args.client}" isn't an EBOS client -- this script only supports ebos-templates' shared compose/Caddy layout.`);

  const secrets = loadSecrets();

  const sourceIp = client.ip;
  const slug = client.name;
  const TEMPLATES_DIR = templatesDirFor('ebos');

  // 1. Fresh backup, taken right now -- not whatever the last nightly cron
  // happened to catch. Also doubles as this run's proof the source database
  // is actually reachable and healthy before anything else happens.
  console.log(`Backing up ${slug}'s live database on ${sourceIp}...`);
  const backupDir = path.join(os.tmpdir(), 'era-migrate-backups');
  const { localFile: dumpFile, sizeBytes } = await backupClient(client, { destDir: backupDir });
  console.log(`  Backup: ${dumpFile} (${sizeBytes} bytes)`);

  // 2. Pull the real, already-deployed .env and docker-compose.yml -- these
  // hold live secrets (WhatsApp tokens, payment keys, session secrets) that
  // must survive the move byte-for-byte, never regenerated.
  console.log(`Reading ${slug}'s real .env and docker-compose.yml from ${sourceIp}...`);
  const envReal = await readRemote(sourceIp, `/opt/${slug}/.env`);
  let composeReal = await readRemote(sourceIp, `/opt/${slug}/docker-compose.yml`);

  // 3. Destination server. Chidera, 2026-09-23: every automated
  // cloud-provider integration is gone -- --new-shared-server's box has to
  // already exist (--ip=, created by hand), this just makes Docker exist
  // on it and sets up the shared Caddy.
  let destIp;
  if (args.newSharedServer) {
    destIp = args.ip;
    console.log(`Setting up ${destIp} for this migration (installing Docker if it isn't already there)...`);
    await provisionExistingServer(destIp);
    console.log('  Setting up the shared Caddy...');
    await bootstrapSharedHost(destIp);
    upsertServer(registry, { ip: destIp, mode: 'shared', createdAt: new Date().toISOString() });
    saveRegistry(registry);
  } else {
    const server = findServer(registry, args.sharedServer);
    if (!server || server.mode !== 'shared') {
      throw new Error(`"${args.sharedServer}" isn't a registered shared server.`);
    }
    destIp = args.sharedServer;
  }

  if (destIp === sourceIp) throw new Error('Destination is the same as the source server -- nothing to migrate.');

  // 4. Ports on the destination -- may differ from the source's if this
  // isn't the first tenant there. Patch the three published-port lines in
  // the compose file we pulled (the only place ports are baked in -- .env
  // never holds them, confirmed against a real pulled file). Container port
  // numbers (3000, 5678) are untouched; only the unique host-side port
  // before them.
  const destPorts = allocatePorts(registry, destIp);
  const oldPorts = client.sharedPorts || {};
  console.log(`Allocating ports on ${destIp}: dashboard=${destPorts.dashboard} postgrest=${destPorts.postgrest} n8n=${destPorts.n8n}`);
  for (const key of ['dashboard', 'postgrest', 'n8n']) {
    if (typeof oldPorts[key] === 'number' && oldPorts[key] !== destPorts[key]) {
      composeReal = composeReal.split(`:${oldPorts[key]}:`).join(`:${destPorts[key]}:`);
    }
  }

  // 5. Deploy real files + fresh app code (same as create-client.mjs: code
  // always comes from the current template, only data/secrets are unique
  // per client) to the destination.
  console.log(`Deploying ${slug} to ${destIp}...`);
  const remoteDir = `/opt/${slug}`;
  await runRemote(destIp, `mkdir -p ${remoteDir}/dashboard`);
  const tmpDir = path.join(os.tmpdir(), `era-migrate-${slug}`);
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(path.join(tmpDir, 'docker-compose.yml'), composeReal);
  writeFileSync(path.join(tmpDir, '.env'), envReal);
  await copyToRemote(destIp, path.join(tmpDir, 'docker-compose.yml'), `${remoteDir}/docker-compose.yml`);
  await copyToRemote(destIp, path.join(tmpDir, '.env'), `${remoteDir}/.env`);
  await copyToRemote(destIp, path.join(TEMPLATES_DIR, 'dashboard'), `${remoteDir}/`, { recursive: true });
  await runRemote(destIp, `chmod 600 ${remoteDir}/.env`);

  console.log('Starting the app (docker compose up)...');
  await runRemote(destIp, `cd ${remoteDir} && docker compose up -d --build`);

  console.log('Waiting for the database to be ready...');
  await runRemote(
    destIp,
    `for i in $(seq 1 30); do docker exec ${slug}-postgres-1 pg_isready -U app > /dev/null 2>&1 && break; sleep 2; done`
  );

  // 6. Restore the real data. A plain `pg_dump -U app <db>` (what
  // backupClient takes) contains no role/grant statements, so the
  // authenticator role PostgREST connects as (see docker-compose.shared.yml
  // .template's PGRST_DB_URI) has to be recreated by hand around it, same
  // as create-client.mjs's own init.sql assembly -- just with the real dump
  // in place of schema.sql+seed, and the SAME AUTHENTICATOR_PASSWORD already
  // present in the preserved .env, so PostgREST's connection string still
  // matches on the very first boot.
  const authPasswordMatch = envReal.match(/^AUTHENTICATOR_PASSWORD=(.*)$/m);
  if (!authPasswordMatch) throw new Error('Could not find AUTHENTICATOR_PASSWORD in the pulled .env -- refusing to guess.');
  const authPassword = authPasswordMatch[1].trim();
  const preambleSql = [
    `CREATE ROLE authenticator WITH LOGIN PASSWORD '${authPassword.replace(/'/g, "''")}' NOINHERIT;`,
    `GRANT USAGE ON SCHEMA public TO authenticator;`,
  ].join('\n');
  const postambleSql = [
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticator;`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticator;`,
  ].join('\n');
  writeFileSync(path.join(tmpDir, 'preamble.sql'), preambleSql);
  writeFileSync(path.join(tmpDir, 'postamble.sql'), postambleSql);
  await copyToRemote(destIp, path.join(tmpDir, 'preamble.sql'), `${remoteDir}/preamble.sql`);
  await copyToRemote(destIp, path.join(tmpDir, 'postamble.sql'), `${remoteDir}/postamble.sql`);
  await copyToRemote(destIp, dumpFile, `${remoteDir}/restore.sql.gz`);

  console.log('Restoring the real database (this is the live data, not a fresh schema)...');
  await runRemote(
    destIp,
    `docker exec -i ${slug}-postgres-1 psql -U app -d ${slug} -v ON_ERROR_STOP=1 < ${remoteDir}/preamble.sql && ` +
      `zcat ${remoteDir}/restore.sql.gz | docker exec -i ${slug}-postgres-1 psql -U app -d ${slug} -v ON_ERROR_STOP=1 && ` +
      `docker exec -i ${slug}-postgres-1 psql -U app -d ${slug} -v ON_ERROR_STOP=1 < ${remoteDir}/postamble.sql`
  );
  await runRemote(destIp, `rm -f ${remoteDir}/restore.sql.gz`);
  await runRemote(destIp, `cd ${remoteDir} && docker compose restart postgrest`);

  // 7. Wire this client into the destination's shared Caddy. Its
  // certificate can't actually issue until DNS points here (see
  // cutover-client.mjs), so this makes the site block ready, not yet live.
  console.log("Adding this client to the destination's shared Caddy...");
  const siteBlock = renderSiteBlock(path.join(TEMPLATES_DIR, 'Caddyfile.shared-site.template'), {
    SUBDOMAIN: client.subdomain,
    DASHBOARD_PORT: String(destPorts.dashboard),
    POSTGREST_PORT: String(destPorts.postgrest),
    N8N_PORT: String(destPorts.n8n),
  });
  await addSite(destIp, slug, siteBlock);

  const pending = loadPending();
  pending[slug] = { ip: destIp, sharedPorts: destPorts, migratedAt: new Date().toISOString() };
  savePending(pending);

  console.log('');
  console.log(`DONE. ${slug} is now running on ${destIp} (dashboard port ${destPorts.dashboard}) with its real data restored.`);
  console.log(`Verify it directly (bypassing DNS/TLS) with: curl -s http://${destIp}:${destPorts.dashboard}/ -o /dev/null -w '%{http_code}\\n'`);
  console.log(`The old server (${sourceIp}) is untouched and still serving live traffic. Nothing has changed for real customers yet.`);
  console.log(`Once verified, run cutover-client.mjs --client=${slug} to flip DNS + the registry.`);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
