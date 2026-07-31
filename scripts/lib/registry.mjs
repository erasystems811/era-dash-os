import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const REGISTRY_PATH = process.env.ERA_REGISTRY_PATH || '/opt/era-control/registry.json';

export function loadRegistry(path = REGISTRY_PATH) {
  if (!existsSync(path)) return { clients: [] };
  return JSON.parse(readFileSync(path, 'utf8'));
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
