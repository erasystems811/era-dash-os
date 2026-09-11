#!/usr/bin/env node
// Usage: node backup-all-clients.mjs
//
// Meant to run on a schedule (cron on the control server, once a day --
// see README.md's "Backups" section for the exact crontab line). Backs up
// every client's Postgres database (pg_dump, gzipped) from its own server
// down onto the control server's disk -- a genuinely different machine
// than the one each database actually runs on, which is the part that
// makes this a real backup rather than a false sense of one. Prunes old
// backups per client so this doesn't grow forever.
//
// Skips: offboarded clients (nothing left to back up), and customDeploy
// clients (routes/redeploy-client.mjs's own reasoning applies here too --
// a custom app deploy isn't guaranteed to have a "<slug>-postgres-1"
// container running the standard schema, so a generic pg_dump against it
// would be guessing).
//
// Does NOT alert on every success -- only on a failure, and only once per
// run (one summary message, not one per failed client), same "don't page
// for noise" instinct check-bot-health.mjs already follows.

import { loadRegistry, saveRegistry, upsertClient } from './lib/registry.mjs';
import { loadSecrets } from './lib/secrets.mjs';
import { sendWhatsAppAlert } from './lib/alert.mjs';
import { backupClient, pruneOldBackups } from './lib/backup.mjs';

const DEST_DIR = process.env.ERA_BACKUP_DIR || '/opt/era-control/backups';
const KEEP_PER_CLIENT = Number(process.env.ERA_BACKUP_KEEP || 14);

// Exported (not just run as a script) so panel/server.js can call this
// directly on its own setInterval -- same reasoning as check-bot-health.mjs's
// own main export: the panel is already a permanent background service
// (systemd, Restart=always), so scheduling from inside it is one less
// moving part than a separate cron entry, and lets a panel button
// ("Run backup now") call the exact same code path as the daily run.
export async function main() {
  const registry = loadRegistry();
  const clients = registry.clients.filter((c) => !c.offboarded && !c.customDeploy);
  if (!clients.length) {
    console.log('No clients to back up.');
    return;
  }

  let secrets = {};
  try {
    secrets = loadSecrets();
  } catch (err) {
    console.error(`Could not read secrets.env: ${err.message} -- will still attempt backups, cannot send a failure alert.`);
  }

  const failures = [];
  for (const client of clients) {
    try {
      const { localFile, sizeBytes } = await backupClient(client, { destDir: DEST_DIR });
      console.log(`${client.name}: OK -> ${localFile} (${(sizeBytes / 1024).toFixed(0)} KB)`);
      const deleted = pruneOldBackups(DEST_DIR, client.name, KEEP_PER_CLIENT);
      if (deleted.length) console.log(`  pruned ${deleted.length} old backup(s)`);
      upsertClient(registry, { name: client.name, lastBackupAt: new Date().toISOString(), lastBackupOk: true });
    } catch (err) {
      console.error(`${client.name}: FAILED -- ${err.message}`);
      failures.push({ name: client.displayName || client.name, error: err.message });
      upsertClient(registry, { name: client.name, lastBackupAt: new Date().toISOString(), lastBackupOk: false });
    }
  }

  saveRegistry(registry);

  if (failures.length) {
    const text = `⚠ Backup failed for ${failures.length} client(s): ${failures.map((f) => `${f.name} (${f.error})`).join('; ')}`;
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
