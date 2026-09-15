import { spawn } from 'node:child_process';
import path from 'node:path';

// These are short-lived, automation-created servers (Hetzner/DO reuse IPs
// from a pool once an old one is deleted) -- a stale known_hosts entry from
// a previous server at the same IP would otherwise hard-fail every
// connection with "REMOTE HOST IDENTIFICATION HAS CHANGED", which looks
// exactly like "SSH not ready" from waitForSsh and never resolves no matter
// how long you wait. Skip host-key pinning for this reason; the DO/Hetzner
// API token is already the real trust boundary for which IP we talk to.
const SSH_OPTS = ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=10'];

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr || stdout}`));
    });
  });
}

export async function runRemote(ip, command, { user = 'root' } = {}) {
  return run('ssh', [...SSH_OPTS, `${user}@${ip}`, command]);
}

export async function copyToRemote(ip, localPath, remotePath, { user = 'root', recursive = false } = {}) {
  if (!recursive) {
    return run('scp', [...SSH_OPTS, localPath, `${user}@${ip}:${remotePath}`]);
  }
  // Directory copies go over tar+ssh instead of `scp -r`, which has no
  // exclude option -- a template folder with its own node_modules (e.g.
  // ebos-templates/dashboard/client, which needs real devDependencies to
  // run its own build) would otherwise get copied wholesale, which is slow
  // at best and can ship the wrong platform's native binaries at worst.
  // The remote side's own `docker compose up --build` runs npm install
  // itself, so none of this needs to make the trip.
  // scp -r nests the copy inside a directory named after localPath's own
  // basename (e.g. .../dashboard copied into remotePath/ lands at
  // remotePath/dashboard/...) -- docker-compose's `build: ./dashboard`
  // depends on that exact layout, so the tar target has to reproduce it
  // rather than dumping localPath's contents straight into remotePath.
  const targetDir = `${remotePath.replace(/\/$/, '')}/${path.basename(localPath)}`;
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['--exclude=node_modules', '--exclude=dist', '--exclude=.git', '-cf', '-', '-C', localPath, '.']);
    const ssh = spawn('ssh', [...SSH_OPTS, `${user}@${ip}`, `mkdir -p ${targetDir} && tar -xf - -C ${targetDir}`]);
    let stderr = '';
    ssh.stderr.on('data', (d) => (stderr += d));
    tar.stdout.pipe(ssh.stdin);
    tar.on('error', reject);
    ssh.on('error', reject);
    ssh.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`copyToRemote (tar|ssh) exited ${code}: ${stderr}`));
    });
  });
}

// The reverse of copyToRemote -- pulling a file off a client's server
// (e.g. a pg_dump'd backup) down to wherever this script is actually
// running. Single files only (no recursive/tar mode -- nothing that needs
// it yet); add that the same way copyToRemote did if it comes up.
export async function copyFromRemote(ip, remotePath, localPath, { user = 'root' } = {}) {
  return run('scp', [...SSH_OPTS, `${user}@${ip}:${remotePath}`, localPath]);
}

export async function readRemote(ip, remotePath, { user = 'root' } = {}) {
  const { stdout } = await runRemote(ip, `cat ${remotePath}`, { user });
  return stdout;
}

// 3 minutes used to be enough; found live, 2026-09-16, creating a
// throwaway test client: two Hetzner boots in a row both came up reachable
// only 10-40s past the old 3-minute mark, never within it -- bumped to 5
// minutes rather than re-tuning to a number that just barely covers today's
// observed timing.
export async function waitForSsh(ip, { timeoutMs = 5 * 60 * 1000, intervalMs = 5000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await runRemote(ip, 'echo ready');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(`SSH to ${ip} not ready after ${timeoutMs}ms`);
}

export async function waitForCloudInit(ip, { timeoutMs = 6 * 60 * 1000, intervalMs = 8000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await runRemote(ip, 'test -f /opt/cloud-init-done');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(`cloud-init (Docker install) on ${ip} did not finish within ${timeoutMs}ms`);
}
