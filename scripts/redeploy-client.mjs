#!/usr/bin/env node
// Usage: node redeploy-client.mjs --client=slug [--rebuild-os]
//
// Re-deploys the standard app stack to an EXISTING client's server, using
// exactly the same templates/steps create-client.mjs uses at first setup.
// Does not touch the client's Hetzner server record, GitHub repo, or DNS —
// only what's running on the server. Generates fresh secrets every run
// (new DB password, dashboard password, etc.) since the old ones live only
// on the server's disk and can't be recovered once wiped.
//
// --rebuild-os first reinstalls the server's OS from scratch (same IP) via
// the Hetzner API before redeploying — use this when the server itself is
// in a broken state (e.g. SSH key never got attached correctly at
// creation), not for a routine app update.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

import { loadSecrets, requireSecrets } from './lib/secrets.mjs';
import { loadRegistry, saveRegistry, upsertClient, findClient } from './lib/registry.mjs';
import { randomSecret, randomPassword, randomEncryptionKey } from './lib/random.mjs';
import { render } from './lib/render-template.mjs';
import * as hetzner from './lib/hetzner.mjs';
import { waitForSsh, waitForCloudInit, runRemote, copyToRemote } from './lib/ssh.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

function parseArgs(argv) {
  const args = { rebuildOs: false };
  for (const arg of argv) {
    if (arg === '--rebuild-os') args.rebuildOs = true;
    else if (arg.startsWith('--client=')) args.client = arg.slice('--client='.length);
  }
  if (!args.client) throw new Error('Usage: redeploy-client.mjs --client=slug [--rebuild-os]');
  return args;
}

function whatsappEnvBlock(enabled) {
  if (!enabled) return '';
  return [
    '      - META_ACCESS_TOKEN=${META_ACCESS_TOKEN}',
    '      - META_PHONE_NUMBER_ID=${META_PHONE_NUMBER_ID}',
    '      - META_WEBHOOK_VERIFY_TOKEN=${META_WEBHOOK_VERIFY_TOKEN}',
  ].join('\n');
}

function paymentEnvBlock(provider) {
  if (!provider) return '';
  return [
    '      - PAYMENT_PROVIDER=${PAYMENT_PROVIDER}',
    '      - PAYMENT_SECRET_KEY=${PAYMENT_SECRET_KEY}',
    '      - PAYMENT_PUBLIC_KEY=${PAYMENT_PUBLIC_KEY}',
  ].join('\n');
}

function gotenbergBlock(enabled) {
  if (!enabled) return '';
  return `  gotenberg:
    image: gotenberg/gotenberg:8
    restart: unless-stopped
    mem_limit: 300m
    command:
      - "gotenberg"
      - "--chromium-disable-routes=false"
      - "--libreoffice-disable-routes=true"
      - "--chromium-max-queue-size=1"
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

`;
}

function writeLocalTemp(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = loadRegistry();
  const client = findClient(registry, args.client);
  if (!client) throw new Error(`No client "${args.client}" in the registry.`);
  if (client.customDeploy) throw new Error(`${args.client} runs a custom app deploy, not the standard template -- this script would overwrite it. See the client's own repo/deploy setup instead.`);
  // This script isn't shared-server aware (it always renders the dedicated
  // docker-compose.yml.template/Caddyfile.template, which would give a
  // shared-mode client its own Caddy fighting the server's shared one for
  // port 80/443) and --rebuild-os wipes the whole server via the Hetzner
  // API -- on a shared server that takes every OTHER client on it down
  // too, not just this one. Refuse outright rather than silently doing
  // either. See push-update.mjs for the safe way to push a code update to
  // a live client instead.
  if (client.serverMode === 'shared') {
    throw new Error(`${args.client} is on a shared server (${client.ip}) -- redeploy-client.mjs doesn't support shared-mode clients yet (it would either fight the shared Caddy for its own client, or with --rebuild-os wipe every other client on that server). Use push-update.mjs for a code-only update instead.`);
  }

  const secrets = loadSecrets();
  requireSecrets(secrets, ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'HETZNER_TOKEN']);

  let ip = client.ip;

  if (args.rebuildOs) {
    console.log(`Rebuilding OS on server ${client.serverId} (same IP ${ip})...`);
    await hetzner.rebuildServer(secrets.HETZNER_TOKEN, client.serverId);
    console.log('Waiting for it to come back up...');
    await waitForSsh(ip);
    await waitForCloudInit(ip);
  }

  const vars = {
    APP_SLUG: client.name,
    SUBDOMAIN: client.subdomain,
    OPENAI_API_KEY: secrets.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: secrets.ANTHROPIC_API_KEY,
    POSTGRES_PASSWORD: randomPassword(),
    AUTHENTICATOR_PASSWORD: randomPassword(),
    PGRST_JWT_SECRET: randomSecret(32),
    SUPABASE_SERVICE_KEY: randomSecret(32),
    N8N_BASIC_AUTH_PASSWORD: randomPassword(),
    N8N_ENCRYPTION_KEY: randomEncryptionKey(),
    DASHBOARD_SESSION_SECRET: randomSecret(32),
    DASHBOARD_PASSWORD: randomPassword(12),
    WHATSAPP_N8N_ENV: whatsappEnvBlock(client.needsWhatsapp),
    PAYMENT_N8N_ENV: paymentEnvBlock(client.paymentProvider),
    GOTENBERG_SERVICE: gotenbergBlock(client.hasPdf),
  };

  const dockerComposeReal = render(readFileSync(path.join(TEMPLATES_DIR, 'docker-compose.yml.template'), 'utf8'), vars);
  const caddyfile = render(readFileSync(path.join(TEMPLATES_DIR, 'Caddyfile.template'), 'utf8'), vars);
  const envReal = render(readFileSync(path.join(TEMPLATES_DIR, '.env.template'), 'utf8'), vars);
  const schema = readFileSync(path.join(TEMPLATES_DIR, 'schema.sql'), 'utf8');

  console.log('Deploying app to the server...');
  const remoteDir = `/opt/${client.name}`;
  await runRemote(ip, `mkdir -p ${remoteDir}/dashboard`);
  const tmpDir = path.join(os.tmpdir(), `era-redeploy-${client.name}`);
  const initSql = [
    `CREATE ROLE authenticator WITH LOGIN PASSWORD '${vars.AUTHENTICATOR_PASSWORD.replace(/'/g, "''")}' NOINHERIT;`,
    `GRANT USAGE ON SCHEMA public TO authenticator;`,
    schema,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticator;`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticator;`,
  ].join('\n');
  writeLocalTemp(tmpDir, {
    'docker-compose.yml': dockerComposeReal,
    Caddyfile: caddyfile,
    '.env': envReal,
    'init.sql': initSql,
  });
  await copyToRemote(ip, `${tmpDir}/docker-compose.yml`, `${remoteDir}/docker-compose.yml`);
  await copyToRemote(ip, `${tmpDir}/Caddyfile`, `${remoteDir}/Caddyfile`);
  await copyToRemote(ip, `${tmpDir}/.env`, `${remoteDir}/.env`);
  await copyToRemote(ip, `${tmpDir}/init.sql`, `${remoteDir}/init.sql`);
  await copyToRemote(ip, path.join(TEMPLATES_DIR, 'dashboard'), `${remoteDir}/`, { recursive: true });
  await runRemote(ip, `chmod 600 ${remoteDir}/.env`);

  console.log('Starting the app (docker compose up)...');
  await runRemote(ip, `cd ${remoteDir} && docker compose up -d --build`);

  console.log('Waiting for the database to be ready...');
  await runRemote(
    ip,
    `for i in $(seq 1 30); do docker exec ${client.name}-postgres-1 pg_isready -U app > /dev/null 2>&1 && break; sleep 2; done`
  );

  console.log('Applying starting database schema...');
  await runRemote(ip, `docker exec -i ${client.name}-postgres-1 psql -U app -d ${client.name} -v ON_ERROR_STOP=1 < ${remoteDir}/init.sql`);
  await runRemote(ip, `cd ${remoteDir} && docker compose restart postgrest`);

  upsertClient(registry, { name: client.name, redeployedAt: new Date().toISOString() });
  saveRegistry(registry);

  console.log('\nDone.');
  console.log(`  App:      https://${client.subdomain}`);
  console.log(`  Dashboard login: admin / ${vars.DASHBOARD_PASSWORD}`);
  console.log(`  (Old dashboard password, if any, no longer works -- secrets are regenerated on every redeploy.)`);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
