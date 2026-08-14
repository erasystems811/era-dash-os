#!/usr/bin/env node
// Usage:
//   node create-client.mjs --name="Client Name" [--subdomain=custom-slug] [--whatsapp] [--payment=flutterwave|paystack] [--pdf]
//   node create-client.mjs --name="Client Name" --custom-domain=goldshop.com [--whatsapp] ...
//
// Creates a new client app end to end: Hetzner server, GitHub repo,
// DNS record, the standard docker-compose stack deployed and running.
// WhatsApp/payment env slots are left blank even when toggled on — actually
// filling them in (and the manual Meta/provider verification that requires)
// is `add-whatsapp.mjs` / `add-payment.mjs`, runnable any time later.
//
// --custom-domain is for a business that owns its own domain instead of
// using a *.erasystems.com.ng subdomain. DNS for that domain lives on
// whatever registrar/host THEY use, not the DirectAdmin account this script
// automates — so DNS setup is always a manual step for a custom domain
// (the script prints exactly what record to give them), never automatic.
// Everything else (server, repo, app stack, TLS) works identically either
// way, since Caddy issues TLS for whatever hostname it's given.
//
// --template=<name> selects which template set gets stamped onto the server
// (default: 'default', the generic single-client starter in templates/).
// EBOS (the shared multi-tenant ordering/booking platform) is provisioned
// the same way any other client is, just with --template=ebos, which reads
// from ebos-templates/ instead -- its own schema.sql and dashboard/, same
// pipeline otherwise. EBOS is provisioned once; individual businesses are
// onboarded afterward as rows inside it (see ebos-templates/dashboard's
// admin API), never as separate create-client.mjs runs.

import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

import { loadSecrets, requireSecrets } from './lib/secrets.mjs';
import { loadRegistry, saveRegistry, upsertClient, findClient } from './lib/registry.mjs';
import { randomSecret, randomPassword, randomEncryptionKey, slugify } from './lib/random.mjs';
import { render } from './lib/render-template.mjs';
import * as hetzner from './lib/hetzner.mjs';
import * as github from './lib/github.mjs';
import * as dns from './lib/dns.mjs';
import { waitForSsh, waitForCloudInit, runRemote, copyToRemote } from './lib/ssh.mjs';
import { runScaffoldBot } from './lib/scaffold-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DOMAIN = process.env.ERA_ROOT_DOMAIN || 'erasystems.com.ng';

// 'default' is the generic single-client starter (templates/). Any other
// name (e.g. 'ebos') reads from a sibling '<name>-templates/' folder instead
// -- same pipeline, different schema.sql/dashboard baked onto the server.
// Every existing call site (no --template passed) resolves to 'default' and
// behaves exactly as before.
function templatesDirFor(template) {
  const folder = template === 'default' ? 'templates' : `${template}-templates`;
  return path.join(__dirname, '..', folder);
}

function parseArgs(argv) {
  const args = { whatsapp: false, payment: null, pdf: false, skipGithub: false, size: 'small', template: 'default' };
  for (const arg of argv) {
    if (arg === '--whatsapp') args.whatsapp = true;
    else if (arg === '--pdf') args.pdf = true;
    else if (arg === '--skip-github') args.skipGithub = true;
    else if (arg.startsWith('--payment=')) args.payment = arg.split('=')[1];
    else if (arg.startsWith('--name=')) args.name = arg.slice('--name='.length);
    else if (arg.startsWith('--subdomain=')) args.subdomain = arg.slice('--subdomain='.length);
    else if (arg.startsWith('--custom-domain=')) args.customDomain = arg.slice('--custom-domain='.length).toLowerCase();
    else if (arg.startsWith('--size=')) args.size = arg.slice('--size='.length);
    else if (arg.startsWith('--template=')) args.template = arg.slice('--template='.length);
  }
  if (!args.name) throw new Error('Usage: create-client.mjs --name="Client Name" [--subdomain=slug | --custom-domain=example.com] [--whatsapp] [--payment=flutterwave|paystack] [--pdf] [--size=small|medium|large] [--template=default|ebos]');
  if (args.subdomain && args.customDomain) throw new Error('Pass either --subdomain or --custom-domain, not both.');
  // slug is only for internal naming (droplet, remote dir, db role) — for a
  // custom domain it's derived from the domain itself, since there's no
  // separate subdomain piece to slugify.
  args.slug = slugify(args.subdomain || args.customDomain || args.name);
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
  const TEMPLATES_DIR = templatesDirFor(args.template);
  const subdomain = args.customDomain || `${args.slug}.${ROOT_DOMAIN}`;
  const dropletName = `era-${args.slug}`;

  console.log(`Setting up "${args.name}" -> https://${subdomain}`);

  const secrets = loadSecrets();
  const requiredSecrets = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'HETZNER_TOKEN'];
  // DirectAdmin secrets only matter for the erasystems.com.ng subdomain
  // path — a custom domain never touches that account.
  if (!args.customDomain) requiredSecrets.push('DA_USERNAME', 'DA_LOGIN_KEY', 'DA_HOST');
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
    // Only referenced by ebos-templates/.env.template and its
    // docker-compose.yml.template -- harmless (ignored) for every other
    // template, so generated unconditionally rather than branching on
    // args.template here.
    EBOS_ADMIN_TOKEN: randomSecret(32),
    PAYMENT_ENCRYPTION_KEY: randomSecret(32),
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
    // Recursive, not a fixed file list -- the generic dashboard is one file,
    // but ebos-templates/dashboard has lib/ and routes/ subfolders too.
    for (const relPath of listFilesRecursive(path.join(TEMPLATES_DIR, 'dashboard'))) {
      const content = readFileSync(path.join(TEMPLATES_DIR, 'dashboard', relPath), 'utf8');
      await github.putFile(secrets.GITHUB_TOKEN, repo.owner, repo.repo, `dashboard/${relPath.split(path.sep).join('/')}`, content, 'Initial setup');
    }
    console.log(`  Repo: ${repo.htmlUrl}`);
  } else {
    console.log('Skipping GitHub repo creation (--skip-github).');
  }

  // 2. Server
  console.log(`Creating Hetzner server (this takes a few minutes)...`);
  const serverId = await hetzner.createServer(secrets.HETZNER_TOKEN, { name: dropletName, size: args.size });
  const ip = await hetzner.waitForServerActive(secrets.HETZNER_TOKEN, serverId);
  console.log(`  Server IP: ${ip}, waiting for it to finish booting + installing Docker...`);
  await waitForSsh(ip);
  await waitForCloudInit(ip);

  // 3. Deploy real files (with real secrets) directly to the server, never to git
  console.log('Deploying app to the server...');
  const remoteDir = `/opt/${args.slug}`;
  await runRemote(ip, `mkdir -p ${remoteDir}/dashboard`);
  const tmpDir = path.join(os.tmpdir(), `era-${args.slug}`);
  // PostgREST connects as its own "authenticator" role (not "app"), so that
  // role must be created with the real generated password, and given access
  // to whatever schema.sql creates — none of that can live in the static
  // schema.sql template since the password is per-client.
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
    `for i in $(seq 1 30); do docker exec ${args.slug}-postgres-1 pg_isready -U app > /dev/null 2>&1 && break; sleep 2; done`
  );

  console.log('Applying starting database schema...');
  await runRemote(ip, `docker exec -i ${args.slug}-postgres-1 psql -U app -d ${args.slug} -v ON_ERROR_STOP=1 < ${remoteDir}/init.sql`);
  await runRemote(ip, `cd ${remoteDir} && docker compose restart postgrest`);

  // 4. DNS
  let dnsOk = true;
  let dnsInstructions = null;
  if (args.customDomain) {
    // Never automatable — it's not on the DirectAdmin account this script
    // controls. Always print what to hand the client, not just on failure.
    dnsOk = false;
    dnsInstructions = dns.customDomainInstructions(subdomain, ip);
    console.log('Custom domain — DNS is a manual step:');
    console.log(`  ${dnsInstructions}`);
  } else {
    console.log('Adding DNS record...');
    try {
      await dns.addARecord({ host: secrets.DA_HOST, username: secrets.DA_USERNAME, loginKey: secrets.DA_LOGIN_KEY }, ROOT_DOMAIN, args.slug, ip);
    } catch (err) {
      dnsOk = false;
      dnsInstructions = dns.manualInstructions(ROOT_DOMAIN, args.slug, ip);
      console.log(`  ${dnsInstructions}`);
      console.log(`  (Automatic DNS error, for debugging: ${err.message})`);
    }
  }

  // 5. Registry
  // dnsPending persists whenever DNS wasn't set up automatically, so the
  // panel can keep showing what record to add until it's explicitly
  // confirmed — the job log itself is in-memory and gone once the run
  // finishes, which isn't durable enough for a step someone else has to go
  // do on a different system, possibly minutes or hours later.
  upsertClient(registry, {
    name: args.slug,
    displayName: args.name,
    subdomain,
    isCustomDomain: Boolean(args.customDomain),
    dnsPending: !dnsOk,
    dnsPendingInstructions: dnsInstructions,
    provider: 'hetzner',
    serverId,
    ip,
    repo: repo ? repo.htmlUrl : null,
    needsWhatsapp: args.whatsapp,
    needsPayment: Boolean(args.payment),
    paymentProvider: args.payment,
    hasPdf: args.pdf,
    createdAt: new Date().toISOString(),
    // isEbos marks this registry entry as the EBOS deployment (not a normal
    // one-business client) so the panel knows to render it in "Businesses
    // (EBOS)" instead of "Clients", and ebosAdminToken lets the panel call
    // its /admin/api/* directly. registry.json is control-server-local and
    // never committed to git, same as secrets.env, so storing this one
    // secret here follows the existing pattern rather than a new one.
    ...(args.template === 'ebos' ? { isEbos: true, ebosAdminToken: vars.EBOS_ADMIN_TOKEN } : {}),
  });
  saveRegistry(registry);

  if (args.whatsapp) {
    console.log('Setting up bot-engine (WhatsApp was requested)...');
    await runScaffoldBot(args.slug);
  }

  console.log('\nDone.');
  console.log(`  App:      https://${subdomain} ${dnsOk ? '(DNS added automatically)' : '(DNS needs the manual step above)'}`);
  console.log(`  Repo:     ${repo ? repo.htmlUrl : '(skipped, --skip-github)'}`);
  console.log(`  Server:   ${ip}`);
  console.log(`  Dashboard login: admin / ${vars.DASHBOARD_PASSWORD}`);
  console.log(`  WhatsApp: ${args.whatsapp ? 'slot ready, run add-whatsapp.mjs with real Meta credentials' : 'not requested'}`);
  console.log(`  Payment:  ${args.payment ? `slot ready (${args.payment}), run add-payment.mjs with real keys` : 'not requested'}`);
}

function listFilesRecursive(dir, baseDir = dir) {
  let results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(listFilesRecursive(full, baseDir));
    else results.push(path.relative(baseDir, full));
  }
  return results;
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
