#!/usr/bin/env node
// Usage: node verify-backups.mjs
//
// A backup nobody has ever restored isn't verified, it's just a hope --
// backup-all-clients.mjs's own check only confirms the dump file isn't
// EMPTY, never that it actually restores into a real, queryable database.
// This is the real test: for each client, take their most recent backup,
// restore it into a disposable throwaway Postgres container (never a real
// client server, never the control server's own data), confirm real
// tables and rows come back, then discard the container. Meant to run
// weekly (see the control server's own crontab) -- a full restore is
// heavier than the nightly backup itself, so this doesn't need backup's
// own daily cadence to be a meaningful safety net.
//
// Same skip list as backup-all-clients.mjs, same reasoning: offboarded
// clients have nothing left worth verifying, customDeploy clients aren't
// guaranteed to have the standard schema this checks for.

import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { loadRegistry, saveRegistry, upsertClient } from './lib/registry.mjs';
import { loadSecrets } from './lib/secrets.mjs';
import { sendWhatsAppAlert } from './lib/alert.mjs';

const BACKUP_DIR = process.env.ERA_BACKUP_DIR || '/opt/era-control/backups';
// A real client's schema is dozens of tables (product, order, customers,
// message, ...) -- a handful is a strong enough signal the dump actually
// contains a real schema and not just an empty/truncated file, without
// hardcoding the exact expected count (which changes every migration).
const MIN_EXPECTED_TABLES = 5;

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' });
}

function latestBackupFor(slug) {
  const dir = path.join(BACKUP_DIR, slug);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql.gz'))
    .sort()
    .reverse();
  return files.length ? path.join(dir, files[0]) : null;
}

// Container name is deterministic (not randomUUID) so a leftover from a
// crashed previous run gets cleaned up by name instead of accumulating
// forever, same "not just optimize/hope" reasoning as everything else here.
function containerNameFor(slug) {
  return `verify-backup-${slug}`;
}

async function verifyOne(client) {
  const slug = client.name;
  const backupFile = latestBackupFor(slug);
  if (!backupFile) return { ok: false, reason: 'no backup file found' };

  const containerName = containerNameFor(slug);
  try { run('docker', ['rm', '-f', containerName]); } catch { /* nothing to clean up */ }

  try {
    run('docker', [
      'run', '-d', '--name', containerName,
      '-e', 'POSTGRES_USER=app',
      '-e', 'POSTGRES_PASSWORD=verify-only-throwaway',
      '-e', `POSTGRES_DB=${slug}`,
      'postgres:16-alpine',
    ]);

    // pg_isready inside the container itself -- no host port ever
    // published, this never needs to be reachable from outside.
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        run('docker', ['exec', containerName, 'pg_isready', '-U', 'app']);
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!ready) return { ok: false, reason: 'throwaway postgres never became ready' };

    // The dump itself references the authenticator role -- pg_dump -U app
    // <db> captures the GRANT statements already made to it on every
    // table, even though it never dumps the role's own CREATE ROLE (roles
    // are cluster-wide, not part of any one database). Found running this
    // for real: without creating the role first, restore gets exactly as
    // far as the first such GRANT and stops (ON_ERROR_STOP=1), same
    // preamble migrate-client.mjs already needs for a real migration --
    // password is thrown away with the container, never reused anywhere.
    run('docker', ['exec', containerName, 'psql', '-U', 'app', '-d', slug, '-v', 'ON_ERROR_STOP=1', '-c', "create role authenticator with login password 'verify-only' noinherit; grant usage on schema public to authenticator;"]);

    run('bash', ['-c', `zcat "${backupFile}" | docker exec -i ${containerName} psql -U app -d ${slug} -v ON_ERROR_STOP=1`]);

    const tableCountOut = run('docker', [
      'exec', containerName, 'psql', '-U', 'app', '-d', slug, '-t', '-c',
      "select count(*) from information_schema.tables where table_schema = 'public'",
    ]);
    const tableCount = parseInt(tableCountOut.trim(), 10);
    if (!(tableCount >= MIN_EXPECTED_TABLES)) {
      return { ok: false, reason: `only ${tableCount} table(s) restored, expected at least ${MIN_EXPECTED_TABLES}` };
    }

    return { ok: true, tableCount, backupFile };
  } finally {
    try { run('docker', ['rm', '-f', containerName]); } catch { /* best effort */ }
  }
}

export async function main() {
  const registry = loadRegistry();
  const clients = registry.clients.filter((c) => !c.offboarded && !c.customDeploy);
  if (!clients.length) {
    console.log('No clients to verify.');
    return;
  }

  let secrets = {};
  try {
    secrets = loadSecrets();
  } catch (err) {
    console.error(`Could not read secrets.env: ${err.message} -- will still attempt verification, cannot send a failure alert.`);
  }

  const failures = [];
  for (const client of clients) {
    try {
      const result = await verifyOne(client);
      if (result.ok) {
        console.log(`${client.name}: OK -- ${result.tableCount} tables restored from ${result.backupFile}`);
        upsertClient(registry, { name: client.name, lastBackupVerifiedAt: new Date().toISOString(), lastBackupVerifiedOk: true });
      } else {
        console.error(`${client.name}: FAILED -- ${result.reason}`);
        failures.push({ name: client.displayName || client.name, error: result.reason });
        upsertClient(registry, { name: client.name, lastBackupVerifiedAt: new Date().toISOString(), lastBackupVerifiedOk: false });
      }
    } catch (err) {
      console.error(`${client.name}: FAILED -- ${err.message}`);
      failures.push({ name: client.displayName || client.name, error: err.message });
      upsertClient(registry, { name: client.name, lastBackupVerifiedAt: new Date().toISOString(), lastBackupVerifiedOk: false });
    }
  }

  saveRegistry(registry);

  if (failures.length) {
    const text = `⚠ Backup restore-verification failed for ${failures.length} client(s): ${failures.map((f) => `${f.name} (${f.error})`).join('; ')}`;
    await sendWhatsAppAlert(secrets, text);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
  });
}
