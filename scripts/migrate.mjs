#!/usr/bin/env node
// Usage:
//   node migrate.mjs --client=slug --file=path/to.sql
//   node migrate.mjs --all-ebos --file=path/to.sql
//
// Runs a schema change against an already-live business's database --
// deliberately separate from push-update.mjs (app code only, never touches
// the database) and redeploy-client.mjs (wipes and reprovisions from
// scratch). A schema change is data-affecting and has to be a deliberate,
// reviewed step of its own, never bundled silently into a routine code
// push. Only ever hand-write CREATE TABLE IF NOT EXISTS / ALTER TABLE ...
// ADD COLUMN IF NOT EXISTS style statements in a migration file -- nothing
// that could drop or rewrite existing data.
//
// A basic guardrail below refuses to run a file containing an obviously
// destructive statement (DROP/TRUNCATE/DELETE) -- not a substitute for
// reading the file yourself, just a last-resort catch.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { loadRegistry } from './lib/registry.mjs';
import { runRemote, copyToRemote } from './lib/ssh.mjs';

const DESTRUCTIVE_PATTERN = /\b(drop\s+table|drop\s+column|truncate|delete\s+from)\b/i;

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (arg.startsWith('--client=')) args.client = arg.slice('--client='.length);
    else if (arg === '--all-ebos') args.allEbos = true;
    else if (arg.startsWith('--file=')) args.file = arg.slice('--file='.length);
  }
  if (!args.file) throw new Error('Usage: migrate.mjs (--client=slug | --all-ebos) --file=path/to.sql');
  if (!args.client && !args.allEbos) throw new Error('Usage: migrate.mjs (--client=slug | --all-ebos) --file=path/to.sql');
  if (args.client && args.allEbos) throw new Error('Pass either --client=slug or --all-ebos, not both.');
  return args;
}

async function migrateOne(client, sql) {
  console.log(`\n=== ${client.name} (${client.ip}) ===`);
  try {
    const remoteTmp = `/tmp/era-migrate-${client.name}.sql`;
    const localTmp = path.join(os.tmpdir(), `era-migrate-${client.name}.sql`);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(localTmp, sql);
    await copyToRemote(client.ip, localTmp, remoteTmp);
    await runRemote(client.ip, `docker exec -i ${client.name}-postgres-1 psql -U app -d ${client.name} -v ON_ERROR_STOP=1 < ${remoteTmp}`);
    await runRemote(client.ip, `rm -f ${remoteTmp}`);
    console.log('  ok');
    return { name: client.name, ok: true };
  } catch (err) {
    console.error(`  FAILED: ${err.message}`);
    return { name: client.name, ok: false, error: err.message };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sql = readFileSync(args.file, 'utf8');
  // Strip SQL line-comments before checking -- otherwise a comment merely
  // explaining or referencing a blocked phrase (e.g. "this is not a `drop
  // column`") trips the guard on prose, not on real SQL. Bit this file
  // twice already (0012, 0014) before this fix.
  const sqlWithoutComments = sql.replace(/--.*$/gm, '');
  if (DESTRUCTIVE_PATTERN.test(sqlWithoutComments)) {
    throw new Error(
      `Refusing to run ${args.file}: it contains DROP/TRUNCATE/DELETE, which this tool is not meant for. Run that by hand if you're sure, after reviewing it yourself.`
    );
  }

  const registry = loadRegistry();
  // Same sandbox exclusion as push-update.mjs's --all-ebos -- a schema
  // change meant for real businesses should never silently also land on
  // the sandbox (and vice versa: a sandbox-only migration being tested
  // stays scoped to --client=<sandbox-name>, never swept into --all-ebos).
  const targets = args.allEbos
    ? registry.clients.filter((c) => c.isEbos && !c.sandbox)
    : [registry.clients.find((c) => c.name === args.client)].filter(Boolean);

  if (!targets.length) {
    throw new Error(args.allEbos ? 'No client in the registry is marked isEbos: true.' : `No client "${args.client}" in the registry.`);
  }

  console.log(`Running ${args.file} against ${targets.length} business(es)...`);
  const results = [];
  for (const client of targets) {
    results.push(await migrateOne(client, sql));
  }

  console.log('\n=== Summary ===');
  for (const r of results) {
    console.log(`  ${r.name}: ${r.ok ? 'ok' : `FAILED (${r.error})`}`);
  }
  if (results.some((r) => !r.ok)) process.exit(1);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
