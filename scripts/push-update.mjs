#!/usr/bin/env node
// Usage:
//   node push-update.mjs --client=slug
//   node push-update.mjs --all-ebos
//
// Pushes the CURRENT dashboard app code to an already-live client's server
// -- for rolling out a bot behavior fix (wording rule, flow bug, timing
// change, etc.) to businesses that are already running, once it's been
// tested and corrected in the template itself.
//
// Deliberately narrow: copies the dashboard/ folder and rebuilds only the
// dashboard container. Nothing else -- never docker-compose.yml, never
// Caddyfile, never .env, never the database.
//
// The first version of this script also re-rendered docker-compose.yml/
// Caddyfile/.env from the template on every push, on the theory that
// reusing the server's own existing values would reproduce them as-is.
// That was wrong and it broke era-demo's live WhatsApp connection
// (2026-08-20): META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, and
// META_WEBHOOK_VERIFY_TOKEN (and the Chowdeck delivery keys) are NOT
// template placeholders -- they're hardcoded blank in .env.template and
// only ever get filled in later, directly on the server, by a separate
// one-off step (add-whatsapp.mjs, Embedded Signup, a manual Chowdeck
// setup). Re-rendering the template silently overwrote those with blanks.
// Never re-render or touch .env / docker-compose.yml / Caddyfile from this
// script again -- if the infra template itself genuinely needs to change
// for a live business, that's its own deliberate, reviewed step, the same
// way migrate.mjs is a separate deliberate step from a code push.
//
// You choose who gets touched, always -- --client targets exactly one
// business, --all-ebos targets every one marked isEbos, and nothing
// outside that list is ever pushed to. A business you didn't target keeps
// running whatever it already had; that's a deliberate rollout choice
// (not every business may be ready for an update at once), not a
// consistency gap -- it's still the one shared codebase, just an earlier
// point of it, until you decide to push there too.
//
// Whichever businesses you DO target, this refuses to call the job done
// on a transient hiccup -- a flaky SSH connection or a slow docker build
// gets retried, not shrugged off and left for you to notice and re-run
// later. A business only ends up reported FAILED after MAX_ATTEMPTS
// genuinely didn't work, which should mean something is really wrong on
// that server, not "the network blipped once."

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { loadRegistry, saveRegistry, upsertClient } from './lib/registry.mjs';
import { templatesDirFor } from './lib/templates-dir.mjs';
import { runRemote, copyToRemote } from './lib/ssh.mjs';
import { requireDeployableState } from './lib/deploy-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [5000, 15000]; // between attempt 1->2, then 2->3

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (arg.startsWith('--client=')) args.client = arg.slice('--client='.length);
    else if (arg === '--all-ebos') args.allEbos = true;
    else if (arg.startsWith('--branch=')) args.branch = arg.slice('--branch='.length);
  }
  if (!args.client && !args.allEbos) {
    throw new Error('Usage: push-update.mjs --client=slug [--branch=name] | --all-ebos');
  }
  if (args.client && args.allEbos) {
    throw new Error('Pass either --client=slug or --all-ebos, not both.');
  }
  if (args.branch && args.allEbos) {
    throw new Error('--branch only makes sense with a single --client target, never --all-ebos.');
  }
  return args;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// Chidera, 2026-09-23, real live incident: a bulk push meant to go to a
// sandbox client only actually went out to every real business instead
// (the sandbox exclusion protects --all-ebos from including a sandbox --
// it does nothing for a single mistargeted --client push). This is the
// fix for the actual thing she needed: testing in-progress work (a
// feature branch, not yet merged to main) against a real sandbox
// deployment, without ever touching main or any real client's code.
//
// Deliberately its own guarded path, not a generic "push any branch
// anywhere": only reachable when the single target is a client already
// marked sandbox:true (checked in main() before this is ever called) --
// requireDeployableState's own main-branch requirement for a REAL client
// stays absolute, this never bypasses it for one.
//
// try/finally, not try/catch -- whatever happens (the push itself throws,
// a network blip, anything), the control server's own checkout ALWAYS
// ends back on main, pulled fresh. That's the actual safety property:
// even if this whole function throws, there is no window afterward where
// the next unrelated push (to a real client, by anyone, possibly a
// different Claude session with no memory of this one) could silently
// pick up the wrong branch. No manual "remember to switch back" step for
// a human OR another session to forget.
async function pushBranchToSandboxClient(client, branch) {
  const originalBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], REPO_ROOT);
  const originalDirty = git(['status', '--porcelain'], REPO_ROOT);
  if (originalDirty) {
    throw new Error(`Refusing to switch branches with uncommitted changes present on the control server's checkout:\n${originalDirty}\nCommit or stash these first -- a branch switch here would silently carry them along or lose them.`);
  }
  console.log(`  Checking out ${branch} (will restore ${originalBranch} afterward, no matter what happens)...`);
  git(['fetch', 'origin', branch], REPO_ROOT);
  git(['checkout', branch], REPO_ROOT);
  git(['reset', '--hard', `origin/${branch}`], REPO_ROOT);
  try {
    await attemptPush(client);
    console.log(`  Done: https://${client.subdomain} (from branch "${branch}")`);
  } finally {
    console.log(`  Restoring control server checkout to ${originalBranch}...`);
    git(['checkout', originalBranch], REPO_ROOT);
    if (originalBranch === 'main') {
      try {
        git(['pull', 'origin', 'main'], REPO_ROOT);
      } catch (err) {
        console.error(`  (checked out main but couldn't pull: ${err.message} -- check this by hand)`);
      }
    }
  }
}

async function attemptPush(client) {
  // Was `client.isEbos ? 'ebos' : 'default'` -- silently wrong for any
  // other template (ESF included): it would have copied templates/
  // dashboard/ (the bare generic single-file starter) onto a real ESF
  // client's server, overwriting its actual app. Caught before ever
  // running this against esf-demo. Extend this ternary, don't reintroduce
  // it, the next time a third template type exists.
  const TEMPLATES_DIR = templatesDirFor(client.isEbos ? 'ebos' : client.isEsf ? 'esf' : 'default');
  const ip = client.ip;
  const remoteDir = `/opt/${client.name}`;

  await runRemote(ip, `mkdir -p ${remoteDir}/dashboard`);
  await copyToRemote(ip, path.join(TEMPLATES_DIR, 'dashboard'), `${remoteDir}/`, { recursive: true });
  await runRemote(ip, `cd ${remoteDir} && docker compose up -d --build dashboard`);
}

async function pushToOne(client) {
  if (client.customDeploy) {
    console.log(`\n=== ${client.name} ===\n  skip: runs a custom app deploy, not the standard template.`);
    return { name: client.name, ok: false, skipped: true };
  }

  console.log(`\n=== ${client.name} (${client.ip}) ===`);
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) console.log(`  Retry ${attempt}/${MAX_ATTEMPTS}...`);
      else console.log('  Copying updated app code to the server (docker-compose.yml, Caddyfile, and .env are left untouched)...');
      await attemptPush(client);
      console.log(`  Done: https://${client.subdomain}`);
      return { name: client.name, ok: true, attempts: attempt };
    } catch (err) {
      lastErr = err;
      console.error(`  Attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) {
        const delay = RETRY_DELAYS_MS[attempt - 1];
        console.log(`  Waiting ${delay / 1000}s before retrying...`);
        await wait(delay);
      }
    }
  }
  console.error(`  FAILED after ${MAX_ATTEMPTS} attempts: ${lastErr.message}`);
  return { name: client.name, ok: false, error: lastErr.message, attempts: MAX_ATTEMPTS };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = loadRegistry();

  let targets;
  if (args.allEbos) {
    // sandbox clients (era-sandbox) are deliberately excluded from a bulk
    // push -- Chidera, 2026-09-22, after an unfinished feature (real
    // customer-facing "web chat" build) turned out to only be meant for
    // era-demo but the lack of any real separation between "testing" and
    // "live" made that a live worry, not a hypothetical one. A sandbox
    // client only ever gets code via --client=<sandbox-name>, explicitly,
    // never swept in by --all-ebos alongside real businesses. See
    // create-client.mjs's --sandbox flag for how a client gets this flag.
    targets = registry.clients.filter((c) => c.isEbos && !c.sandbox);
    if (!targets.length) throw new Error('No client in the registry is marked isEbos: true (excluding sandbox clients).');
    console.log(`Pushing update to ${targets.length} EBOS business(es)...`);
  } else {
    const client = registry.clients.find((c) => c.name === args.client);
    if (!client) throw new Error(`No client "${args.client}" in the registry.`);
    targets = [client];
  }

  // Chidera, 2026-09-23: "i work on different claude, i need a permanent
  // fix to know what to go live." Only guarded for a REAL business -- a
  // sandbox client is exactly where in-progress, not-yet-committed work is
  // supposed to go, freely, so requiring a clean main here would defeat
  // the sandbox's own purpose. See deploy-guard.mjs's own header for what
  // this actually checks and why it has no bypass flag.
  if (targets.some((c) => !c.sandbox)) {
    requireDeployableState(REPO_ROOT);
  }

  // --branch: real, in-progress feature work (a branch not yet merged to
  // main) tested against an actual sandbox deployment. Restricted to
  // exactly one target, and that target must already be sandbox:true --
  // this is deliberately not a general "deploy any branch anywhere"
  // escape hatch. See pushBranchToSandboxClient's own comment for the
  // safety property (the checkout always ends back on main, even if this
  // throws).
  if (args.branch) {
    if (targets.length !== 1 || !targets[0].sandbox) {
      throw new Error('--branch only works with a single --client target that is already marked sandbox:true.');
    }
    console.log(`\n=== ${targets[0].name} (${targets[0].ip}) -- from branch "${args.branch}" ===`);
    await pushBranchToSandboxClient(targets[0], args.branch);
    upsertClient(registry, { name: targets[0].name, lastPushedAt: new Date().toISOString() });
    saveRegistry(registry);
    return;
  }

  const results = [];
  for (const client of targets) {
    results.push(await pushToOne(client));
  }

  const now = new Date().toISOString();
  for (const r of results) {
    if (r.ok) upsertClient(registry, { name: r.name, lastPushedAt: now });
  }
  saveRegistry(registry);

  console.log('\n=== Summary ===');
  for (const r of results) {
    const retriedNote = r.ok && r.attempts > 1 ? ` (needed ${r.attempts} attempts)` : '';
    const status = r.ok ? `ok${retriedNote}` : r.skipped ? 'skipped' : `FAILED after ${MAX_ATTEMPTS} attempts (${r.error})`;
    console.log(`  ${r.name}: ${status}`);
  }

  const hardFailures = results.filter((r) => !r.ok && !r.skipped);
  if (hardFailures.length) process.exit(1);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
