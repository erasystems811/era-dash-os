#!/usr/bin/env node
// Usage: OVH_APPLICATION_KEY=xxx OVH_APPLICATION_SECRET=xxx node ovh-get-consumer-key.mjs
//
// One-time, interactive. OVH's Consumer Key can't be generated purely by
// script the way Hetzner/DigitalOcean tokens can -- a human has to open a
// URL OVH hands back and click "authorize" before the key actually works.
// This script does the one API call that starts that flow, prints the
// URL, waits for Enter, then prints the real Consumer Key to paste into
// the panel's "OVH credentials" form (or straight into secrets.env as
// OVH_CONSUMER_KEY) -- see scripts/lib/ovh.mjs's header comment for what
// else is needed alongside it.
//
// Requests full read/write on /cloud/* only -- everything create-client.mjs
// and teardown-client.mjs need (instances, images, flavors, SSH keys) and
// nothing broader than that.

import readline from 'node:readline/promises';

const ENDPOINTS = {
  'ovh-eu': 'https://eu.api.ovh.com/1.0',
  'ovh-us': 'https://api.us.ovhcloud.com/1.0',
  'ovh-ca': 'https://ca.api.ovh.com/1.0',
};

async function main() {
  const applicationKey = process.env.OVH_APPLICATION_KEY;
  const applicationSecret = process.env.OVH_APPLICATION_SECRET;
  const endpoint = process.env.OVH_ENDPOINT || 'ovh-eu';
  if (!applicationKey || !applicationSecret) {
    throw new Error('Set OVH_APPLICATION_KEY and OVH_APPLICATION_SECRET (from https://eu.api.ovh.com/createApp) as environment variables before running this.');
  }
  const base = ENDPOINTS[endpoint];
  if (!base) throw new Error(`Unknown OVH_ENDPOINT "${endpoint}" -- must be one of ${Object.keys(ENDPOINTS).join(', ')}.`);

  const res = await fetch(`${base}/auth/credential`, {
    method: 'POST',
    headers: { 'X-Ovh-Application': applicationKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accessRules: [
        { method: 'GET', path: '/cloud/*' },
        { method: 'POST', path: '/cloud/*' },
        { method: 'PUT', path: '/cloud/*' },
        { method: 'DELETE', path: '/cloud/*' },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OVH POST /auth/credential failed: ${res.status} ${await res.text()}`);
  const { consumerKey, validationUrl } = await res.json();

  console.log(`\nOpen this URL and click "authorize" (log in to OVH if asked):\n\n  ${validationUrl}\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Press Enter once you have authorized it... ');
  rl.close();

  console.log(`\nOVH_CONSUMER_KEY=${consumerKey}\n`);
  console.log('Paste this into the panel\'s "OVH credentials" form, or add it to secrets.env directly.');
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
