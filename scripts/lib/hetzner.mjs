// Hetzner Cloud provider — same interface shape as digitalocean.mjs so
// create-client.mjs can pick either one. Confirmed working 2026-08-01: the
// control server's SSH key is registered with Hetzner (name
// "era-dash-os-control", same keypair used for DigitalOcean).

const API_BASE = 'https://api.hetzner.cloud/v1';

function headers(hetznerToken) {
  return {
    Authorization: `Bearer ${hetznerToken}`,
    'Content-Type': 'application/json',
  };
}

// Same cloud-init as DigitalOcean's — installs Docker the same way Bali's
// real droplet has it.
const CLOUD_INIT = `#!/bin/bash
set -e
apt-get update
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo \\"$VERSION_CODENAME\\") stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
mkdir -p /opt
touch /opt/cloud-init-done
`;

export async function listSshKeyIds(hetznerToken) {
  const res = await fetch(`${API_BASE}/ssh_keys`, { headers: headers(hetznerToken) });
  if (!res.ok) throw new Error(`Hetzner list SSH keys failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.ssh_keys.map((k) => k.id);
}

// size: 'small' | 'medium' | 'large' — matches the form's tucked-away size field
const SERVER_TYPE_BY_SIZE = {
  small: 'cpx21', // 3 vCPU / 4GB — comfortable default (2GB was too tight on Bali's real droplet)
  medium: 'cpx31', // 4 vCPU / 8GB
  large: 'cpx41', // 8 vCPU / 16GB
};

export async function createServer(hetznerToken, { name, location = 'nbg1', size = 'small' }) {
  const sshKeyIds = await listSshKeyIds(hetznerToken);
  const serverType = SERVER_TYPE_BY_SIZE[size] || SERVER_TYPE_BY_SIZE.small;
  const res = await fetch(`${API_BASE}/servers`, {
    method: 'POST',
    headers: headers(hetznerToken),
    body: JSON.stringify({
      name,
      server_type: serverType,
      image: 'ubuntu-24.04',
      location,
      ssh_keys: sshKeyIds,
      user_data: CLOUD_INIT,
      labels: { 'era-client': 'true' },
    }),
  });
  if (!res.ok) throw new Error(`Hetzner create server failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.server.id;
}

export async function getServer(hetznerToken, id) {
  const res = await fetch(`${API_BASE}/servers/${id}`, { headers: headers(hetznerToken) });
  if (!res.ok) throw new Error(`Hetzner get server failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.server;
}

export async function waitForServerActive(hetznerToken, id, { timeoutMs = 5 * 60 * 1000, intervalMs = 8000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const server = await getServer(hetznerToken, id);
    if (server.status === 'running' && server.public_net?.ipv4?.ip) {
      return server.public_net.ipv4.ip;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Hetzner server ${id} did not become running with a public IP within ${timeoutMs}ms`);
}

export async function deleteServer(hetznerToken, id) {
  const res = await fetch(`${API_BASE}/servers/${id}`, { method: 'DELETE', headers: headers(hetznerToken) });
  if (!res.ok && res.status !== 404) throw new Error(`Hetzner delete server failed: ${res.status} ${await res.text()}`);
}
