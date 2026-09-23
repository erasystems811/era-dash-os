#!/usr/bin/env node
// Usage: node restart-panel.mjs
//
// Self-service restart for the panel's OWN process -- era-dash-panel.
// service, same "no SSH, no asking Claude" reasoning as
// restart-fixbot.mjs, but for the one process that's actually running
// this button. Chidera, 2026-09-23: real gap hit live -- panel/server.js
// only ever takes effect on its next restart (sync-code.mjs pulls new
// files immediately, but can't make the currently-running process re-read
// its own source), and there was no self-service way to do that restart
// at all before this, only SSH (which she's ruled out entirely).
//
// Deliberately does NOT try to report success back through the normal
// job-polling mechanism (panel/jobs.mjs's in-memory `jobs` Map) -- that
// Map lives inside the very process this script kills, so any poll for
// THIS job's status after the restart fires is querying a brand new
// process with no memory of it. panel/server.js's own /api/panel/restart
// route handles this by responding to the browser BEFORE triggering the
// restart, and the client-side JS polls plain GET / directly (not
// pollJob) until it's back, exactly like this script's own healthz-style
// check below.
import { execSync } from 'node:child_process';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log('Restarting era-dash-panel.service...');
execSync('systemctl restart era-dash-panel.service');

await wait(2000);

const active = execSync('systemctl is-active era-dash-panel.service', { encoding: 'utf8' }).trim();
console.log('Service status:', active);
if (active !== 'active') {
  console.error('Service did not come up active.');
  process.exit(1);
}

try {
  const res = await fetch(`http://127.0.0.1:${process.env.PORT || 4100}/`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`home page returned ${res.status}`);
  console.log('Panel is back up and responding.');
} catch (err) {
  console.error(`Service is active but the panel isn't responding yet: ${err.message}`);
  process.exit(1);
}
