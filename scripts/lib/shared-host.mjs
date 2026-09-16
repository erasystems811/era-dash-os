// Support for running more than one client's docker stack on a single
// server -- the alternative to create-client.mjs's default of a brand new
// dedicated Hetzner box per client, which is the "one server one client"
// cost problem. A shared server has exactly ONE Caddy, living outside any
// individual client's docker-compose (at SHARED_CADDY_DIR below), binding
// the host's 80/443. Each client's own stack drops its `caddy` service
// entirely (see ebos-templates/docker-compose.shared.yml.template) and
// instead publishes dashboard/postgrest/n8n on 127.0.0.1:<allocated port>;
// the shared Caddy reverse-proxies each client's subdomain to its own three
// ports. Only EBOS clients are meant to use this -- ESF is deliberately
// isolated per business (see create-client.mjs's isEsf comment) and the
// generic 'default' template has no shared-mode compose file (yet), so
// this is only ever invoked with --template=ebos.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runRemote, copyToRemote, readRemote } from './ssh.mjs';
import { render } from './render-template.mjs';
import { clientsOnServer } from './registry.mjs';

export const SHARED_CADDY_DIR = '/opt/shared-caddy';

// Ports are allocated in blocks of 10 (dashboard/postgrest/n8n plus
// headroom) starting well above anything else this stack uses, so a typo'd
// port never collides with, say, Postgres's own 5432.
const PORT_BASE = 20000;
const PORT_BLOCK = 10;

// network_mode: host -- without it, Caddy's own "127.0.0.1:<port>" (what
// every per-client site block below reverse-proxies to) means Caddy's own
// container loopback, not the host's, so it can never reach a sibling
// client stack's host-published port. Found live, 2026-09-16, on the first
// real shared-mode client ever deployed (Pomodoro): every request 502'd
// with "connection refused" even though the dashboard container itself was
// healthy and answered fine on a direct host-level curl. Host networking
// also means the ports: block below is unnecessary (host networking binds
// 80/443 directly) and Compose disallows combining the two anyway.
const SHARED_CADDY_COMPOSE = `services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    mem_limit: 150m
    network_mode: host
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  caddy_data:
  caddy_config:
`;

// Global options block only -- individual clients' site blocks get
// appended (and later removed) between their own BEGIN/END markers, never
// touching this header.
const SHARED_CADDYFILE_HEADER = `# Shared Caddy -- routes multiple EBOS clients' subdomains to their own
# dashboard/postgrest/n8n ports on this same server. Managed by
# scripts/lib/shared-host.mjs; do not hand-edit the per-client blocks below,
# they're added/removed by create-client.mjs / teardown-client.mjs.
`;

// Sets up the one-time shared Caddy on a fresh server -- idempotent, so
// calling this again on a server that already has it just leaves it alone
// rather than clobbering the live Caddyfile (and every client's site block
// already appended to it).
export async function bootstrapSharedHost(ip) {
  const { stdout } = await runRemote(ip, `test -f ${SHARED_CADDY_DIR}/Caddyfile && echo exists || echo missing`);
  if (stdout.trim() === 'exists') return;

  await runRemote(ip, `mkdir -p ${SHARED_CADDY_DIR}`);
  const tmpDir = path.join(os.tmpdir(), `shared-caddy-${ip}`);
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(path.join(tmpDir, 'docker-compose.yml'), SHARED_CADDY_COMPOSE);
  writeFileSync(path.join(tmpDir, 'Caddyfile'), SHARED_CADDYFILE_HEADER);
  await copyToRemote(ip, path.join(tmpDir, 'docker-compose.yml'), `${SHARED_CADDY_DIR}/docker-compose.yml`);
  await copyToRemote(ip, path.join(tmpDir, 'Caddyfile'), `${SHARED_CADDY_DIR}/Caddyfile`);
  await runRemote(ip, `cd ${SHARED_CADDY_DIR} && docker compose up -d`);
}

// Picks three free host ports (dashboard/postgrest/n8n) for a new tenant on
// this server -- one block past whatever the highest existing tenant on
// this same server is already using, so a torn-down-and-recreated client
// never reclaims a port a still-live neighbor might have cached a
// connection to.
export function allocatePorts(registry, ip) {
  const existing = clientsOnServer(registry, ip);
  const highestBase = existing.reduce((max, c) => {
    const base = c.sharedPorts?.dashboard;
    return typeof base === 'number' && base > max ? base : max;
  }, PORT_BASE - PORT_BLOCK);
  const base = highestBase + PORT_BLOCK;
  return { dashboard: base, postgrest: base + 1, n8n: base + 2 };
}

export function renderSiteBlock(templatePath, vars) {
  return render(readFileSync(templatePath, 'utf8'), vars);
}

// Appended/removed as a clearly delimited block so removeSite can find and
// strip exactly one client's routing without touching anyone else's --
// string-splicing a shared config file on a live server has to be exact,
// not "looks about right".
function markers(slug) {
  return { begin: `# BEGIN ${slug}`, end: `# END ${slug}` };
}

export async function addSite(ip, slug, siteBlock) {
  const { begin, end } = markers(slug);
  const block = `\n${begin}\n${siteBlock.trim()}\n${end}\n`;
  await runRemote(ip, `cat >> ${SHARED_CADDY_DIR}/Caddyfile << 'EOF'\n${block}\nEOF`);
  await reload(ip);
}

export async function removeSite(ip, slug) {
  const { begin, end } = markers(slug);
  const current = await readRemote(ip, `${SHARED_CADDY_DIR}/Caddyfile`);
  const beginIdx = current.indexOf(begin);
  const endIdx = current.indexOf(end);
  if (beginIdx === -1 || endIdx === -1) return; // already gone / never added
  const updated = current.slice(0, beginIdx) + current.slice(endIdx + end.length);
  const tmpFile = path.join(os.tmpdir(), `Caddyfile-${slug}`);
  writeFileSync(tmpFile, updated);
  await copyToRemote(ip, tmpFile, `${SHARED_CADDY_DIR}/Caddyfile`);
  await reload(ip);
}

async function reload(ip) {
  // A bad site block should fail loudly here, before it ever reaches the
  // live Caddyfile that every other tenant on this server also depends on
  // -- `caddy reload` validates first and leaves the running config alone
  // on error, unlike a container restart which would just crash-loop
  // everyone's routing at once.
  await runRemote(ip, `cd ${SHARED_CADDY_DIR} && docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile`);
}
