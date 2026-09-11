// Real, automated Postgres backups -- there was nothing here before this
// (2026-09-11): every client's order/customer/booking history lived on
// exactly one disk, on exactly one server, with no copy anywhere else. A
// dead drive, a bad migration, or a wiped server meant that data was
// simply gone. This is the fix: pg_dump each client's database on its own
// schedule and pull the dump down to a different machine (the control
// server) than the one it runs on -- a backup that lives next to the
// thing it's backing up isn't a real backup.
//
// Deliberately NOT off-site object storage (S3/OCI Object Storage) yet --
// that's the natural next step once this is proven, but it needs its own
// credentials and this already turns "zero backups" into "a daily copy on
// a separate machine", which is the change that actually matters first.

import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { runRemote, copyFromRemote } from './ssh.mjs';

const REMOTE_TMP_DIR = '/tmp/era-backups';

function timestamp() {
  // Sortable and filesystem-safe: 2026-09-11T030000Z, not a colon in sight.
  return new Date().toISOString().replace(/[:.]/g, '').replace(/-/g, '');
}

// One client's database, dumped and pulled down. Container/db naming
// matches every template's docker-compose.yml.template exactly:
// POSTGRES_USER=app, POSTGRES_DB={{APP_SLUG}}, and Compose's own default
// project-name-from-directory-basename rule is what makes the container
// "<slug>-postgres-1" -- see scripts/create-client.mjs's remoteDir
// (`/opt/${slug}`). Works the same for a shared-mode client (each still
// gets its own compose project directory on the shared server, just no
// Caddy of its own) since none of that naming depends on serverMode.
export async function backupClient(client, { destDir }) {
  const slug = client.name;
  const remoteFile = `${REMOTE_TMP_DIR}/${slug}-${timestamp()}.sql.gz`;
  const clientDestDir = path.join(destDir, slug);
  mkdirSync(clientDestDir, { recursive: true });
  const localFile = path.join(clientDestDir, path.basename(remoteFile));

  await runRemote(
    client.ip,
    `mkdir -p ${REMOTE_TMP_DIR} && docker exec ${slug}-postgres-1 pg_dump -U app ${slug} | gzip > ${remoteFile}`
  );
  await copyFromRemote(client.ip, remoteFile, localFile);
  await runRemote(client.ip, `rm -f ${remoteFile}`);

  const { size } = statSync(localFile);
  if (size === 0) {
    unlinkSync(localFile);
    throw new Error(`pg_dump produced an empty file for "${slug}" -- deleted, not keeping a fake backup`);
  }
  return { localFile, sizeBytes: size };
}

// Keeps the most recent N backups per client, deletes the rest -- daily
// backups kept forever would just slowly fill the control server's disk.
// N is a count, not a day range, on purpose: if a client's own cron only
// runs occasionally, or catches up after downtime, "last 14 files" is
// still the right rule without needing to reason about calendar days.
export function pruneOldBackups(destDir, slug, keep) {
  const clientDestDir = path.join(destDir, slug);
  let files;
  try {
    files = readdirSync(clientDestDir).filter((f) => f.endsWith('.sql.gz'));
  } catch {
    return [];
  }
  files.sort().reverse(); // filenames are timestamp-sortable, newest first
  const toDelete = files.slice(keep);
  for (const f of toDelete) unlinkSync(path.join(clientDestDir, f));
  return toDelete;
}
