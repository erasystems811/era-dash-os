// Runs era-dash-os scripts as background jobs so the panel's page can poll
// for live output instead of blocking a request for several minutes.
// In-memory only -- this is a single-operator tool, not a multi-user
// service, so losing job history on a restart is fine.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const jobs = new Map();
const SCRIPTS_DIR = path.join(process.cwd(), '..', 'scripts');

export function startJob(scriptName, args) {
  const id = randomUUID();
  const job = { id, script: scriptName, args, status: 'running', log: '', exitCode: null };
  jobs.set(id, job);

  // spawn with an argv array (never a shell string) -- args here come
  // straight from form input, so this is the one thing standing between
  // this panel and command injection.
  const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, scriptName), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => (job.log += d.toString()));
  child.stderr.on('data', (d) => (job.log += d.toString()));
  child.on('close', (code) => {
    job.exitCode = code;
    job.status = code === 0 ? 'done' : 'failed';
  });

  return id;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

// For quick, read-only scripts (e.g. get-env.mjs) where the caller wants the
// result immediately rather than polling a job -- resolves with stdout, or
// rejects with stderr on a non-zero exit.
export function runScript(scriptName, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, scriptName), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || stdout || `exited ${code}`));
    });
  });
}
