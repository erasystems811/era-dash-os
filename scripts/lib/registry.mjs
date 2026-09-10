import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const REGISTRY_PATH = process.env.ERA_REGISTRY_PATH || '/opt/era-control/registry.json';

export function loadRegistry(path = REGISTRY_PATH) {
  if (!existsSync(path)) return { clients: [], servers: [] };
  const registry = JSON.parse(readFileSync(path, 'utf8'));
  // Older registries predate shared-server support and have no servers
  // array at all -- treat that the same as "no shared servers exist yet"
  // rather than making every caller null-check it.
  if (!registry.servers) registry.servers = [];
  return registry;
}

export function saveRegistry(registry, path = REGISTRY_PATH) {
  writeFileSync(path, JSON.stringify(registry, null, 2) + '\n');
}

export function findClient(registry, name) {
  return registry.clients.find((c) => c.name === name);
}

export function upsertClient(registry, client) {
  const idx = registry.clients.findIndex((c) => c.name === client.name);
  if (idx === -1) registry.clients.push(client);
  else registry.clients[idx] = { ...registry.clients[idx], ...client };
  return registry;
}

export function removeClient(registry, name) {
  registry.clients = registry.clients.filter((c) => c.name !== name);
  return registry;
}

// Shared servers -- a single Hetzner/DO box hosting more than one client's
// docker stack behind one host-level Caddy (see lib/shared-host.mjs), as an
// alternative to create-client.mjs's default of one dedicated server per
// client. Kept as its own top-level list (not folded into `clients`)
// because a server has no single business it belongs to once it's shared.
export function findServer(registry, ip) {
  return registry.servers.find((s) => s.ip === ip);
}

export function upsertServer(registry, server) {
  const idx = registry.servers.findIndex((s) => s.ip === server.ip);
  if (idx === -1) registry.servers.push(server);
  else registry.servers[idx] = { ...registry.servers[idx], ...server };
  return registry;
}

export function removeServer(registry, ip) {
  registry.servers = registry.servers.filter((s) => s.ip !== ip);
  return registry;
}

// Every client currently hosted on a given shared server -- used both to
// pick free ports for a new tenant and to decide whether tearing one client
// down should also delete the underlying server (only when it was the last
// one left).
export function clientsOnServer(registry, ip) {
  return registry.clients.filter((c) => c.serverMode === 'shared' && c.hostedOn === ip);
}
