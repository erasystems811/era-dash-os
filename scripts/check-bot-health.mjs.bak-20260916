#!/usr/bin/env node
// Usage: node check-bot-health.mjs
//
// Meant to run on a schedule (cron on the control server, e.g. every 15
// minutes) -- polls every EBOS business's own /api/monitor/summary (see
// ebos-templates/dashboard/routes/api.js) for the trailing hour, and sends
// a WhatsApp alert when a business crosses its concern threshold. This is
// the proactive half of ERA Dash OS's Bot Monitoring panel; the panel
// itself (panel/server.js's "Bot Monitoring" section) is the half you
// check by hand.
//
// Deliberately narrow about what counts as "concerning" here: only real
// code errors (codeErrorCount from /monitor/summary -- an unhandled bot
// exception it had to recover from, or a real Claude/API call failure),
// not handovers or "bot didn't know that" -- those are normal business
// activity for the business owner to see in their own dashboard, not
// something that should page the platform operator. Same definition the
// panel uses for its "Code errors (1h)" column -- one source of truth.
//
// Threshold + cooldown live on each client's registry entry
// (alertThreshold, lastAlertedAt) via scripts/lib/registry.mjs, same place
// every other per-client fact already lives. No threshold set on a client
// falls back to DEFAULT_THRESHOLD. Cooldown stops a sustained spike from
// re-alerting every 15 minutes -- only fires again once COOLDOWN_MS has
// passed since the last alert for that business.
//
// WhatsApp send uses a dedicated set of secrets.env keys
// (ALERT_WA_TOKEN/ALERT_WA_PHONE_NUMBER_ID/ALERT_RECIPIENT_PHONE) --
// values copied once from an already Meta-verified number (Bali's, per
// Chidera's choice) rather than read live from that business's own .env,
// so ops alerting isn't coupled to that business's own deploys/token
// rotation. If those keys aren't set yet, this still runs and logs
// concern counts, it just can't actually send -- meant to work today for
// visibility even before the WhatsApp side is wired up.

import { loadRegistry, saveRegistry, upsertClient } from './lib/registry.mjs';
import { loadSecrets } from './lib/secrets.mjs';
import { loadState as loadFixbotState, saveState as saveFixbotState } from '../fixbot/lib/state.mjs';

// Lower than the old broad definition on purpose -- real code errors are
// meant to be rare. A handful of genuine exceptions/API failures in one
// hour is already worth knowing about, not something to wait out to 5.
const DEFAULT_THRESHOLD = 3;
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

async function fetchSummary(client) {
  try {
    const res = await fetch(`https://${client.subdomain}/api/monitor/summary?hours=1`, {
      headers: { 'x-era-admin-token': client.ebosAdminToken || '' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function concernCount(summary) {
  if (!summary) return null;
  return summary.codeErrorCount;
}

async function sendWhatsAppAlert(secrets, text) {
  const { ALERT_WA_TOKEN, ALERT_WA_PHONE_NUMBER_ID, ALERT_RECIPIENT_PHONE } = secrets;
  if (!ALERT_WA_TOKEN || !ALERT_WA_PHONE_NUMBER_ID || !ALERT_RECIPIENT_PHONE) {
    console.log('  (WhatsApp alerting not configured -- set ALERT_WA_TOKEN, ALERT_WA_PHONE_NUMBER_ID, ALERT_RECIPIENT_PHONE in secrets.env)');
    return false;
  }
  const res = await fetch(`https://graph.facebook.com/v20.0/${ALERT_WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ALERT_WA_TOKEN}` },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: ALERT_RECIPIENT_PHONE,
      type: 'text',
      text: { body: text },
    }),
  });
  if (!res.ok) {
    console.error(`  WhatsApp send failed ${res.status}: ${await res.text()}`);
    return false;
  }
  return true;
}

// Exported (not just run as a script) so panel/server.js can call this
// directly on its own setInterval -- the panel is already a permanent
// background service on the control server (systemd, Restart=always), so
// that's a simpler and more reliable home for "check every 15 minutes"
// than a separate cron entry: one less moving part to install/monitor,
// and it shares the panel's already-working registry/secrets access.
// Running this file directly (node check-bot-health.mjs) still works too,
// for manual checks or if a standalone cron entry is ever preferred later.
export async function main() {
  const registry = loadRegistry();
  const ebosClients = registry.clients.filter((c) => c.isEbos && !c.offboarded);
  if (!ebosClients.length) {
    console.log('No EBOS businesses in the registry.');
    return;
  }

  let secrets = {};
  try {
    secrets = loadSecrets();
  } catch (err) {
    console.error(`Could not read secrets.env: ${err.message} -- will still log concern counts, cannot send alerts.`);
  }

  const now = Date.now();
  for (const client of ebosClients) {
    const summary = await fetchSummary(client);
    const count = concernCount(summary);
    if (count == null) {
      console.log(`${client.name}: could not reach /api/monitor/summary`);
      continue;
    }

    const threshold = client.alertThreshold ?? DEFAULT_THRESHOLD;
    console.log(`${client.name}: ${count} concern(s) in the last hour (threshold ${threshold})`);
    if (count < threshold) continue;

    const lastAlertedAt = client.lastAlertedAt ? new Date(client.lastAlertedAt).getTime() : 0;
    if (now - lastAlertedAt < COOLDOWN_MS) {
      console.log(`  over threshold but still in cooldown (last alerted ${client.lastAlertedAt})`);
      continue;
    }

    const errorRecoveryCount = summary.triggers.find((t) => t.trigger === 'error_recovery')?.count || 0;
    const detail = [
      errorRecoveryCount ? `${errorRecoveryCount} bot exception(s)` : null,
      summary.aiErrors ? `${summary.aiErrors} AI/API failure(s)` : null,
    ].filter(Boolean).join(', ');
    const text = `⚠ ${client.displayName || client.name}: ${count} real code error(s) in the last hour (${detail}). Check the Bot Monitoring panel, or reply "fix it" and I'll look into it.`;

    const sent = await sendWhatsAppAlert(secrets, text);
    if (sent) {
      console.log('  alert sent');
      // Lets fixbot/server.js resolve a bare "fix it" reply to the business
      // that actually alerted, without Chidera having to name it herself.
      // Overwritten on the next alert -- fixbot only ever investigates the
      // most recent one, matching the "one investigation at a time" design.
      const fixbotState = loadFixbotState();
      saveFixbotState({
        ...fixbotState,
        pendingAlert: { clientName: client.name, detail: text, alertedAt: new Date(now).toISOString() },
      });
      upsertClient(registry, { name: client.name, lastAlertedAt: new Date(now).toISOString() });
    }
  }

  saveRegistry(registry);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
  });
}
