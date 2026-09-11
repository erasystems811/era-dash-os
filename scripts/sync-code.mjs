#!/usr/bin/env node
// Usage: node sync-code.mjs
//
// Pulls the latest era-dash-os code from origin/main onto whichever
// server this runs on -- meant to be run FROM the panel itself (see
// panel/server.js's /api/sync-code, wired to a "Sync latest code" button)
// so getting a new script/route/fix onto the control server is a click,
// not an SSH session. Chidera's own words, 2026-09-11: "i cant use ssh...
// i told it to build alternative ways."
//
// Deliberately just `git pull` -- no force, no reset, no stashing away
// local changes. If the control server's checkout has uncommitted local
// edits that would conflict, this fails loudly (git's own error) rather
// than silently discarding something. That's a real scenario worth
// knowing about, not one to paper over.
//
// Does NOT restart the panel process itself -- panel/server.js's own code
// only takes effect on its next restart (a separate, deliberate action,
// not implied by a code sync). Scripts under scripts/ (like this one, or
// backup-all-clients.mjs) are spawned fresh per run by jobs.mjs, so THEY
// pick up the new code immediately, no restart needed.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: REPO_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || stdout || `${cmd} ${args.join(' ')} exited ${code}`));
    });
  });
}

export async function main() {
  const before = (await run('git', ['rev-parse', 'HEAD'])).trim();
  console.log(await run('git', ['pull', '--ff-only', 'origin', 'main']));
  const after = (await run('git', ['rev-parse', 'HEAD'])).trim();
  if (before === after) {
    console.log('Already up to date.');
    return;
  }
  console.log(`Updated ${before.slice(0, 7)} -> ${after.slice(0, 7)}. Changed:`);
  console.log(await run('git', ['diff', '--stat', before, after]));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
  });
}
