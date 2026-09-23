// Oracle Cloud Infrastructure (OCI) provider -- same interface shape as
// hetzner.mjs/digitalocean.mjs (createServer/waitForServerActive/
// deleteServer) so create-client.mjs can pick any of the three with
// --provider=. Added 2026-09-10 per Chidera: Hetzner is no longer the
// default going forward, and era-demo's own box already runs on Oracle.
//
// OCI's API has no simple bearer-token auth like Hetzner/DO -- every
// request is individually signed (RSA-SHA256, the "OCI HTTP Signatures"
// scheme: https://docs.oracle.com/en-us/iaas/Content/API/Concepts/signingrequests.htm)
// using a private key generated in the OCI console (Identity -> Users ->
// your user -> API Keys -> Add API Key). That's a real, manual, one-time
// setup step only the account owner can do -- this module reads the result
// of it from secrets.env, it can't create it.
//
// Required secrets.env keys (none of this works until all of these are
// set -- requireOracleConfig below fails loudly and names exactly what's
// missing, rather than a cryptic signing error):
//   ORACLE_TENANCY_OCID       -- Profile menu -> Tenancy
//   ORACLE_USER_OCID          -- Identity -> Users -> your user
//   ORACLE_FINGERPRINT        -- shown when the API key is added
//   ORACLE_PRIVATE_KEY_B64    -- the API key's PEM private key file,
//                                base64-encoded onto one line (secrets.env
//                                is single-line KEY=value, can't hold a
//                                real multi-line PEM directly) --
//                                `base64 -w0 oci_api_key.pem` to produce it
//   ORACLE_REGION             -- e.g. uk-london-1 (must match the region
//                                the API key + resources below live in)
//   ORACLE_COMPARTMENT_OCID   -- which compartment new instances launch
//                                into (the tenancy's root compartment OCID
//                                is the tenancy OCID itself, if none other
//                                has been set up)
//   ORACLE_SUBNET_OCID        -- an existing VCN subnet to attach to;
//                                this module does not create networking
//   ORACLE_IMAGE_OCID         -- an Ubuntu 24.04 image OCID for
//                                ORACLE_REGION (image OCIDs are
//                                per-region, not portable)
//   ORACLE_SSH_PUBLIC_KEY     -- injected via cloud-init metadata, same
//                                role as hetzner.mjs's account-wide SSH
//                                key list
// Optional:
//   ORACLE_SHAPE              -- default 'VM.Standard.A1.Flex' (the
//                                Always Free ARM shape)
//   ORACLE_AVAILABILITY_DOMAIN -- default: the first AD this tenancy has
//                                in ORACLE_REGION (auto-discovered)

import { createSign, createHash } from 'node:crypto';

const REQUIRED_KEYS = [
  'ORACLE_TENANCY_OCID',
  'ORACLE_USER_OCID',
  'ORACLE_FINGERPRINT',
  'ORACLE_PRIVATE_KEY_B64',
  'ORACLE_REGION',
  'ORACLE_COMPARTMENT_OCID',
  'ORACLE_SUBNET_OCID',
  'ORACLE_IMAGE_OCID',
  'ORACLE_SSH_PUBLIC_KEY',
];

export function requireOracleConfig(secrets) {
  const missing = REQUIRED_KEYS.filter((k) => !secrets[k]);
  if (missing.length) {
    throw new Error(
      `Missing Oracle Cloud config in secrets.env: ${missing.join(', ')}. These come from the OCI console (Identity -> Users -> API Keys for the account-level ones, Compute/Networking for the resource OCIDs) -- see the comment at the top of scripts/lib/oracle.mjs for what each one is and how to get it.`
    );
  }
  return {
    tenancyId: secrets.ORACLE_TENANCY_OCID,
    userId: secrets.ORACLE_USER_OCID,
    fingerprint: secrets.ORACLE_FINGERPRINT,
    privateKey: Buffer.from(secrets.ORACLE_PRIVATE_KEY_B64, 'base64').toString('utf8'),
    region: secrets.ORACLE_REGION,
    compartmentId: secrets.ORACLE_COMPARTMENT_OCID,
    subnetId: secrets.ORACLE_SUBNET_OCID,
    imageId: secrets.ORACLE_IMAGE_OCID,
    sshPublicKey: secrets.ORACLE_SSH_PUBLIC_KEY,
    shape: secrets.ORACLE_SHAPE || 'VM.Standard.A1.Flex',
    availabilityDomain: secrets.ORACLE_AVAILABILITY_DOMAIN || null,
  };
}

const CLOUD_INIT = `#!/bin/bash
set -e
# Oracle's stock Ubuntu image only puts the injected ssh_authorized_keys
# on the "ubuntu" user and rejects direct root login -- every other
# provider (Hetzner/DO) allows root out of the box, and the rest of this
# codebase (ssh.mjs's default user, create-client.mjs/migrate-client.mjs's
# remote commands) assumes root uniformly. Copying the key across here
# once, at boot, keeps that assumption true instead of special-casing
# Oracle everywhere else. Found live, 2026-09-20: a freshly created
# instance was reachable as ubuntu but not root, and every runRemote call
# in the actual migration failed until this was added.
mkdir -p /root/.ssh
cp /home/ubuntu/.ssh/authorized_keys /root/.ssh/authorized_keys
chmod 700 /root/.ssh
chmod 600 /root/.ssh/authorized_keys
# Same story for ports 80/443: Oracle's stock image ships iptables rules
# that only ACCEPT port 22 inbound and REJECT everything else, regardless
# of the OCI-level Security List (a separate, cloud-side firewall) already
# allowing them. Every other provider's stock image has no such local
# firewall. Found live, 2026-09-20: the Security List allowed 80/443 the
# whole time -- Caddy and Let's Encrypt's HTTP-01 challenge still couldn't
# reach the box until these were added here too.
iptables -I INPUT -p tcp -m state --state NEW -m tcp --dport 80 -j ACCEPT
iptables -I INPUT -p tcp -m state --state NEW -m tcp --dport 443 -j ACCEPT
netfilter-persistent save || (mkdir -p /etc/iptables && iptables-save > /etc/iptables/rules.v4)
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

function apiBase(region) {
  return `https://iaas.${region}.oraclecloud.com/20160918`;
}

// OCI HTTP Signatures -- builds the `Authorization` header OCI's API
// requires on every single request. GET signs only date/(request-target)/
// host; anything else (POST/PUT/DELETE) also signs content-length/
// content-type/x-content-sha256 -- and needs those three headers actually
// present on the request too, not just in the signature -- EVEN WHEN THERE
// IS NO REAL BODY (an instance action like ?action=STOP, or a plain
// DELETE). Found live, 2026-09-21, resizing a real running instance:
// omitting these for a bodyless POST gets a flat 401 "Failed to verify the
// HTTP(S) Signature" from OCI, indistinguishable from a genuinely bad key --
// cost real time misdiagnosing it as a credentials problem before noticing
// the actual pattern (GET calls worked fine throughout). Signed as an empty
// string in that case, matching what OCI itself expects to verify against.
function signRequest(config, { method, path, host, body }) {
  const date = new Date().toUTCString();
  const requestTarget = `${method.toLowerCase()} ${path}`;
  const headersToSign = ['date', '(request-target)', 'host'];
  const headerValues = { date, host };
  const extraHeaders = {};

  if (method !== 'GET') {
    const bodyStr = body !== undefined ? JSON.stringify(body) : '';
    const contentLength = Buffer.byteLength(bodyStr).toString();
    const contentType = 'application/json';
    const sha256 = createHash('sha256').update(bodyStr).digest('base64');
    headersToSign.push('content-length', 'content-type', 'x-content-sha256');
    Object.assign(headerValues, { 'content-length': contentLength, 'content-type': contentType, 'x-content-sha256': sha256 });
    Object.assign(extraHeaders, { 'content-length': contentLength, 'content-type': contentType, 'x-content-sha256': sha256 });
  }

  const signingString = headersToSign
    .map((h) => (h === '(request-target)' ? `(request-target): ${requestTarget}` : `${h}: ${headerValues[h]}`))
    .join('\n');
  const signature = createSign('RSA-SHA256').update(signingString).sign(config.privateKey, 'base64');
  const keyId = `${config.tenancyId}/${config.userId}/${config.fingerprint}`;
  const authHeader = `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="${headersToSign.join(' ')}",signature="${signature}"`;

  return { authHeader, date, extraHeaders };
}

async function ociRequest(config, method, path, body) {
  const host = `iaas.${config.region}.oraclecloud.com`;
  // The signed (request-target) has to be the REAL request path OCI
  // receives -- apiBase already bakes /20160918 into the actual URL below,
  // but this was signing the bare `path` without it, so every ociRequest
  // call (createServer/getServer/deleteServer) always failed with "Failed
  // to verify the HTTP(S) Signature", no matter how valid the key was.
  // identityRequest below already got this right; this just matches it.
  const fullPath = `/20160918${path}`;
  const { authHeader, date, extraHeaders } = signRequest(config, { method, path: fullPath, host, body });
  const res = await fetch(`${apiBase(config.region)}${path}`, {
    method,
    headers: { Authorization: authHeader, Date: date, Host: host, ...extraHeaders },
    body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '' : undefined,
  });
  if (!res.ok) throw new Error(`OCI ${method} ${path} failed: ${res.status} ${await res.text()}`);
  if (res.status === 204) return null;
  return res.json();
}

// Identity is a different OCI service (identity.{region}.oraclecloud.com),
// not the iaas.{region}.oraclecloud.com host ociRequest above targets --
// its own minimal signed-GET helper rather than bolting a second host onto
// ociRequest for the one call that needs it.
async function identityRequest(config, path) {
  const host = `identity.${config.region}.oraclecloud.com`;
  const fullPath = `/20160918${path}`;
  const { authHeader, date } = signRequest(config, { method: 'GET', path: fullPath, host });
  const res = await fetch(`https://${host}${fullPath}`, { method: 'GET', headers: { Authorization: authHeader, Date: date, Host: host } });
  if (!res.ok) throw new Error(`OCI identity GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getAvailabilityDomain(config) {
  if (config.availabilityDomain) return config.availabilityDomain;
  const domains = await identityRequest(config, `/availabilityDomains?compartmentId=${config.compartmentId}`);
  if (!domains?.length) throw new Error(`No availability domains found for compartment ${config.compartmentId} in ${config.region}.`);
  return domains[0].name;
}

// config comes from requireOracleConfig(secrets) -- not a raw token like
// the other two providers, since OCI needs the whole key/tenancy bundle
// for every request, not one bearer value.
export async function createServer(config, { name, size = 'small' }) {
  const availabilityDomain = await getAvailabilityDomain(config);
  // size is ignored for the Always Free shape (A1.Flex's OCPU/memory are
  // fixed by the free-tier limits, not selectable the way Hetzner's
  // small/medium/large server types are) -- kept as a parameter anyway so
  // create-client.mjs's call site doesn't need a provider-specific branch
  // just to pass --size through.
  const instance = await ociRequest(config, 'POST', '/instances', {
    compartmentId: config.compartmentId,
    availabilityDomain,
    displayName: name,
    shape: config.shape,
    shapeConfig: config.shape.endsWith('.Flex') ? { ocpus: 1, memoryInGBs: 6 } : undefined,
    sourceDetails: { sourceType: 'image', imageId: config.imageId },
    createVnicDetails: { subnetId: config.subnetId, assignPublicIp: true },
    metadata: { ssh_authorized_keys: config.sshPublicKey, user_data: Buffer.from(CLOUD_INIT).toString('base64') },
  });
  return instance.id;
}

export async function getServer(config, instanceId) {
  return ociRequest(config, 'GET', `/instances/${instanceId}`);
}

async function getPublicIp(config, instanceId) {
  const attachments = await ociRequest(config, 'GET', `/vnicAttachments?compartmentId=${config.compartmentId}&instanceId=${instanceId}`);
  const vnicId = attachments?.[0]?.vnicId;
  if (!vnicId) return null;
  const vnic = await ociRequest(config, 'GET', `/vnics/${vnicId}`);
  return vnic?.publicIp || null;
}

export async function waitForServerActive(config, instanceId, { timeoutMs = 5 * 60 * 1000, intervalMs = 8000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const instance = await getServer(config, instanceId);
    if (instance.lifecycleState === 'RUNNING') {
      const ip = await getPublicIp(config, instanceId);
      if (ip) return ip;
    }
    if (instance.lifecycleState === 'TERMINATED' || instance.lifecycleState === 'TERMINATING') {
      throw new Error(`OCI instance ${instanceId} moved to ${instance.lifecycleState} instead of coming up -- check the OCI console for why (quota, capacity, a bad image/shape combination are the common ones).`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`OCI instance ${instanceId} did not become RUNNING with a public IP within ${timeoutMs}ms`);
}

export async function deleteServer(config, instanceId) {
  try {
    await ociRequest(config, 'DELETE', `/instances/${instanceId}?preserveBootVolume=false`);
  } catch (err) {
    if (!err.message.includes(' 404 ')) throw err;
  }
}

export async function stopServer(config, instanceId) {
  await ociRequest(config, 'POST', `/instances/${instanceId}?action=STOP`);
}

export async function startServer(config, instanceId) {
  await ociRequest(config, 'POST', `/instances/${instanceId}?action=START`);
}

// Changing ocpus/memoryInGBs requires the instance to be STOPPED first --
// OCI accepts the PUT while running but the new shape never actually takes
// effect until the next stop/start cycle, so this does the full sequence
// itself rather than leaving a caller to discover that the hard way.
// Found live, 2026-09-21: even after the instance reports STOPPED, a START
// immediately after the shape PUT can 409 ("currently being modified, try
// again later") for a few seconds while OCI finishes applying it --
// startServer here is retried on 409 specifically, not just once.
export async function resizeServer(config, instanceId, { ocpus, memoryInGBs }, { timeoutMs = 5 * 60 * 1000, intervalMs = 8000 } = {}) {
  await stopServer(config, instanceId);
  let start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const instance = await getServer(config, instanceId);
    if (instance.lifecycleState === 'STOPPED') break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  await ociRequest(config, 'PUT', `/instances/${instanceId}`, { shapeConfig: { ocpus, memoryInGBs } });

  start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await startServer(config, instanceId);
      break;
    } catch (err) {
      if (!err.message.includes(' 409 ')) throw err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const instance = await getServer(config, instanceId);
    if (instance.lifecycleState === 'RUNNING') return instance.shapeConfig;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`OCI instance ${instanceId} did not return to RUNNING within ${timeoutMs}ms after resize`);
}
