#!/usr/bin/env node
// Usage: node scaffold-bot.mjs --client=slug
//
// Makes the bot-engine building blocks available to a client's WhatsApp bot
// -- pushes bot-engine/lib/*.js into the client's repo and server, and drops
// a starter flow/index.js pointing at them. Does NOT generate any
// conversation flow -- no states, no fields, no business rules. That part
// stays hand-written, on top of these building blocks. Safe to re-run: it
// never overwrites flow/index.js once it exists, so it can't clobber
// hand-written flow logic.
//
// Runs automatically from create-client.mjs when --whatsapp is passed, and
// from add-whatsapp.mjs when WhatsApp is added to an existing client later.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { loadRegistry, saveRegistry, findClient, upsertClient } from './lib/registry.mjs';
import { loadSecrets, requireSecrets } from './lib/secrets.mjs';
import * as github from './lib/github.mjs';
import { runRemote, copyToRemote } from './lib/ssh.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOT_ENGINE_DIR = path.join(__dirname, '..', 'bot-engine');

const FLOW_STARTER = `// Write this client's WhatsApp bot conversation flow here: the stages, the
// questions, the business rules. This is hand-written, on purpose -- it is
// not generated from a spec.
//
// Use the building blocks in ../bot-engine/ instead of writing your own
// extraction/state-tracking/send logic from scratch:
//   import { defineStates, defineField, extractField, sendMessage, ... } from '../bot-engine/index.js';
//
// See ../bot-engine/README.md for what each function enforces and why, and
// ../bot-conversation-rules.md for the full reasoning behind each rule.

import * as botEngine from '../bot-engine/index.js';

// TODO: define this client's states, e.g.
// export const states = botEngine.defineStates({ ... });

// TODO: define this client's fields, e.g.
// const eventDate = botEngine.defineField({ key: 'event_date', label: 'event date', type: 'date' });

// TODO: write the actual message-handling flow.
`;

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    args[key] = rest.join('=');
  }
  if (!args.client) throw new Error('Usage: scaffold-bot.mjs --client=slug');
  return args;
}

function repoOwnerAndName(client) {
  if (!client.repo) return null;
  const match = client.repo.match(/github\.com\/([^/]+)\/([^/]+)/);
  return match ? { owner: match[1], repo: match[2] } : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = loadRegistry();
  const client = findClient(registry, args.client);
  if (!client) throw new Error(`No client "${args.client}" in the registry.`);

  const libFiles = readdirSync(path.join(BOT_ENGINE_DIR, 'lib')).filter((f) => f.endsWith('.js') && !f.endsWith('.test.mjs'));

  // 1. Push bot-engine/lib to the client's GitHub repo, if it has one.
  const secrets = loadSecrets();
  const repoInfo = repoOwnerAndName(client);
  if (repoInfo) {
    requireSecrets(secrets, ['GITHUB_TOKEN']);
    console.log(`Pushing bot-engine to ${repoInfo.owner}/${repoInfo.repo}...`);
    for (const file of libFiles) {
      const content = readFileSync(path.join(BOT_ENGINE_DIR, 'lib', file), 'utf8');
      await github.putFile(secrets.GITHUB_TOKEN, repoInfo.owner, repoInfo.repo, `bot-engine/${file}`, content, 'Add bot-engine building blocks');
    }
    const readme = readFileSync(path.join(BOT_ENGINE_DIR, 'README.md'), 'utf8');
    await github.putFile(secrets.GITHUB_TOKEN, repoInfo.owner, repoInfo.repo, 'bot-engine/README.md', readme, 'Add bot-engine building blocks');

    const flowExists = await github.fileExists(secrets.GITHUB_TOKEN, repoInfo.owner, repoInfo.repo, 'flow/index.js');
    if (!flowExists) {
      console.log('Adding starter flow/index.js (none existed yet)...');
      await github.putFile(secrets.GITHUB_TOKEN, repoInfo.owner, repoInfo.repo, 'flow/index.js', FLOW_STARTER, 'Add flow starter pointing at bot-engine');
    } else {
      console.log('flow/index.js already exists -- leaving it untouched.');
    }
  } else {
    console.log('Client has no GitHub repo (created with --skip-github) -- skipping the repo push.');
  }

  // 2. Deploy bot-engine straight to the server too, so it's usable
  // immediately without waiting on a git pull cycle. Flat layout
  // (bot-engine/states.js, not bot-engine/lib/states.js) -- must match the
  // GitHub push above exactly, since flow/index.js's import path is the
  // same either way.
  const remoteDir = `/opt/${client.name}`;
  // Wipe and recreate, not just mkdir -p -- so re-running after the toolkit
  // itself changes (a file renamed/removed) never leaves a stale copy
  // behind next to the current one. flow/index.js lives outside this
  // directory, so it's never touched by this.
  await runRemote(client.ip, `rm -rf ${remoteDir}/bot-engine && mkdir -p ${remoteDir}/bot-engine`);
  for (const file of libFiles) {
    await copyToRemote(client.ip, path.join(BOT_ENGINE_DIR, 'lib', file), `${remoteDir}/bot-engine/${file}`);
  }
  await copyToRemote(client.ip, path.join(BOT_ENGINE_DIR, 'README.md'), `${remoteDir}/bot-engine/README.md`);

  upsertClient(registry, { name: client.name, hasBotEngine: true });
  saveRegistry(registry);

  console.log(`\nDone. bot-engine is ready for "${client.name}".`);
  console.log('Next (manual, on purpose): write the actual conversation flow in flow/index.js using the bot-engine functions.');
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
