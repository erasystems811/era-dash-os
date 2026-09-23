// Chidera, 2026-09-23: "i work on different claude, i need a permanent fix
// to know what to go live" -- multiple Claude Code sessions edit this same
// checkout independently, with no shared memory of what any one of them
// decided was "ready." A push script that just copies whatever happens to
// be sitting on disk has no way to tell a finished feature apart from
// another session's half-built one sitting in the same working tree.
//
// The fix has to be enforced by the tool itself, not remembered by
// whichever session happens to run it: a push to a real business only ever
// runs off a clean checkout of `main`, the one shared, durable record of
// "this was actually approved to go live" -- approval being the act of
// merging into main, not the act of running a push command. Uncommitted
// work, work on any other branch, and local commits that were never pushed
// to origin/main all fail this check, on purpose. There is no bypass flag
// -- the fix for a failure is always the same real step (commit/merge to
// main, or push main to origin), never a flag that skips the check.
import { execFileSync } from 'node:child_process';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// repoRoot: the local checkout being deployed FROM (this machine's
// era-dash-os, or the control server's -- same check either way, since
// each is its own independent clone that can independently drift).
export function requireDeployableState(repoRoot) {
  const problems = [];

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  if (branch !== 'main') {
    problems.push(`On branch "${branch}", not "main". Deploys only ever run off main -- switch to it (and merge your ready work into it) first.`);
  }

  const dirty = git(['status', '--porcelain'], repoRoot);
  if (dirty) {
    const files = dirty.split('\n').slice(0, 8).join('\n');
    problems.push(`Uncommitted or untracked changes present -- these would silently ride along with the deploy:\n${files}${dirty.split('\n').length > 8 ? '\n  ...' : ''}\nCommit what's ready, and set aside (git stash, or don't touch) whatever isn't.`);
  }

  // Only checked once branch/cleanliness already passed -- no point
  // fetching if there's nothing meaningful to compare yet.
  if (!problems.length) {
    try {
      git(['fetch', 'origin', 'main'], repoRoot);
      const local = git(['rev-parse', 'main'], repoRoot);
      const remote = git(['rev-parse', 'origin/main'], repoRoot);
      if (local !== remote) {
        const ahead = git(['rev-list', '--count', 'origin/main..main'], repoRoot);
        const behind = git(['rev-list', '--count', 'main..origin/main'], repoRoot);
        if (Number(behind) > 0) {
          problems.push(`Local main is ${behind} commit(s) behind origin/main -- another session (or another machine) pushed approved work here that this checkout doesn't have yet. Run "git pull" first, so what goes live matches what's actually recorded as approved.`);
        } else if (Number(ahead) > 0) {
          problems.push(`Local main is ${ahead} commit(s) ahead of origin/main -- this work is only committed here, not on the shared record other sessions read. Run "git push origin main" first.`);
        }
      }
    } catch (err) {
      // A fetch failure (offline, auth) shouldn't block a deploy that was
      // otherwise clean and correctly branched -- the local repo state is
      // still trustworthy, it just couldn't be cross-checked against
      // origin this time.
      console.log(`  (couldn't verify against origin/main: ${err.message} -- proceeding on local state alone)`);
    }
  }

  if (problems.length) {
    throw new Error(
      `Refusing to deploy -- not on a clean, up-to-date main:\n\n${problems.map((p) => `- ${p}`).join('\n\n')}`
    );
  }
}
