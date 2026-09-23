#!/usr/bin/env node
// Usage: node deep-health-check.mjs
//
// The gap that let today's outage go undetected: /api/ebos/status only
// checks that a client's OWN /healthz responds -- it never checks whether
// WhatsApp itself is actually able to reach us. Two real, separate
// failures slipped through it entirely, 2026-09-16:
//   1. pomodoro's WABA was never subscribed to our Meta app (its manual
//      connect script skipped that step) -- server perfectly healthy,
//      Meta just never called us.
//   2. A Caddy config change on era-demo's box (which also fronts the
//      control panel's own domain and wa-router by hand, in the same
//      physical Caddyfile) silently deleted both those other domains'
//      site blocks -- broke WhatsApp for EVERY client at once, and every
//      business's own /healthz still said fine the whole time.
//
// This checks the two things those misses have in common: (a) the shared
// infrastructure Meta actually talks to is reachable over HTTPS at all,
// and (b) each connected client's WABA is actually subscribed to receive
// events. Meant to run on a schedule alongside check-bot-health.mjs, not
// replace it -- that one watches bot behavior once messages arrive, this
// one watches whether messages can arrive at all.

import { loadRegistry } from './lib/registry.mjs';
import { readRemote } from './lib/ssh.mjs';

const SHARED_DOMAINS = ['dash.erasystems.com.ng', 'wa-router.erasystems.com.ng'];

function readEnvVar(text, key) {
  const line = text.split('\n').find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : null;
}

async function checkDomain(domain) {
  try {
    const res = await fetch(`https://${domain}/healthz`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    // /healthz may 404 (wa-router only has it, dash.erasystems.com.ng's
    // basic-auth gate will 401 instead) -- any real HTTP response at all
    // proves TLS + routing works; only a network-level failure means broken.
    return res !== null;
  } catch {
    return false;
  }
}

async function checkWabaSubscription(client) {
  if (!client.whatsappPhoneNumberId || !client.whatsappBusinessAccountId) return null; // not connected yet, not a failure
  try {
    const envText = await readRemote(client.ip, `/opt/${client.name}/.env`);
    const accessToken = readEnvVar(envText, 'META_ACCESS_TOKEN');
    if (!accessToken) return false;
    const res = await fetch(`https://graph.facebook.com/v21.0/${client.whatsappBusinessAccountId}/subscribed_apps`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    return res.ok && Array.isArray(data.data) && data.data.length > 0;
  } catch {
    return null; // couldn't check (SSH/network hiccup) -- not the same as confirmed-broken
  }
}

export async function main() {
  const registry = loadRegistry();
  const results = { sharedInfra: {}, clients: [] };

  for (const domain of SHARED_DOMAINS) {
    results.sharedInfra[domain] = await checkDomain(domain);
  }

  const ebosClients = registry.clients.filter((c) => c.isEbos && !c.offboarded);
  for (const client of ebosClients) {
    const whatsappSubscribed = await checkWabaSubscription(client);
    results.clients.push({ name: client.name, whatsappSubscribed });
  }

  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((results) => console.log(JSON.stringify(results, null, 2)))
    .catch((err) => {
      console.error('FAILED:', err.message);
      process.exit(1);
    });
}
