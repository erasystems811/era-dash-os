import { spawn } from 'node:child_process';

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
  const args = [...SSH_OPTS];
  if (recursive) args.push('-r');
  args.push(localPath, `${user}@${ip}:${remotePath}`);
  return run('scp', args);
}

export async function readRemote(ip, remotePath, { user = 'root' } = {}) {
  const { stdout } = await runRemote(ip, `cat ${remotePath}`, { user });
  return stdout;
}

export async function waitForSsh(ip, { timeoutMs = 3 * 60 * 1000, intervalMs = 5000 } = {}) {
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
