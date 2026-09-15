// OVHcloud (Public Cloud) provider -- same interface shape as
// hetzner.mjs/digitalocean.mjs/oracle.mjs (createServer/waitForServerActive/
// deleteServer) so create-client.mjs can pick it with --provider=ovh. Added
// 2026-09-15 per Chidera: needs a provider that isn't Hetzner (ruled out)
// and isn't the Oracle account (reserved for internal ops, and its paid
// tier is more than she wants to spend for client hosting).
//
// OVH's API has no simple bearer token either -- every request is signed
// with THREE credentials (Application Key, Application Secret, Consumer
// Key), not one. AK/AS are created once at https://eu.api.ovh.com/createApp
// (instant, no approval). The Consumer Key is different: it requires a
// one-time interactive step -- POST a request for one (with ACL rules) and
// OVH hands back a validationUrl a human must open and click "authorize"
// on before the CK actually works. scripts/ovh-get-consumer-key.mjs walks
// through that step once; this module only ever READS the result from
// secrets.env, same division of labor as oracle.mjs's manual API-key setup.
//
// Required secrets.env keys (requireOvhConfig below fails loudly and names
// exactly what's missing):
//   OVH_APPLICATION_KEY     -- from https://eu.api.ovh.com/createApp
//   OVH_APPLICATION_SECRET  -- from the same page
//   OVH_CONSUMER_KEY        -- from scripts/ovh-get-consumer-key.mjs's
//                              one-time interactive flow
//   OVH_PROJECT_ID          -- OVH calls this "serviceName" in their own
//                              docs -- Public Cloud console's project ID
//   OVH_SSH_PUBLIC_KEY      -- uploaded once per project, then reused by
//                              id for every instance (ensureSshKey below)
// Optional:
//   OVH_REGION   -- default 'UK1' (lowest EU latency to Nigeria/West
//                   Africa, same reasoning as Oracle's uk-london-1 pick)
//   OVH_ENDPOINT -- default 'ovh-eu' -- which OVH API region this account
//                   was created under (ovh-eu/ovh-us/ovh-ca) -- get this
//                   wrong and every request 403s with an unhelpful error,
//                   since AK/AS are only valid against their own endpoint

import { createHash } from 'node:crypto';

const REQUIRED_KEYS = ['OVH_APPLICATION_KEY', 'OVH_APPLICATION_SECRET', 'OVH_CONSUMER_KEY', 'OVH_PROJECT_ID', 'OVH_SSH_PUBLIC_KEY'];

const ENDPOINTS = {
  'ovh-eu': 'https://eu.api.ovh.com/1.0',
  'ovh-us': 'https://api.us.ovhcloud.com/1.0',
  'ovh-ca': 'https://ca.api.ovh.com/1.0',
};

export function requireOvhConfig(secrets) {
  const missing = REQUIRED_KEYS.filter((k) => !secrets[k]);
  if (missing.length) {
    throw new Error(
      `Missing OVH config in secrets.env: ${missing.join(', ')}. OVH_APPLICATION_KEY/OVH_APPLICATION_SECRET come from https://eu.api.ovh.com/createApp; OVH_CONSUMER_KEY comes from running scripts/ovh-get-consumer-key.mjs once; OVH_PROJECT_ID is your Public Cloud project's "serviceName" (OVH console -> Public Cloud -> Project Settings -> General information); OVH_SSH_PUBLIC_KEY is the same public key string used for Hetzner/Oracle. See the comment at the top of scripts/lib/ovh.mjs.`
    );
  }
  return {
    applicationKey: secrets.OVH_APPLICATION_KEY,
    applicationSecret: secrets.OVH_APPLICATION_SECRET,
    consumerKey: secrets.OVH_CONSUMER_KEY,
    projectId: secrets.OVH_PROJECT_ID,
    sshPublicKey: secrets.OVH_SSH_PUBLIC_KEY,
    region: secrets.OVH_REGION || 'UK1',
    endpoint: secrets.OVH_ENDPOINT || 'ovh-eu',
  };
}

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

function apiBase(config) {
  const base = ENDPOINTS[config.endpoint];
  if (!base) throw new Error(`Unknown OVH_ENDPOINT "${config.endpoint}" -- must be one of ${Object.keys(ENDPOINTS).join(', ')}.`);
  return base;
}

// OVH's signature scheme is notoriously strict about clock skew ("This call
// has expired" / "invalid signature" with no clearer reason) -- rather than
// trust this machine's own clock, every signed request first reads OVH's
// own server time from the one endpoint that needs no signature at all,
// and uses that as the timestamp. Cheap (one extra GET), and removes an
// entire class of failure that would otherwise look identical to a wrong
// Application Secret.
async function ovhServerTimestamp(config) {
  const res = await fetch(`${apiBase(config)}/auth/time`);
  if (!res.ok) throw new Error(`OVH GET /auth/time failed: ${res.status} ${await res.text()}`);
  return res.text(); // plain unix-seconds integer, as text
}

function sign({ applicationSecret, consumerKey, method, url, bodyStr, timestamp }) {
  const toHash = [applicationSecret, consumerKey, method, url, bodyStr, timestamp].join('+');
  return '$1$' + createHash('sha1').update(toHash).digest('hex');
}

async function ovhRequest(config, method, path, body) {
  const url = `${apiBase(config)}${path}`;
  const bodyStr = body !== undefined ? JSON.stringify(body) : '';
  const timestamp = await ovhServerTimestamp(config);
  const signature = sign({ applicationSecret: config.applicationSecret, consumerKey: config.consumerKey, method, url, bodyStr, timestamp });
  const res = await fetch(url, {
    method,
    headers: {
      'X-Ovh-Application': config.applicationKey,
      'X-Ovh-Consumer': config.consumerKey,
      'X-Ovh-Timestamp': timestamp,
      'X-Ovh-Signature': signature,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? bodyStr : undefined,
  });
  if (!res.ok) throw new Error(`OVH ${method} ${path} failed: ${res.status} ${await res.text()}`);
  if (res.status === 204) return null;
  return res.json();
}

// flavorId/imageId/sshKeyId are opaque per-project, per-region IDs, not
// names -- OVH's own console shows names, so every create-client run
// resolves the human-readable name it wants against the real list rather
// than hardcoding an ID that could differ per account or silently change.
async function resolveFlavorId(config, flavorName) {
  const flavors = await ovhRequest(config, 'GET', `/cloud/project/${config.projectId}/flavor?region=${config.region}`);
  const match = flavors.find((f) => f.name === flavorName);
  if (!match) {
    throw new Error(
      `No OVH flavor named "${flavorName}" in region ${config.region} for this project. Available: ${flavors.map((f) => f.name).join(', ')}`
    );
  }
  return match.id;
}

async function resolveImageId(config, imageNameContains) {
  const images = await ovhRequest(config, 'GET', `/cloud/project/${config.projectId}/image?region=${config.region}&osType=linux`);
  const match = images.find((i) => i.name.includes(imageNameContains));
  if (!match) {
    throw new Error(`No OVH image matching "${imageNameContains}" in region ${config.region}. Available: ${images.map((i) => i.name).join(', ')}`);
  }
  return match.id;
}

// Uploads the account's SSH public key once per project and reuses it by
// id thereafter -- same role as Hetzner's account-wide key list, just OVH
// has no account-wide concept, only per-project. Matches on the exact key
// string (not name), so re-running this after a key was already uploaded
// is a no-op instead of piling up duplicate entries.
async function ensureSshKey(config) {
  const keys = await ovhRequest(config, 'GET', `/cloud/project/${config.projectId}/sshkey`);
  const existing = keys.find((k) => k.publicKey.trim() === config.sshPublicKey.trim());
  if (existing) return existing.id;
  const created = await ovhRequest(config, 'POST', `/cloud/project/${config.projectId}/sshkey`, {
    name: 'era-dash-os-control',
    publicKey: config.sshPublicKey,
    region: config.region,
  });
  return created.id;
}

// size: 'small' | 'medium' | 'large'. Uses OVH's "b2" (guaranteed
// performance) range, not the cheaper "d2" range -- d2 is OVH's own
// "Discovery" tier, explicitly documented as meant for test/dev, not a
// real paying client's production traffic (confirmed 2026-09-15 research,
// see the commit this file was added in).
const FLAVOR_BY_SIZE = {
  small: 'b2-7', // 2 vCPU / 7GB
  medium: 'b2-15', // 4 vCPU / 15GB
  large: 'b2-30', // 8 vCPU / 30GB
};

export async function createServer(config, { name, size = 'small' }) {
  const flavorName = FLAVOR_BY_SIZE[size] || FLAVOR_BY_SIZE.small;
  const [flavorId, imageId, sshKeyId] = await Promise.all([
    resolveFlavorId(config, flavorName),
    resolveImageId(config, 'Ubuntu 24.04'),
    ensureSshKey(config),
  ]);
  const instance = await ovhRequest(config, 'POST', `/cloud/project/${config.projectId}/instance`, {
    name,
    flavorId,
    imageId,
    region: config.region,
    sshKeyId,
    monthlyBilling: false,
    userData: CLOUD_INIT,
  });
  return instance.id;
}

export async function getServer(config, instanceId) {
  return ovhRequest(config, 'GET', `/cloud/project/${config.projectId}/instance/${instanceId}`);
}

export async function waitForServerActive(config, instanceId, { timeoutMs = 5 * 60 * 1000, intervalMs = 8000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const instance = await getServer(config, instanceId);
    if (instance.status === 'ACTIVE') {
      const publicIp = instance.ipAddresses?.find((ip) => ip.type === 'public' && ip.version === 4)?.ip;
      if (publicIp) return publicIp;
    }
    if (instance.status === 'ERROR') {
      throw new Error(`OVH instance ${instanceId} moved to ERROR instead of coming up -- check the OVH Public Cloud console for why (quota, capacity, or a bad flavor/image/region combination are the common ones).`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`OVH instance ${instanceId} did not become ACTIVE with a public IP within ${timeoutMs}ms`);
}

export async function deleteServer(config, instanceId) {
  try {
    await ovhRequest(config, 'DELETE', `/cloud/project/${config.projectId}/instance/${instanceId}`);
  } catch (err) {
    if (!err.message.includes(' 404 ')) throw err;
  }
}
