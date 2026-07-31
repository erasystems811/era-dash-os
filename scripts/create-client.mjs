#!/usr/bin/env node
// Usage:
//   node create-client.mjs --name="Client Name" [--subdomain=custom-slug] [--whatsapp] [--payment=flutterwave|paystack] [--pdf]
//
// Creates a new client app end to end: DigitalOcean droplet, GitHub repo,
// DNS record, the standard docker-compose stack deployed and running.
// WhatsApp/payment env slots are left blank even when toggled on — actually
// filling them in (and the manual Meta/provider verification that requires)
// is `add-whatsapp.mjs` / `add-payment.mjs`, runnable any time later.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

import { loadSecrets, requireSecrets } from './lib/secrets.mjs';
import { loadRegistry, saveRegistry, upsertClient, findClient } from './lib/registry.mjs';
import { randomSecret, randomPassword, randomEncryptionKey, slugify } from './lib/random.mjs';
import { render } from './lib/render-template.mjs';
import * as digitalocean from './lib/digitalocean.mjs';
import * as github from './lib/github.mjs';
import * as dns from './lib/dns.mjs';
import { waitForSsh, waitForCloudInit, runRemote, copyToRemote } from './lib/ssh.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const ROOT_DOMAIN = process.env.ERA_ROOT_DOMAIN || 'erasystems.com.ng';

function parseArgs(argv) {
  const args = { whatsapp: false, payment: null, pdf: false, skipGithub: false };
  for (const arg of argv) {
    if (arg === '--whatsapp') args.whatsapp = true;
    else if (arg === '--pdf') args.pdf = true;
    else if (arg === '--skip-github') args.skipGithub = true;
    else if (arg.startsWith('--payment=')) args.payment = arg.split('=')[1];
    else if (arg.startsWith('--name=')) args.name = arg.slice('--name='.length);
    else if (arg.startsWith('--subdomain=')) args.subdomain = arg.slice('--subdomain='.length);
  }
  if (!args.name) throw new Error('Usage: create-client.mjs --name="Client Name" [--subdomain=slug] [--whatsapp] [--payment=flutterwave|paystack] [--pdf]');
  args.slug = slugify(args.subdomain || args.name);
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const subdomain = `${args.slug}.${ROOT_DOMAIN}`;
  const dropletName = `era-${args.slug}`;

  console.log(`Setting up "${args.name}" -> https://${subdomain}`);

  const secrets = loadSecrets();
  const requiredSecrets = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DIGITALOCEAN_TOKEN', 'DA_USERNAME', 'DA_LOGIN_KEY', 'DA_HOST'];
  if (!args.skipGithub) requiredSecrets.push('GITHUB_TOKEN');
  requireSecrets(secrets, requiredSecrets);

  const registry = loadRegistry();
  if (findClient(registry, args.slug)) {
    throw new Error(`A client named "${args.slug}" already exists in the registry. Pick a different --subdomain, or use add-whatsapp.mjs/add-payment.mjs to modify it.`);
  }

  const vars = {
    APP_SLUG: args.slug,
    SUBDOMAIN: subdomain,
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
    WHATSAPP_N8N_ENV: whatsappEnvBlock(args.whatsapp),
    PAYMENT_N8N_ENV: paymentEnvBlock(args.payment),
    GOTENBERG_SERVICE: gotenbergBlock(args.pdf),
  };

  const dockerComposeReal = render(readFileSync(path.join(TEMPLATES_DIR, 'docker-compose.yml.template'), 'utf8'), vars);
  const caddyfile = render(readFileSync(path.join(TEMPLATES_DIR, 'Caddyfile.template'), 'utf8'), vars);
  const envReal = render(readFileSync(path.join(TEMPLATES_DIR, '.env.template'), 'utf8'), vars);
  const schema = readFileSync(path.join(TEMPLATES_DIR, 'schema.sql'), 'utf8');

  // 1. GitHub repo (code only — no real secrets ever get committed)
  let repo = null;
  if (!args.skipGithub) {
    console.log('Creating GitHub repo...');
    const owner = await github.getAuthenticatedUser(secrets.GITHUB_TOKEN);
    repo = await github.createRepo(secrets.GITHUB_TOKEN, `era-${args.slug}`);
    await github.putFile(secrets.GITHUB_TOKEN, repo.owner, repo.repo, 'docker-compose.yml', dockerComposeReal, 'Initial setup');
    await github.putFile(secrets.GITHUB_TOKEN, repo.owner, repo.repo, 'Caddyfile', caddyfile, 'Initial setup');
    await github.putFile(secrets.GITHUB_TOKEN, repo.owner, repo.repo, 'schema.sql', schema, 'Initial setup');
    const envExample = envReal.replace(/=(.+)$/gm, (m, v) => (v.trim() ? '=<set on server, not in git>' : '='));
    await github.putFile(secrets.GITHUB_TOKEN, repo.owner, repo.repo, '.env.example', envExample, 'Initial setup');
    for (const file of ['package.json', 'Dockerfile', 'server.js']) {
      const content = readFileSync(path.join(TEMPLATES_DIR, 'dashboard', file), 'utf8');
      await github.putFile(secrets.GITHUB_TOKEN, repo.owner, repo.repo, `dashboard/${file}`, content, 'Initial setup');
    }
    console.log(`  Repo: ${repo.htmlUrl}`);
  } else {
    console.log('Skipping GitHub repo creation (--skip-github).');
  }

  // 2. Droplet
  console.log('Creating DigitalOcean droplet (this takes a few minutes)...');
  const dropletId = await digitalocean.createDroplet(secrets.DIGITALOCEAN_TOKEN, { name: dropletName });
  const ip = await digitalocean.waitForDropletActive(secrets.DIGITALOCEAN_TOKEN, dropletId);
  console.log(`  Droplet IP: ${ip}, waiting for it to finish booting + installing Docker...`);
  await waitForSsh(ip);
  await waitForCloudInit(ip);

  // 3. Deploy real files (with real secrets) directly to the server, never to git
  console.log('Deploying app to the server...');
  const remoteDir = `/opt/${args.slug}`;
  await runRemote(ip, `mkdir -p ${remoteDir}/dashboard`);
  const tmpDir = path.join(os.tmpdir(), `era-${args.slug}`);
  writeLocalTemp(tmpDir, {
    'docker-compose.yml': dockerComposeReal,
    Caddyfile: caddyfile,
    '.env': envReal,
    'schema.sql': schema,
  });
  await copyToRemote(ip, `${tmpDir}/docker-compose.yml`, `${remoteDir}/docker-compose.yml`);
  await copyToRemote(ip, `${tmpDir}/Caddyfile`, `${remoteDir}/Caddyfile`);
  await copyToRemote(ip, `${tmpDir}/.env`, `${remoteDir}/.env`);
  await copyToRemote(ip, `${tmpDir}/schema.sql`, `${remoteDir}/schema.sql`);
  await copyToRemote(ip, path.join(TEMPLATES_DIR, 'dashboard'), `${remoteDir}/`, { recursive: true });
  await runRemote(ip, `chmod 600 ${remoteDir}/.env`);

  console.log('Starting the app (docker compose up)...');
  await runRemote(ip, `cd ${remoteDir} && docker compose up -d --build`);

  console.log('Applying starting database schema...');
  await runRemote(
    ip,
    `sleep 8 && docker exec ${args.slug}-postgres-1 psql -U app -d ${args.slug} -f - < ${remoteDir}/schema.sql || cat ${remoteDir}/schema.sql | docker exec -i ${args.slug}-postgres-1 psql -U app -d ${args.slug}`
  );

  // 4. DNS
  console.log('Adding DNS record...');
  let dnsOk = true;
  try {
    await dns.addARecord({ host: secrets.DA_HOST, username: secrets.DA_USERNAME, loginKey: secrets.DA_LOGIN_KEY }, ROOT_DOMAIN, args.slug, ip);
  } catch (err) {
    dnsOk = false;
    console.log(`  ${dns.manualInstructions(ROOT_DOMAIN, args.slug, ip)}`);
    console.log(`  (Automatic DNS error, for debugging: ${err.message})`);
  }

  // 5. Registry
  upsertClient(registry, {
    name: args.slug,
    displayName: args.name,
    subdomain,
    dropletId,
    ip,
    repo: repo ? repo.htmlUrl : null,
    needsWhatsapp: args.whatsapp,
    needsPayment: Boolean(args.payment),
    paymentProvider: args.payment,
    hasPdf: args.pdf,
    createdAt: new Date().toISOString(),
  });
  saveRegistry(registry);

  console.log('\nDone.');
  console.log(`  App:      https://${subdomain} ${dnsOk ? '(DNS added automatically)' : '(DNS needs the manual step above)'}`);
  console.log(`  Repo:     ${repo ? repo.htmlUrl : '(skipped, --skip-github)'}`);
  console.log(`  Server:   ${ip}`);
  console.log(`  Dashboard login: admin / ${vars.DASHBOARD_PASSWORD}`);
  console.log(`  WhatsApp: ${args.whatsapp ? 'slot ready, run add-whatsapp.mjs with real Meta credentials' : 'not requested'}`);
  console.log(`  Payment:  ${args.payment ? `slot ready (${args.payment}), run add-payment.mjs with real keys` : 'not requested'}`);
}

function writeLocalTemp(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content);
  }
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
