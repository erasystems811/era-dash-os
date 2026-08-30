#!/usr/bin/env node
// Usage: node sync-standby.mjs
//
// Keeps the standby control server (era-relay-standby, a second copy of
// this exact control plane on its own separate server/IP) up to date with
// the primary -- code, registry.json, and secrets.env. Run this any time
// after a real change (a new business, a rotated secret, a code push) so
// the standby is never more than one sync behind. Safe to run any time --
// one-directional (primary -> standby), never touches the primary, and
// the standby isn't serving real traffic unless someone deliberately
// points dash.erasystems.com.ng at it (see failover-standby.mjs).

import { execFileSync } from 'node:child_process';

const STANDBY_IP = '91.99.139.215';
const SSH_OPTS = ['-o', 'StrictHostKeyChecking=no'];

function run(cmd, args) {
  console.log(`  ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit' });
}

function main() {
  console.log('Syncing era-dash-os code to standby...');
  run('rsync', ['-az', '--exclude', 'node_modules', '--exclude', '.git', '-e', `ssh ${SSH_OPTS.join(' ')}`, '/opt/era-control/era-dash-os/', `root@${STANDBY_IP}:/opt/era-control/era-dash-os/`]);

  console.log('Syncing registry.json and secrets.env...');
  run('scp', [...SSH_OPTS, '/opt/era-control/registry.json', `root@${STANDBY_IP}:/opt/era-control/registry.json`]);
  run('scp', [...SSH_OPTS, '/opt/era-control/secrets.env', `root@${STANDBY_IP}:/opt/era-control/secrets.env`]);

  console.log('Installing any new dependencies and restarting the standby panel...');
  run('ssh', [...SSH_OPTS, `root@${STANDBY_IP}`, 'cd /opt/era-control/era-dash-os/panel && npm install --production && systemctl restart era-dash-panel.service']);

  console.log('Standby sync complete.');
}

main();
