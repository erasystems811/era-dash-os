#!/usr/bin/env node
// Usage: node restart-fixbot.mjs
//
// The self-service version of "SSH in and restart era-fixbot.service" --
// runs ON the control server already (via panel/jobs.mjs's startJob, same
// mechanism as every other panel button), so this never needs SSH from
// anywhere. Restarts, waits briefly, then confirms the service is
// actually back up via its own /healthz -- a "systemctl restart" that
// silently leaves a crash-looping service isn't actually a successful
// restart, so this doesn't report done until healthz answers for real.
import { execSync } from 'node:child_process';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log('Restarting era-fixbot.service...');
execSync('systemctl restart era-fixbot.service');

await wait(2000);

const active = execSync('systemctl is-active era-fixbot.service', { encoding: 'utf8' }).trim();
console.log('Service status:', active);
if (active !== 'active') {
  console.error('Service did not come up active.');
  process.exit(1);
}

try {
  const res = await fetch('http://127.0.0.1:4200/healthz', { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`healthz returned ${res.status}`);
  console.log('healthz OK -- fixbot is back up and responding.');
} catch (err) {
  console.error(`Service is active but healthz check failed: ${err.message}`);
  process.exit(1);
}
