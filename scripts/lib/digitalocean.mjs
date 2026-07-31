const API_BASE = 'https://api.digitalocean.com/v2';

// New Ubuntu image + cloud-init instead of the marketplace "Docker on Ubuntu"
// image, so we don't depend on a marketplace slug that can change — this
// installs Docker the same way it was installed on the real Bali droplet.
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

function headers(doToken) {
  return {
    Authorization: `Bearer ${doToken}`,
    'Content-Type': 'application/json',
  };
}

export async function listAccountSshKeyIds(doToken) {
  const res = await fetch(`${API_BASE}/account/keys`, { headers: headers(doToken) });
  if (!res.ok) throw new Error(`DO list SSH keys failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.ssh_keys.map((k) => k.id);
}

export async function createDroplet(doToken, { name, region = 'lon1', size = 's-1vcpu-2gb' }) {
  const sshKeyIds = await listAccountSshKeyIds(doToken);
  const res = await fetch(`${API_BASE}/droplets`, {
    method: 'POST',
    headers: headers(doToken),
    body: JSON.stringify({
      name,
      region,
      size,
      image: 'ubuntu-24-04-x64',
      ssh_keys: sshKeyIds,
      backups: false,
      ipv6: false,
      monitoring: true,
      user_data: CLOUD_INIT,
      tags: ['era-client'],
    }),
  });
  if (!res.ok) throw new Error(`DO create droplet failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.droplet.id;
}

export async function getDroplet(doToken, id) {
  const res = await fetch(`${API_BASE}/droplets/${id}`, { headers: headers(doToken) });
  if (!res.ok) throw new Error(`DO get droplet failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.droplet;
}

export async function waitForDropletActive(doToken, id, { timeoutMs = 5 * 60 * 1000, intervalMs = 8000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const droplet = await getDroplet(doToken, id);
    if (droplet.status === 'active') {
      const ip = droplet.networks.v4.find((n) => n.type === 'public')?.ip_address;
      if (ip) return ip;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Droplet ${id} did not become active with a public IP within ${timeoutMs}ms`);
}

export async function deleteDroplet(doToken, id) {
  const res = await fetch(`${API_BASE}/droplets/${id}`, { method: 'DELETE', headers: headers(doToken) });
  if (!res.ok && res.status !== 404) throw new Error(`DO delete droplet failed: ${res.status} ${await res.text()}`);
}
