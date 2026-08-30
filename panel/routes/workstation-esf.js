// The ESF workstation's "Build" button destination -- same shape as
// routes/workstation.js (EBOS's): takes what the workstation's tabs
// captured, writes it as a seed file, and runs the exact same
// create-client.mjs pipeline as any other client, just with
// --template=esf --esf-seed=<that file>. No new provisioning logic here on
// purpose: the workstation is a UI over the existing engine, not a second
// one.
import express from 'express';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { startJob } from '../jobs.mjs';

export const router = express.Router();

router.post('/build', (req, res) => {
  const { businessName, subdomain, size, whatsapp, business, owner, staff, tasks } = req.body;

  if (!businessName || !owner?.email) {
    return res.status(400).json({ error: 'Business name and owner email are both required before building.' });
  }

  const seedDir = path.join(os.tmpdir(), 'era-workstation-esf-seeds');
  mkdirSync(seedDir, { recursive: true });
  const seedPath = path.join(seedDir, `${randomUUID()}.json`);
  writeFileSync(seedPath, JSON.stringify({ business: business || {}, owner, staff: staff || [], tasks: tasks || [] }));

  const args = [`--name=${businessName}`, '--template=esf', `--esf-seed=${seedPath}`];
  if (subdomain) args.push(`--subdomain=${subdomain}`);
  if (size) args.push(`--size=${size}`);
  if (whatsapp) args.push('--whatsapp');

  const jobId = startJob('create-client.mjs', args);
  res.json({ jobId });
});
