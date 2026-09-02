// The real per-client WhatsApp webhook router -- one Meta App (ERA's own)
// serves every EBOS client, each with its own WABA/phone number, but Meta
// only allows ONE webhook callback URL per app. This is that fan-out: look
// up which client owns the inbound phone_number_id, forward the event to
// that client's own dedicated server.
//
// Originally part of the ERA Dash panel itself (panel/server.js) -- moved
// to its own small service, deployed on a real EBOS client's server rather
// than the panel's own box, specifically so routing never depends on the
// panel's uptime. The panel is useful but not load-bearing for a live
// customer's WhatsApp; this is.
//
// The registry (which phone_number_id belongs to which client) is pulled
// from the panel on a timer and cached to disk -- so a client is reachable
// within REFRESH_MS of being connected with no manual step, and a brief
// panel outage doesn't break routing for clients already known about (this
// process keeps using its last-known-good copy).
import express from 'express';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const app = express();
app.use(express.json());

const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const PANEL_URL = process.env.PANEL_URL; // e.g. https://dash.erasystems.com.ng
const REGISTRY_SYNC_TOKEN = process.env.REGISTRY_SYNC_TOKEN;
const REGISTRY_CACHE_PATH = process.env.REGISTRY_CACHE_PATH || '/data/registry.json';
const REFRESH_MS = 2 * 60 * 1000;

let registry = { clients: [] };
if (existsSync(REGISTRY_CACHE_PATH)) {
  try {
    registry = JSON.parse(readFileSync(REGISTRY_CACHE_PATH, 'utf8'));
    console.log(`Loaded cached registry (${registry.clients?.length || 0} clients) from disk.`);
  } catch (err) {
    console.error('Failed to read cached registry:', err.message);
  }
}

async function refreshRegistry() {
  try {
    const res = await fetch(`${PANEL_URL}/internal/registry`, {
      headers: { 'x-registry-sync-token': REGISTRY_SYNC_TOKEN },
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const fresh = await res.json();
    registry = fresh;
    writeFileSync(REGISTRY_CACHE_PATH, JSON.stringify(fresh, null, 2));
  } catch (err) {
    // Keep using the last-known-good copy -- a panel hiccup should never
    // stop a live client's messages from routing.
    console.error('Registry refresh failed, keeping last-known-good copy:', err.message);
  }
}
refreshRegistry();
setInterval(refreshRegistry, REFRESH_MS);

app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook/whatsapp', async (req, res) => {
  // Ack immediately -- Meta retries aggressively on a slow/failed response,
  // and the actual forward happens async below.
  res.sendStatus(200);
  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const phoneNumberId = change.value?.metadata?.phone_number_id;
        if (!phoneNumberId) continue;
        const client = registry.clients.find((c) => c.whatsappPhoneNumberId === phoneNumberId);
        if (!client) {
          console.error(`WhatsApp router: no client registered for phone_number_id ${phoneNumberId}`);
          continue;
        }
        const forwarded = { object: req.body.object, entry: [{ id: entry.id, changes: [change] }] };
        try {
          const fwdRes = await fetch(`https://${client.subdomain}/webhook/whatsapp`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(forwarded),
          });
          if (!fwdRes.ok) console.error(`WhatsApp router: forward to ${client.name} failed ${fwdRes.status}`);
        } catch (err) {
          console.error(`WhatsApp router: forward to ${client.name} threw:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('WhatsApp router failed:', err);
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true, clients: registry.clients?.length || 0 }));

const port = process.env.PORT || 8090;
app.listen(port, () => console.log(`wa-router listening on ${port}`));
