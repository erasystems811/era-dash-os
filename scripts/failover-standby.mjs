#!/usr/bin/env node
// Usage:
//   node failover-standby.mjs --to=standby   (dash.erasystems.com.ng -> the standby server)
//   node failover-standby.mjs --to=primary   (switch back)
//
// The actual "flip the switch" step discussed at length: dash.erasystems.
// com.ng (the ONE address Meta's shared WhatsApp app, the ERA Dash OS
// panel, and everything EBOS calls home) is a DNS record, not hardwired to
// one server. This deletes the current A record and adds a new one
// pointing at the other server -- Meta and every business's browser just
// keep calling the same address; only where it resolves to changes.
//
// Uses a short (300s) TTL on every write from here on, not DirectAdmin's
// 3600s default -- once that's in place, a real failover during an actual
// outage propagates in ~5 minutes instead of up to an hour.
//
// Run scripts/sync-standby.mjs before this if it's been a while -- this
// only repoints DNS, it does not sync code/registry/secrets to the
// standby first.

import { loadSecrets } from './lib/secrets.mjs';
import { addARecord, deleteARecord } from './lib/dns.mjs';

// Verified live, 2026-09-21: dash.erasystems.com.ng actually resolves to
// 145.241.212.131 (era-control itself) -- a prior edit here had this as
// 167.233.242.179, which would have deleted the wrong A record (or failed
// outright) on a real failover.
const PRIMARY_IP = '145.241.212.131';
// Standby rebuilt on Oracle 2026-09-21 ("era-standby") after the old
// 91.99.139.215 box was destroyed -- keep this in sync with the address
// in sync-standby.mjs.
const STANDBY_IP = '145.241.193.64';
const DOMAIN = 'erasystems.com.ng';
const HOSTNAME = 'dash';
const SHORT_TTL = 300;

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (arg.startsWith('--to=')) args.to = arg.slice('--to='.length);
  }
  if (args.to !== 'standby' && args.to !== 'primary') {
    throw new Error('Usage: failover-standby.mjs --to=standby | --to=primary');
  }
  return args;
}

async function main() {
  const { to } = parseArgs(process.argv.slice(2));
  const targetIp = to === 'standby' ? STANDBY_IP : PRIMARY_IP;
  const currentIp = to === 'standby' ? PRIMARY_IP : STANDBY_IP;

  const secrets = loadSecrets();
  const creds = { host: secrets.DA_HOST, username: secrets.DA_USERNAME, loginKey: secrets.DA_LOGIN_KEY };

  console.log(`Switching ${HOSTNAME}.${DOMAIN} from ${currentIp} to ${targetIp}...`);
  await deleteARecord(creds, DOMAIN, HOSTNAME, currentIp);
  await addARecord(creds, DOMAIN, HOSTNAME, targetIp, SHORT_TTL);
  console.log(`Done. DNS now points ${HOSTNAME}.${DOMAIN} at ${targetIp} (TTL ${SHORT_TTL}s -- expect full propagation within a few minutes).`);
  console.log(`Verify: curl -s -o /dev/null -w '%{http_code}\\n' -u admin:<password> https://${HOSTNAME}.${DOMAIN}/`);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
