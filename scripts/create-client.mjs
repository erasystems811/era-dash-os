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
// EBOS (the ordering/booking product) and ESF (ERA StaffFlow) are both
// fixed templates, not a shared deployment -- every business gets its own
// dedicated run of this script (--template=ebos / --template=esf, reading
// from ebos-templates/ / esf-templates/ instead), same as any other client.
//
// --ebos-seed=path/to/config.json (only meaningful with --template=ebos) /
// --esf-seed=path/to/config.json (only meaningful with --template=esf)
// bake a real business straight into the new database at provision time --
// business details plus (EBOS) catalogue/bot training/knowledge base or
// (ESF) staff/task/step rows -- so a working business exists the moment the
// server comes up, instead of an empty template. This is what the ERA Dash
// OS workstation calls behind its "Build" button
// (panel/routes/workstation.js writes the JSON, scripts/lib/ebos-seed.mjs /
// scripts/lib/esf-seed.mjs turn it into SQL).

import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

import { loadSecrets, requireSecrets } from './lib/secrets.mjs';
import { loadRegistry, saveRegistry, upsertClient, findClient, findServer, upsertServer } from './lib/registry.mjs';
import { randomSecret, randomPassword, randomEncryptionKey, slugify } from './lib/random.mjs';
import { buildEbosSeedSql } from './lib/ebos-seed.mjs';
import { buildEsfSeedSql } from './lib/esf-seed.mjs';
import { provisionSheet } from './lib/esf-sheet.mjs';
import { render } from './lib/render-template.mjs';
import { templatesDirFor } from './lib/templates-dir.mjs';
import * as hetzner from './lib/hetzner.mjs';
import * as oracle from './lib/oracle.mjs';
import * as ovh from './lib/ovh.mjs';
import * as digitalocean from './lib/digitalocean.mjs';
import * as github from './lib/github.mjs';
import * as dns from './lib/dns.mjs';
import { waitForSsh, waitForCloudInit, runRemote, copyToRemote } from './lib/ssh.mjs';
import { runScaffoldBot } from './lib/scaffold-runner.mjs';
import { bootstrapSharedHost, allocatePorts, renderSiteBlock, addSite } from './lib/shared-host.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DOMAIN = process.env.ERA_ROOT_DOMAIN || 'erasystems.com.ng';

function parseArgs(argv) {
  // Default provider is 'oracle' now, not 'hetzner' -- Chidera's call,
  // 2026-09-10: "i stopped using hetzner na". Still selectable
  // (--provider=hetzner) for a business that's staying on an existing
  // Hetzner setup, but a plain run of this script no longer touches
  // Hetzner by accident.
  const args = { whatsapp: false, payment: null, pdf: false, skipGithub: false, size: 'small', template: 'default', provider: 'oracle' };
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
    else if (arg.startsWith('--provider=')) args.provider = arg.slice('--provider='.length);
    else if (arg.startsWith('--ebos-seed=')) args.ebosSeed = arg.slice('--ebos-seed='.length);
    else if (arg.startsWith('--esf-seed=')) args.esfSeed = arg.slice('--esf-seed='.length);
    else if (arg.startsWith('--shared-server=')) args.sharedServer = arg.slice('--shared-server='.length);
    else if (arg === '--new-shared-server') args.newSharedServer = true;
  }
  if (!args.name) throw new Error('Usage: create-client.mjs --name="Client Name" [--subdomain=slug | --custom-domain=example.com] [--whatsapp] [--payment=flutterwave|paystack] [--pdf] [--size=small|medium|large] [--provider=oracle|hetzner|ovh|digitalocean] [--template=default|ebos|esf] [--ebos-seed=path/to/config.json] [--esf-seed=path/to/config.json] [--shared-server=ip | --new-shared-server]');
  if (!['oracle', 'hetzner', 'ovh', 'digitalocean'].includes(args.provider)) throw new Error(`Unknown --provider="${args.provider}" -- only "oracle", "hetzner", "ovh" and "digitalocean" are wired up (see scripts/lib/oracle.mjs / hetzner.mjs / ovh.mjs / digitalocean.mjs).`);
  // A shared server's IP is provider-agnostic once it exists (join mode
  // never calls a provider API at all -- see the sharedMode==='join'
  // branch below), so --provider only matters for --new-shared-server or
  // the plain dedicated path.
  if (args.subdomain && args.customDomain) throw new Error('Pass either --subdomain or --custom-domain, not both.');
  if (args.sharedServer && args.newSharedServer) throw new Error('Pass either --shared-server=ip (join an existing shared server) or --new-shared-server (create one), not both.');
  // Shared hosting only exists for docker-compose.shared.yml.template,
  // which only ebos-templates/ has (ESF is deliberately isolated per
  // business -- see the isEsf comment further down -- and the generic
  // 'default' template has no shared-mode compose file yet).
  if ((args.sharedServer || args.newSharedServer) && args.template !== 'ebos') {
    throw new Error('--shared-server / --new-shared-server only work with --template=ebos.');
  }
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
  const requiredSecrets = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
  // --shared-server=ip (joining an existing shared server) never calls a
  // provider API at all -- no server gets created, so no provider secret
  // is needed for it. Every other path (dedicated, --new-shared-server)
  // does create one, so it needs its provider's config; oracle.mjs's own
  // requireOracleConfig gives a much more specific error below than
  // requireSecrets could (which key, and what it's for), so Oracle's
  // check happens there instead of being folded into this list.
  if (!args.sharedServer) {
    if (args.provider === 'hetzner') requiredSecrets.push('HETZNER_TOKEN');
    if (args.provider === 'digitalocean') requiredSecrets.push('DIGITALOCEAN_TOKEN');
  }
  // DirectAdmin secrets only matter for the erasystems.com.ng subdomain
  // path — a custom domain never touches that account.
  if (!args.customDomain) requiredSecrets.push('DA_USERNAME', 'DA_LOGIN_KEY', 'DA_HOST');
  if (!args.skipGithub) requiredSecrets.push('GITHUB_TOKEN');
  requireSecrets(secrets, requiredSecrets);
  // See the comment above -- Oracle's/OVH's own config checks (which name
  // each specific missing key) rather than a generic requireSecrets entry.
  const oracleConfig = !args.sharedServer && args.provider === 'oracle' ? oracle.requireOracleConfig(secrets) : null;
  const ovhConfig = !args.sharedServer && args.provider === 'ovh' ? ovh.requireOvhConfig(secrets) : null;

  const registry = loadRegistry();
  if (findClient(registry, args.slug)) {
    throw new Error(`A client named "${args.slug}" already exists in the registry. Pick a different --subdomain, or use add-whatsapp.mjs/add-payment.mjs to modify it.`);
  }

  // sharedMode: 'none' (default -- this client gets its own dedicated
  // server, same as always), 'join' (deploy onto a server another EBOS
  // client is already running on), or 'new' (create a fresh server that
  // starts life as a shared host, ready for more tenants later). See
  // lib/shared-host.mjs for what actually makes two clients' stacks
  // coexist on one box.
  const sharedMode = args.sharedServer ? 'join' : args.newSharedServer ? 'new' : 'none';
  if (sharedMode === 'join') {
    const server = findServer(registry, args.sharedServer);
    if (!server || server.mode !== 'shared') {
      throw new Error(`"${args.sharedServer}" isn't a registered shared server. Create one first with --new-shared-server, or check scripts/lib/registry.mjs's servers list for the right IP.`);
    }
  }
  // A brand new shared server has no other tenants yet, so its first
  // client always gets the base port block -- allocatePorts would compute
  // the same thing by finding zero existing clients at this IP, but for
  // 'new' the IP doesn't exist yet (the server hasn't been created), so
  // there's nothing to look up.
  const sharedPorts = sharedMode === 'join' ? allocatePorts(registry, args.sharedServer) : sharedMode === 'new' ? allocatePorts(registry, null) : null;

  const vars = {
    APP_SLUG: args.slug,
    SUBDOMAIN: subdomain,
    PUBLIC_URL: `https://${subdomain}`,
    OPENAI_API_KEY: secrets.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: secrets.ANTHROPIC_API_KEY,
    // ERA-wide, shared across every EBOS deployment (engine/push-notify.js)
    // -- not per-client the way PAYMENT_ENCRYPTION_KEY is generated below.
    // Blank (harmless) on a control server that hasn't set these up yet --
    // push just stays unavailable, same "off is genuinely inert" idiom as
    // any other optional capability.
    VAPID_PUBLIC_KEY: secrets.VAPID_PUBLIC_KEY || '',
    VAPID_PRIVATE_KEY: secrets.VAPID_PRIVATE_KEY || '',
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
    // Same reasoning, for esf-templates/ instead.
    ESF_ADMIN_TOKEN: randomSecret(32),
    // Passed through to this deployment's own .env only if configured on
    // the control server -- engine/sheet-sync.js's periodic re-sync (inside
    // the running dashboard) needs its own copy of the same credential
    // scripts/lib/esf-sheet.mjs just used to create the Sheet in the first
    // place. Empty string (not undefined) so render()'s {{VAR}} substitution
    // still produces a real, present-but-blank line rather than leaving the
    // literal token in the file.
    GOOGLE_SERVICE_ACCOUNT_JSON: secrets.GOOGLE_SERVICE_ACCOUNT_JSON || '',
    // Only referenced by docker-compose.shared.yml.template / the
    // Caddyfile.shared-site.template site block -- ignored (harmless) by
    // the dedicated-mode templates when sharedMode is 'none'.
    DASHBOARD_PORT: sharedPorts ? String(sharedPorts.dashboard) : '',
    POSTGREST_PORT: sharedPorts ? String(sharedPorts.postgrest) : '',
    N8N_PORT: sharedPorts ? String(sharedPorts.n8n) : '',
  };

  // A shared-mode client has no Caddy of its own (one shared Caddy per
  // server handles every tenant's routing -- see lib/shared-host.mjs), so
  // it reads a different compose file and produces a site-block instead of
  // a full Caddyfile.
  const composeTemplateName = sharedMode === 'none' ? 'docker-compose.yml.template' : 'docker-compose.shared.yml.template';
  const dockerComposeReal = render(readFileSync(path.join(TEMPLATES_DIR, composeTemplateName), 'utf8'), vars);
  const caddyfile = sharedMode === 'none' ? render(readFileSync(path.join(TEMPLATES_DIR, 'Caddyfile.template'), 'utf8'), vars) : null;
  const sharedSiteBlock = sharedMode === 'none' ? null : renderSiteBlock(path.join(TEMPLATES_DIR, 'Caddyfile.shared-site.template'), vars);
  const envReal = render(readFileSync(path.join(TEMPLATES_DIR, '.env.template'), 'utf8'), vars);
  const schema = readFileSync(path.join(TEMPLATES_DIR, 'schema.sql'), 'utf8');

  // 1. GitHub repo (code only — no real secrets ever get committed)
  let repo = null;
  if (!args.skipGithub) {
    console.log('Creating GitHub repo...');
    const owner = await github.getAuthenticatedUser(secrets.GITHUB_TOKEN);
    repo = await github.createRepo(secrets.GITHUB_TOKEN, `era-${args.slug}`);
    await github.putFile(secrets.GITHUB_TOKEN, repo.owner, repo.repo, 'docker-compose.yml', dockerComposeReal, 'Initial setup');
    // A shared-mode client has no Caddyfile of its own -- its routing
    // lives in the shared server's own Caddy config, not this repo.
    if (caddyfile) await github.putFile(secrets.GITHUB_TOKEN, repo.owner, repo.repo, 'Caddyfile', caddyfile, 'Initial setup');
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
  let serverId, ip;
  // Tracks the provider actually used -- differs from args.provider only
  // when the Oracle->Hetzner fallback below fires. The registry entry
  // must record this, not args.provider, or teardown-client.mjs would
  // later try to delete the server from the wrong provider's API.
  let actualProvider = args.provider;
  if (sharedMode === 'join') {
    // Already exists and is already running Docker + the shared Caddy --
    // that's what makes it "a registered shared server" (validated above).
    ip = args.sharedServer;
    serverId = findServer(registry, ip).serverId;
    console.log(`Joining existing shared server ${ip}...`);
  } else {
    console.log(`Creating ${args.provider} server (this takes a few minutes)...`);
    if (args.provider === 'oracle') {
      try {
        serverId = await oracle.createServer(oracleConfig, { name: dropletName, size: args.size });
        ip = await oracle.waitForServerActive(oracleConfig, serverId);
      } catch (err) {
        // Automatic Oracle -> Hetzner fallback -- Chidera's call, 2026-09-16:
        // Oracle's own account is right at its Always Free capacity ceiling
        // (real risk of a create failing on quota/capacity), and Hetzner's
        // provider code is proven, tested, and ready. Only fires for the
        // 'oracle' provider specifically (not ovh/digitalocean) and only
        // when a Hetzner token is actually configured -- otherwise the
        // real Oracle error surfaces as before, rather than a confusing
        // "HETZNER_TOKEN missing" error masking what actually failed.
        if (!secrets.HETZNER_TOKEN) throw err;
        console.log(`Oracle server creation failed (${err.message}) -- falling back to Hetzner...`);
        actualProvider = 'hetzner';
        serverId = await hetzner.createServer(secrets.HETZNER_TOKEN, { name: dropletName, size: args.size });
        ip = await hetzner.waitForServerActive(secrets.HETZNER_TOKEN, serverId);
      }
    } else if (args.provider === 'ovh') {
      serverId = await ovh.createServer(ovhConfig, { name: dropletName, size: args.size });
      ip = await ovh.waitForServerActive(ovhConfig, serverId);
    } else if (args.provider === 'digitalocean') {
      const sizeSlug = { small: 's-2vcpu-4gb', medium: 's-4vcpu-8gb', large: 's-8vcpu-16gb' }[args.size] || 's-2vcpu-4gb';
      serverId = await digitalocean.createDroplet(secrets.DIGITALOCEAN_TOKEN, { name: dropletName, size: sizeSlug });
      ip = await digitalocean.waitForDropletActive(secrets.DIGITALOCEAN_TOKEN, serverId);
    } else {
      serverId = await hetzner.createServer(secrets.HETZNER_TOKEN, { name: dropletName, size: args.size });
      ip = await hetzner.waitForServerActive(secrets.HETZNER_TOKEN, serverId);
    }
    console.log(`  Server IP: ${ip}, waiting for it to finish booting + installing Docker...`);
    await waitForSsh(ip);
    await waitForCloudInit(ip);
    if (sharedMode === 'new') {
      console.log('Setting up the shared Caddy for this server...');
      await bootstrapSharedHost(ip);
      upsertServer(registry, { ip, provider: actualProvider, serverId, mode: 'shared', createdAt: new Date().toISOString() });
    }
  }

  // 3. Deploy real files (with real secrets) directly to the server, never to git
  console.log('Deploying app to the server...');
  const remoteDir = `/opt/${args.slug}`;
  await runRemote(ip, `mkdir -p ${remoteDir}/dashboard`);
  const tmpDir = path.join(os.tmpdir(), `era-${args.slug}`);
  // PostgREST connects as its own "authenticator" role (not "app"), so that
  // role must be created with the real generated password, and given access
  // to whatever schema.sql creates — none of that can live in the static
  // schema.sql template since the password is per-client.
  // Generated even when --ebos-seed isn't used, since it's cheap and keeps
  // the variable available unconditionally for the final summary below.
  const ownerPassword = randomPassword(12);
  let ebosSeedSql = '';
  if (args.ebosSeed) {
    const seedConfig = JSON.parse(readFileSync(args.ebosSeed, 'utf8'));
    ebosSeedSql = buildEbosSeedSql({ ...seedConfig, ownerPassword });
  }
  let esfSeedSql = '';
  if (args.esfSeed) {
    const seedConfig = JSON.parse(readFileSync(args.esfSeed, 'utf8'));
    esfSeedSql = buildEsfSeedSql({ ...seedConfig, ownerPassword });

    // Sheet provisioning (build schema v2.0 section 9.4) -- optional, same
    // as --whatsapp/--payment: runs only if a Google service account is
    // configured on the control server. spreadsheetId is baked straight
    // into the seed SQL (sheet_link is a singleton table, same trick as
    // business) rather than a second remote step after the server is up,
    // since the Sheet itself lives entirely outside this server anyway.
    if (secrets.GOOGLE_SERVICE_ACCOUNT_JSON) {
      console.log('Provisioning Google Sheet...');
      const spreadsheetId = await provisionSheet({
        businessName: seedConfig.business.name,
        ownerEmail: seedConfig.owner.email,
        serviceAccountJson: JSON.parse(secrets.GOOGLE_SERVICE_ACCOUNT_JSON),
      });
      if (spreadsheetId) {
        esfSeedSql += `\ninsert into sheet_link (spreadsheet_id) values ('${spreadsheetId.replace(/'/g, "''")}');`;
        console.log(`  Sheet: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
      }
    }
  }

  const initSql = [
    `CREATE ROLE authenticator WITH LOGIN PASSWORD '${vars.AUTHENTICATOR_PASSWORD.replace(/'/g, "''")}' NOINHERIT;`,
    `GRANT USAGE ON SCHEMA public TO authenticator;`,
    schema,
    ebosSeedSql,
    esfSeedSql,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticator;`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticator;`,
  ].join('\n');
  writeLocalTemp(tmpDir, {
    'docker-compose.yml': dockerComposeReal,
    // A shared-mode client has no Caddyfile of its own -- omit both the
    // temp file and (below) the copy, rather than shipping an empty/null
    // one nothing reads.
    ...(caddyfile ? { Caddyfile: caddyfile } : {}),
    '.env': envReal,
    'init.sql': initSql,
  });
  await copyToRemote(ip, `${tmpDir}/docker-compose.yml`, `${remoteDir}/docker-compose.yml`);
  if (caddyfile) await copyToRemote(ip, `${tmpDir}/Caddyfile`, `${remoteDir}/Caddyfile`);
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

  // Wire this client into the server's one shared Caddy -- its own stack
  // has no Caddy at all (see the docker-compose.shared.yml.template
  // comment), so until this runs it's up but genuinely unreachable from
  // the outside.
  if (sharedSiteBlock) {
    console.log('Adding this client to the shared server\'s Caddy...');
    await addSite(ip, args.slug, sharedSiteBlock);
  }

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
    // For a joined shared server, the real provider is whatever that
    // server was actually created as (recorded on it, not on args.provider
    // -- --shared-server mode doesn't require --provider to be meaningful
    // at all, since it never calls a provider API). Otherwise actualProvider,
    // not args.provider -- differs from it exactly when the Oracle->Hetzner
    // fallback above fired.
    provider: sharedMode === 'join' ? findServer(registry, ip).provider : actualProvider,
    serverId,
    ip,
    repo: repo ? repo.htmlUrl : null,
    needsWhatsapp: args.whatsapp,
    needsPayment: Boolean(args.payment),
    paymentProvider: args.payment,
    hasPdf: args.pdf,
    createdAt: new Date().toISOString(),
    // serverMode 'shared' plus hostedOn/sharedPorts is what teardown-client.mjs
    // checks to know it must NOT delete the underlying server (other
    // tenants may still be on it) and must instead remove just this
    // client's own site block from the shared Caddy.
    serverMode: sharedMode === 'none' ? 'dedicated' : 'shared',
    ...(sharedMode !== 'none' ? { hostedOn: ip, sharedPorts } : {}),
    // isEbos marks this registry entry as the EBOS deployment (not a normal
    // one-business client) so the panel knows to render it in "Businesses
    // (EBOS)" instead of "Clients", and ebosAdminToken lets the panel call
    // its /admin/api/* directly. registry.json is control-server-local and
    // never committed to git, same as secrets.env, so storing this one
    // secret here follows the existing pattern rather than a new one.
    ...(args.template === 'ebos' ? { isEbos: true, ebosAdminToken: vars.EBOS_ADMIN_TOKEN } : {}),
    // isEsf: unlike EBOS, ESF is physically isolated per business (build
    // schema v2.0 section 1) -- every ESF client IS a normal one-business
    // client, same as Bali or HostelSure. This flag exists only so the
    // panel can optionally group them under an "ESF" label later; it does
    // not change how this deployment is provisioned or run.
    ...(args.template === 'esf' ? { isEsf: true, esfAdminToken: vars.ESF_ADMIN_TOKEN } : {}),
  });
  saveRegistry(registry);

  if (args.whatsapp) {
    console.log('Setting up bot-engine (WhatsApp was requested)...');
    await runScaffoldBot(args.slug);
  }

  console.log('\nDone.');
  console.log(`  App:      https://${subdomain} ${dnsOk ? '(DNS added automatically)' : '(DNS needs the manual step above)'}`);
  console.log(`  Repo:     ${repo ? repo.htmlUrl : '(skipped, --skip-github)'}`);
  const serverModeNote =
    sharedMode === 'none' ? '(dedicated)' : sharedMode === 'new' ? `(shared, just set up -- pass --shared-server=${ip} to add more clients to it)` : '(shared)';
  const fallbackNote = actualProvider !== args.provider ? ` -- FELL BACK from ${args.provider} to ${actualProvider}, see the log above for why` : '';
  console.log(`  Server:   ${ip} ${serverModeNote} [${actualProvider}]${fallbackNote}`);
  if (args.ebosSeed || args.esfSeed) {
    // The generic DASHBOARD_USER/DASHBOARD_PASSWORD Basic Auth login this
    // template set doesn't use -- both EBOS and ESF have real per-owner
    // accounts instead (ebos-templates/dashboard/lib/auth.js's staff table,
    // esf-templates/dashboard/lib/auth.js's owner_user table) -- print the
    // real one.
    const seedConfig = JSON.parse(readFileSync(args.ebosSeed || args.esfSeed, 'utf8'));
    console.log(`  Owner login: ${String(seedConfig.owner.email).trim().toLowerCase()} / ${ownerPassword}`);
  } else {
    console.log(`  Dashboard login: admin / ${vars.DASHBOARD_PASSWORD}`);
  }
  console.log(`  WhatsApp: ${args.whatsapp ? 'slot ready, run add-whatsapp.mjs with real Meta credentials' : 'not requested'}`);
  console.log(`  Payment:  ${args.payment ? `slot ready (${args.payment}), run add-payment.mjs with real keys` : 'not requested'}`);
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

function listFilesRecursive(dir, baseDir = dir) {
  let results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
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
