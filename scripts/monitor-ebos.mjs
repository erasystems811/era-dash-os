#!/usr/bin/env node
// Self-hosted replacement for the EBOS Health Monitor cloud routine, which
// never worked -- its egress proxy hard-blocks custom domains like
// dash.erasystems.com.ng (confirmed via get_run_log, connect_rejected).
// This runs via cron on the control server itself instead, where there's no
// such restriction. Meant to be a tripwire, not a diagnostic session: a few
// fast local checks, then either silence or exactly one WhatsApp alert.
//
// Run every 10 minutes via cron:
//   */10 * * * * /usr/bin/node /opt/era-control/era-dash-os/scripts/monitor-ebos.mjs >> /opt/era-control/monitor-ebos.log 2>&1

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

function creditLow(msg) {
  return typeof msg === 'string' && msg.toLowerCase().includes('credit balance is too low');
}

const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASSWORD = process.env.PANEL_PASSWORD;
const ALERT_TO = process.env.ALERT_TO_WHATSAPP || '2349032637607';
const TEMPLATE_NAME = 'ebos_admin_alert';
const STATE_FILE = '/opt/era-control/monitor-ebos.state';
const REALERT_AFTER_MS = 2 * 60 * 60 * 1000; // don't re-alert an ongoing problem more than once every 2h
const META_ENV_PATH = '/opt/era-demo/.env';

function readMetaEnv() {
  const raw = readFileSync(META_ENV_PATH, 'utf8');
  const env = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

async function panelStatus() {
  const res = await fetch('http://localhost:4100/api/ebos/status', {
    headers: { Authorization: 'Basic ' + Buffer.from(`${PANEL_USER}:${PANEL_PASSWORD}`).toString('base64') },
  });
  if (!res.ok) throw new Error(`panel status returned ${res.status}`);
  return res.json();
}

function panelServiceActive() {
  try {
    execFileSync('systemctl', ['is-active', '--quiet', 'era-dash-panel.service']);
    return true;
  } catch {
    return false;
  }
}

async function sendAlert(summary) {
  const env = readMetaEnv();
  const body = {
    messaging_product: 'whatsapp',
    to: ALERT_TO,
    type: 'template',
    template: {
      name: TEMPLATE_NAME,
      language: { code: 'en_US' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: summary.slice(0, 180) }] }],
    },
  };
  const res = await fetch(`https://graph.facebook.com/v23.0/${env.META_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`WhatsApp send failed: ${JSON.stringify(json)}`);
}

async function main() {
  const problems = [];

  if (!panelServiceActive()) problems.push('control panel service is down');

  let businesses = [];
  try {
    businesses = await panelStatus();
  } catch (err) {
    problems.push(`control panel API unreachable (${err.message})`);
  }

  for (const b of businesses) {
    if (b.up === false) problems.push(`${b.name}: unreachable`);
    // recentErrorCount/lastErrorMessage are the panel's own rolling 30-minute
    // Claude/API error tracker (same field the dashboard's management view
    // shows) -- reuse it instead of re-deriving errors from raw docker logs.
    if (b.recentErrorCount) {
      if (creditLow(b.lastErrorMessage)) {
        problems.push(`${b.name}: Claude API credit exhausted`);
      } else {
        problems.push(`${b.name}: ${b.recentErrorCount} Claude/API error(s) in the last 30 min`);
      }
    }
  }

  if (problems.length === 0) {
    if (existsSync(STATE_FILE)) writeFileSync(STATE_FILE, ''); // clear so the next real problem alerts immediately
    return;
  }

  const lastAlert = existsSync(STATE_FILE) ? Number(readFileSync(STATE_FILE, 'utf8') || 0) : 0;
  if (Date.now() - lastAlert < REALERT_AFTER_MS) {
    console.log('Problem still open, within re-alert cooldown, staying quiet:', problems.join('; '));
    return;
  }

  const summary =
    problems.length === 1
      ? problems[0]
      : `${problems.length} issues, worst: ${problems[0]}`;

  await sendAlert(`EBOS: ${summary}`);
  writeFileSync(STATE_FILE, String(Date.now()));
  console.log('Alert sent:', summary);
}

main().catch((err) => {
  console.error('monitor-ebos.mjs crashed:', err);
  process.exit(1);
});
