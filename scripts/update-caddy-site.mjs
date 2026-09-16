#!/usr/bin/env node
// Usage: node update-caddy-site.mjs --client=slug
//
// Re-renders and re-applies an EXISTING client's own Caddy site block from
// the current Caddyfile.template / Caddyfile.shared-site.template -- for
// when the template itself changed (compression/caching headers added,
// 2026-09-16 -- see those templates' own comments) and already-live
// clients need the same fix, not just new ones created from now on.
// push-update.mjs deliberately never touches Caddyfile at all, so this is
// its own separate, deliberate step.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry, findClient } from './lib/registry.mjs';
import { runRemote, copyToRemote } from './lib/ssh.mjs';
import { render } from './lib/render-template.mjs';
import { addSite, removeSite } from './lib/shared-host.mjs';
import { templatesDirFor } from './lib/templates-dir.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    args[key] = rest.join('=');
  }
  if (!args.client) throw new Error('Usage: update-caddy-site.mjs --client=slug');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = loadRegistry();
  const client = findClient(registry, args.client);
  if (!client) throw new Error(`No client "${args.client}" in the registry.`);

  const templatesDir = templatesDirFor(client.isEbos ? 'ebos' : client.isEsf ? 'esf' : 'default');

  if (client.serverMode === 'shared') {
    const siteBlock = render(readFileSync(path.join(templatesDir, 'Caddyfile.shared-site.template'), 'utf8'), {
      SUBDOMAIN: client.subdomain,
      DASHBOARD_PORT: String(client.sharedPorts.dashboard),
      POSTGREST_PORT: String(client.sharedPorts.postgrest),
      N8N_PORT: String(client.sharedPorts.n8n),
    });
    await removeSite(client.ip, client.name);
    await addSite(client.ip, client.name, siteBlock);
    console.log(`Re-applied shared-host site block for "${client.name}".`);
  } else {
    const caddyfile = render(readFileSync(path.join(templatesDir, 'Caddyfile.template'), 'utf8'), { SUBDOMAIN: client.subdomain });
    const tmpFile = `/tmp/Caddyfile-${client.name}`;
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const os = await import('node:os');
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'era-caddy-'));
    const localFile = path.join(tmpDir, 'Caddyfile');
    writeFileSync(localFile, caddyfile);
    await copyToRemote(client.ip, localFile, `/opt/${client.name}/Caddyfile`);
    // caddy reload alone was found NOT to reliably pick up a changed
    // Caddyfile on era-demo, 2026-09-16 -- a full container restart is the
    // one that actually took effect every time it was tested.
    await runRemote(client.ip, `cd /opt/${client.name} && docker compose restart caddy`);
    console.log(`Re-applied dedicated Caddyfile for "${client.name}".`);
  }
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
