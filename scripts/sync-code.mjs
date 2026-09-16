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
// Deliberately just `git pull` by default -- no force, no reset, no
// stashing away local changes. If the control server's checkout has
// uncommitted local edits that would conflict, this fails loudly (git's
// own error) rather than silently discarding something. That's a real
// scenario worth knowing about, not one to paper over.
//
// --discard-conflicts is the one opt-in exception (Chidera's panel is a
// deploy target, never a place for real local work -- any uncommitted
// diff there is leftover cruft, e.g. a file scp'd on as a one-off fix
// instead of going through git, same class of bug this script exists to
// prevent). Found live, 2026-09-16: exactly that -- a handful of
// dashboard files had been copied straight onto the control server
// earlier, and the next plain `git pull` refused with "local changes...
// would be overwritten by merge", blocking every future sync until
// someone with SSH could clear it by hand. Still opt-in, still narrow:
// only `git checkout --` the SPECIFIC files git's own error names as
// conflicting, never a blanket reset, and only when this flag is passed
// -- the default run above still fails loudly for anyone who hasn't
// explicitly asked for automatic recovery.
//
// Does NOT restart the panel process itself -- panel/server.js's own code
// only takes effect on its next restart (a separate, deliberate action,
// not implied by a code sync). Scripts under scripts/ (like this one, or
// backup-all-clients.mjs) are spawned fresh per run by jobs.mjs, so THEY
// pick up the new code immediately, no restart needed.
//
// Found broken live, 2026-09-16: the very first click of the panel's own
// "Sync latest code" button failed with "fatal: not a git repository" --
// the control server's era-dash-os folder had been deployed by copying
// files there directly at some point, never `git clone`'d, so a plain
// `git pull` had nothing to pull INTO. One-time self-healing bootstrap
// below fixes this on whichever run first discovers it missing, then
// behaves as a normal git checkout (including this same script's own
// future runs) from then on -- no separate manual step, no SSH.
//
// The bootstrap uses `git reset` (not `--hard`, not `checkout -B`)
// deliberately: it points HEAD/the index at origin/main WITHOUT touching
// a single file in the working tree. Since the directory's actual file
// contents should already match what was deployed, this makes git aware
// of that state as a real commit rather than silently overwriting
// anything -- if the live files DO differ from origin/main for any
// reason, that becomes a normal, visible `git status`/`git diff`
// afterward (and a later plain `git pull` would correctly refuse rather
// than clobber it), not something bootstrapping silently destroys.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REMOTE_URL = 'https://github.com/erasystems811/era-dash-os.git';

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

async function bootstrapIfNeeded() {
  if (existsSync(path.join(REPO_DIR, '.git'))) return false;
  console.log(`${REPO_DIR} is not a git repository yet -- bootstrapping it against ${REMOTE_URL} (working tree files are left untouched)...`);
  await run('git', ['init', '-q']);
  await run('git', ['remote', 'add', 'origin', REMOTE_URL]);
  await run('git', ['fetch', '-q', 'origin', 'main']);
  await run('git', ['reset', 'origin/main']);
  console.log('Bootstrap done.');
  return true;
}

// Git's own "local changes... would be overwritten by merge" error lists
// exactly which tracked files are the problem, one per indented line,
// right after this header line -- e.g.:
//   error: Your local changes to the following files would be overwritten by merge:
//   \tpanel/server.js
//   \tebos-templates/dashboard/routes/api.js
//   Please commit your changes or stash them before you merge.
// Parsed out rather than guessed so --discard-conflicts only ever touches
// the files git itself named, never anything broader.
function parseConflictingFiles(gitErrorMessage) {
  const match = gitErrorMessage.match(/would be overwritten by merge:\n([\s\S]+?)\nPlease/);
  if (!match) return null;
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function main(argv = []) {
  const discardConflicts = argv.includes('--discard-conflicts');
  const justBootstrapped = await bootstrapIfNeeded();
  const before = (await run('git', ['rev-parse', 'HEAD'])).trim();

  try {
    console.log(await run('git', ['pull', '--ff-only', 'origin', 'main']));
  } catch (err) {
    const conflicting = discardConflicts ? parseConflictingFiles(err.message) : null;
    if (!conflicting) throw err;
    console.log(`Discarding uncommitted local changes to ${conflicting.length} file(s) that were blocking the pull:`);
    console.log(conflicting.map((f) => `  ${f}`).join('\n'));
    await run('git', ['checkout', '--', ...conflicting]);
    console.log(await run('git', ['pull', '--ff-only', 'origin', 'main']));
  }

  const after = (await run('git', ['rev-parse', 'HEAD'])).trim();
  if (before === after) {
    console.log(justBootstrapped ? 'Bootstrapped at the current commit -- nothing new to pull yet.' : 'Already up to date.');
    return;
  }
  console.log(`Updated ${before.slice(0, 7)} -> ${after.slice(0, 7)}. Changed:`);
  console.log(await run('git', ['diff', '--stat', before, after]));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
  });
}
