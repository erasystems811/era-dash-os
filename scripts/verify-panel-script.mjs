#!/usr/bin/env node
// Regression check for the exact bug class that broke every button on the
// panel (2026-08-30): panel/server.js's page() function is one giant
// template literal containing the client-side HTML+<script> as literal
// text. A single `\'` anywhere in that literal gets consumed by the OUTER
// template literal's own escape processing before the browser ever sees
// it -- `node --check panel/server.js` does NOT catch this, because the
// outer .js file is perfectly valid syntax; the bug only exists in the
// STRING VALUE the file produces at runtime, not in the file's own source.
//
// This script doesn't reimplement JS's escaping rules to guess at the
// bug -- it runs the REAL server (dummy registry/secrets, no auth, scratch
// port), fetches its REAL rendered HTML, and syntax-checks the ACTUAL
// <script> text a real browser would receive. If that's broken, every
// onclick handler on the page silently stops working (a page load never
// visibly errors) -- exactly what happened live.
//
// Run this any time panel/server.js changes, before deploying it:
//   node scripts/verify-panel-script.mjs

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = path.join(__dirname, '..', 'panel');
const PORT = 41999;

function dummyRegistry() {
  return {
    clients: [
      {
        name: 'plain-client', displayName: 'Plain Client', subdomain: 'plain-client.erasystems.com.ng',
        isCustomDomain: false, dnsPending: false, provider: 'hetzner', serverId: 1, ip: '1.2.3.4',
        repo: 'https://github.com/example/plain-client', needsWhatsapp: false, needsPayment: false,
        paymentProvider: null, hasPdf: false, createdAt: new Date().toISOString(),
      },
      {
        name: 'demo-ebos', displayName: "O'Brien's Diner", subdomain: 'demo-ebos.erasystems.com.ng',
        isCustomDomain: false, dnsPending: false, provider: 'hetzner', serverId: 2, ip: '1.2.3.5',
        repo: 'https://github.com/example/demo-ebos', needsWhatsapp: true, needsPayment: true,
        paymentProvider: 'paystack', hasPdf: true, createdAt: new Date().toISOString(),
        isEbos: true, ebosAdminToken: 'dummy-token', whatsappPhoneNumberId: '12345',
        lastPushedAt: new Date().toISOString(), offboarded: false, offboardedAt: null,
        needsInstagram: false, instagramUserId: null, chowdeckEnabled: true,
      },
    ],
  };
}

async function waitForServer(url, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.status) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server never came up at ${url}`);
}

async function main() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'panel-verify-'));
  writeFileSync(path.join(tmp, 'registry.json'), JSON.stringify(dummyRegistry(), null, 2));
  writeFileSync(path.join(tmp, 'secrets.env'), 'OPENAI_API_KEY=x\nANTHROPIC_API_KEY=x\nHETZNER_TOKEN=x\n');

  const child = spawn('node', ['server.js'], {
    cwd: PANEL_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      PANEL_DISABLE_AUTH: '1',
      ERA_REGISTRY_PATH: path.join(tmp, 'registry.json'),
      ERA_SECRETS_PATH: path.join(tmp, 'secrets.env'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverErrOutput = '';
  child.stderr.on('data', (d) => (serverErrOutput += d.toString()));

  // Chidera, 2026-09-24: was only ever checking "/" -- /monitoring and
  // /my-dashboard are fully separate pages, each with their own <script>
  // block copy-pasted from "/"'s own pattern (see myDashboardPage's own
  // comment), so a mistake in either one's literal was never actually
  // caught by this check. Every page with its own <script> block goes here
  // now, not just the first one that ever needed this.
  const PAGES_TO_CHECK = ['/', '/monitoring', '/my-dashboard'];
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/healthz`);
    let anyFailed = false;
    for (const route of PAGES_TO_CHECK) {
      const html = await fetch(`http://127.0.0.1:${PORT}${route}`).then((r) => r.text());
      const match = html.match(/<script>([\s\S]*?)<\/script>/);
      if (!match) {
        console.error(`FAILED (${route}): no <script>...</script> block found in the rendered page.`);
        anyFailed = true;
        continue;
      }
      const scriptText = match[1];
      // new Function() parses (but never executes) the code -- this is a
      // pure syntax check, no DOM/window/document needed, and nothing here
      // ever runs the panel's actual client-side logic.
      try {
        // eslint-disable-next-line no-new-func
        new Function(scriptText);
        console.log(`ok (${route}): rendered <script> block (${scriptText.length} chars) is valid JavaScript.`);
      } catch (err) {
        console.error(`FAILED (${route}): the rendered <script> block is not valid JavaScript.`);
        console.error(`  ${err.constructor.name}: ${err.message}`);
        console.error('  This is exactly the bug class that broke every button on the panel on 2026-08-30 --');
        console.error('  check for a single `\\\'` (should be `\\\\\'`) anywhere inside that page\'s own template literal.');
        anyFailed = true;
      }
    }
    if (anyFailed) {
      process.exitCode = 1;
      return;
    }
  } finally {
    child.kill();
    rmSync(tmp, { recursive: true, force: true });
  }

  if (serverErrOutput && process.exitCode !== 1) {
    console.log('\n(server stderr during the check, for reference:)');
    console.log(serverErrOutput);
  }
}

main().catch((err) => {
  console.error('CHECK FAILED TO RUN:', err.message);
  process.exit(1);
});
