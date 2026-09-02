import express from 'express';
import basicAuth from 'express-basic-auth';
import path from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadRegistry, saveRegistry, findClient, upsertClient } from '../scripts/lib/registry.mjs';
import { loadSecrets, patchSecrets } from '../scripts/lib/secrets.mjs';
import { getServer, monthlyPriceForServer } from '../scripts/lib/hetzner.mjs';
import { startJob, getJob, runScript } from './jobs.mjs';
import { router as workstationRoutes } from './routes/workstation.js';
import { router as workstationEsfRoutes } from './routes/workstation-esf.js';
import { main as runBotHealthCheck } from '../scripts/check-bot-health.mjs';

const MIGRATIONS_DIR = path.join(process.cwd(), '..', 'ebos-templates', 'migrations');
// Read once at boot, not per-request -- this is a static doc, not data.
const OFFBOARDING_SOP = readFileSync(path.join(process.cwd(), 'offboarding-sop.md'), 'utf8');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSTATION_DIST = path.join(__dirname, 'workstation', 'dist');
const WORKSTATION_ESF_DIST = path.join(__dirname, 'workstation-esf', 'dist');
const app = express();
app.use(express.json());

// Public on purpose, before the auth gate below -- Meta's App Review needs
// to reach this without credentials.
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'privacy-policy.html'));
});

// The real per-client WhatsApp router. One Meta App (ERA's own, used via
// Embedded Signup) serves every EBOS client -- each gets its own WABA and
// phone number, but Meta only allows ONE webhook callback per app, so
// something has to fan inbound messages back out to each client's own
// dedicated server by phone_number_id. This is that fan-out, owned by ERA
// on ERA's own infrastructure -- not dependent on any other product's
// uptime (the earlier version of this idea leaned on Nexa's webhook for one
// client and that coupling caused real outages when Nexa redeployed).
// Registry lookup, not a database: whatsappPhoneNumberId is set on a
// client's registry entry once its number is connected (add-whatsapp.mjs,
// or the Embedded Signup completion flow once that's wired up), same
// mechanism already used for every other per-client fact here.
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;

// Lets the standalone WhatsApp router (wa-router/, deployed on era-demo's
// own server so routing never depends on this box's uptime) pull a fresh
// copy of the registry on its own schedule, instead of a manual file copy
// someone has to remember every time a new client's WhatsApp number is
// connected. Shared-secret header, not session/basic-auth -- this is
// server-to-server, no browser involved.
const REGISTRY_SYNC_TOKEN = process.env.REGISTRY_SYNC_TOKEN;
app.get('/internal/registry', (req, res) => {
  if (!REGISTRY_SYNC_TOKEN || req.header('x-registry-sync-token') !== REGISTRY_SYNC_TOKEN) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  res.json(loadRegistry());
});

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
    const registry = loadRegistry();
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

// PANEL_DISABLE_AUTH is for local dev only (browser automation can't get
// past a native basic-auth prompt) -- never set on a real deployment,
// nothing here reads it from anywhere but an explicit local env var.
if (process.env.PANEL_DISABLE_AUTH !== '1') {
  app.use(
    basicAuth({
      users: { [process.env.PANEL_USER || 'admin']: process.env.PANEL_PASSWORD },
      challenge: true,
    })
  );
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Every EBOS business is its own full, physically separate stack (see
// README.md/schema.sql) -- create-client.mjs marks each one isEbos: true in
// the registry as it's provisioned, so there can be many of these, not one.
function getEbosClients(registry) {
  return registry.clients.filter((c) => c.isEbos);
}

// One business's live status: is its site actually reachable right now,
// what has it spent on real Claude calls this month (self-reported by its
// own dashboard, via engine/claude.js's ai_usage log -- Anthropic's own
// billing can't split this out since every business shares one API key),
// and what does its Hetzner server itself cost per month. Errors on any one
// piece never take down the whole row -- a business that's actually down is
// exactly the thing this is supposed to surface, not something to hide
// behind a failed Promise.all.
async function ebosBusinessStatus(client, hetznerToken) {
  const [up, usage, serverCost, monitor, deliveryConfig, voiceConfig] = await Promise.all([
    fetch(`https://${client.subdomain}/healthz`, { signal: AbortSignal.timeout(6000) })
      .then((res) => res.ok)
      .catch(() => false),
    fetch(`https://${client.subdomain}/api/usage-summary`, {
      headers: { 'x-era-admin-token': client.ebosAdminToken || '' },
      signal: AbortSignal.timeout(6000),
    })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null),
    client.serverId && hetznerToken
      ? getServer(hetznerToken, client.serverId)
          .then((server) => monthlyPriceForServer(server))
          .catch(() => null)
      : Promise.resolve(null),
    // Bot Monitoring's counts half -- see ebos-templates/dashboard/routes/
    // api.js's /monitor/summary. Same trust/fetch pattern as usage-summary
    // above, just a different endpoint on the same business.
    fetch(`https://${client.subdomain}/api/monitor/summary?hours=1`, {
      headers: { 'x-era-admin-token': client.ebosAdminToken || '' },
      signal: AbortSignal.timeout(6000),
    })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null),
    // Delivery add-on (own_riders mode) -- lives in that business's own
    // database, not the registry, unlike chowdeckEnabled above (a .env
    // flag this panel already knows without asking). Same trust/fetch
    // pattern as usage-summary/monitor above.
    fetch(`https://${client.subdomain}/api/delivery-config`, {
      headers: { 'x-era-admin-token': client.ebosAdminToken || '' },
      signal: AbortSignal.timeout(6000),
    })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null),
    // Voice ordering add-on -- same shape as deliveryConfig immediately
    // above, own business database, off by default.
    fetch(`https://${client.subdomain}/api/voice-config`, {
      headers: { 'x-era-admin-token': client.ebosAdminToken || '' },
      signal: AbortSignal.timeout(6000),
    })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null),
  ]);
  // codeErrorCount only -- real bot exceptions + AI/API failures, not
  // ordinary business activity (handovers, kb misses, unparsed answers).
  // See ebos-templates/dashboard/routes/api.js's /monitor/summary comment.
  const concernCount1h = monitor ? monitor.codeErrorCount : null;
  return {
    name: client.name,
    displayName: client.displayName || client.name,
    subdomain: client.subdomain,
    up,
    aiCostThisMonthUsd: usage?.totalCostUsd ?? null,
    aiCallsThisMonth: usage?.totalCalls ?? null,
    recentErrorCount: usage?.recentErrorCount ?? null,
    lastErrorMessage: usage?.lastErrorMessage ?? null,
    serverCostMonthlyUsd: serverCost,
    lastPushedAt: client.lastPushedAt || null,
    chowdeckEnabled: Boolean(client.chowdeckEnabled),
    deliveryMode: deliveryConfig?.mode || 'none',
    voiceEnabled: Boolean(voiceConfig?.enabled),
    offboarded: Boolean(client.offboarded),
    concernCount1h,
    concernBreakdown1h: monitor,
  };
}

// Merges recent real conversation content across every EBOS business into
// one chronological feed -- the "let me actually watch" surface (see
// ebos-templates/dashboard/routes/api.js's /monitor/feed), not gated
// behind any flag. Errors on one business's fetch just mean that
// business's messages are missing from this round, same non-blocking
// shape as ebosBusinessStatus above.
async function ebosMonitorFeed(client, hours) {
  try {
    const res = await fetch(`https://${client.subdomain}/api/monitor/feed?hours=${hours}`, {
      headers: { 'x-era-admin-token': client.ebosAdminToken || '' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const rows = await res.json();
    return rows.map((r) => ({ ...r, businessName: client.displayName || client.name }));
  } catch {
    return [];
  }
}

function clientRow(c) {
  const dnsRow = c.dnsPending
    ? `
    <tr>
      <td colspan="9" style="background:#fff3cd;border-top:none;">
        <strong>DNS not confirmed for ${esc(c.displayName || c.name)}</strong> — add this, then confirm:
        <pre style="white-space:pre-wrap;margin:6px 0;">${esc(c.dnsPendingInstructions || '')}</pre>
        <button onclick="confirmDns('${esc(c.name)}')">Mark DNS confirmed</button>
      </td>
    </tr>`
    : '';
  return `
    <tr>
      <td>${esc(c.displayName || c.name)}</td>
      <td><a href="https://${esc(c.subdomain)}" target="_blank">${esc(c.subdomain)}</a></td>
      <td>${esc(c.provider)}</td>
      <td>${esc(c.ip)}</td>
      <td>${c.needsWhatsapp ? 'yes' : 'no'}</td>
      <td>${c.needsPayment ? esc(c.paymentProvider) : 'no'}</td>
      <td>${c.isEbos ? '—' : c.hasBotEngine ? 'yes' : 'no'}</td>
      <td>
        <a class="claude-hint" href="eraterm://${esc(c.name)}" title="Opens a real terminal on this computer, already in this business's folder (C:\\Users\\user\\${esc(c.name)}). One-time setup needed first: that folder must exist locally, and the eraterm:// link handler must be registered on this machine.">Open terminal</a><br>
        <code class="claude-hint" style="margin-top:4px;display:inline-block;" title="Type this once you're in the terminal, or after /rename once to start.">claude --resume ${esc(c.displayName || c.name)}</code>
      </td>
      <td>
        <button onclick="showPanel('${esc(c.name)}')">Manage</button>
      </td>
    </tr>${dnsRow}`;
}

function businessesSection(ebosClients) {
  if (!ebosClients.length) {
    return `<h2>EBOS Businesses</h2><p>No EBOS business provisioned yet. Build one from the workstation above, or from the control server: <code>node scripts/create-client.mjs --name="Business Name" --template=ebos --ebos-seed=path/to/config.json</code>.</p>`;
  }
  const businessOptions = ebosClients.map((c) => `<option value="${esc(c.name)}">${esc(c.displayName || c.name)}</option>`).join('');
  return `
  <h2>EBOS Businesses</h2>
  <p class="muted">Each row is its own separate server/database -- status, this month's real Claude spend, and this month's server cost, checked live.</p>
  <div id="ebosTotals" style="margin:10px 0;font-size:14px;">Loading totals...</div>
  <button onclick="pushUpdate(null, true)" title="Rolls out the current template/dashboard code to every EBOS business at once -- secrets are read back from each server and reused, never regenerated.">Push code update to all EBOS businesses</button>
  <table>
    <tr><th>Name</th><th>Status</th><th>AI cost (this month)</th><th>Server cost (monthly)</th><th title="Real bot errors and AI/API failures in the last hour -- not handovers or normal business activity, just signs the engine itself is broken.">Code errors (1h)</th><th>Chowdeck delivery</th><th>Own-rider delivery</th><th>Voice ordering</th><th>Last code push</th></tr>
    <tbody id="ebosStatusRows"><tr><td colspan="9">Loading...</td></tr></tbody>
  </table>

  <p><a href="/monitoring">Open Bot Monitoring &rarr;</a> &mdash; the full live feed across every business, on its own page so this one stays fast as you add more businesses. "Code errors (1h)" above is still the quick at-a-glance number.</p>

  <fieldset>
    <legend>Fix-bot (WhatsApp-triggered investigation agent)</legend>
    <p class="muted">Texting "fix" (or replying to a Bot Monitoring alert) on Bali's WhatsApp number triggers this. If it seems stuck or unresponsive, restart it here -- no SSH, no asking Claude.</p>
    <button type="button" onclick="restartFixbot()">Restart fix-bot</button>
  </fieldset>

  <fieldset>
    <legend>Central Chowdeck account</legend>
    <p class="muted">One shared account, used by every business you toggle on above -- set or rotate it here instead of by hand on the server. Status: <span id="chowdeckSecretStatus">checking...</span></p>
    <form id="chowdeckSecretForm">
      <label>Chowdeck secret key</label><input name="secretKey" type="password" required>
      <label>Chowdeck merchant reference</label><input name="merchantReference" required>
      <button type="submit">Save</button>
    </form>
  </fieldset>

  <fieldset>
    <legend>Run a database migration</legend>
    <p class="muted">Additive-only schema files already written and reviewed (ebos-templates/migrations/) -- pick one and where to run it.</p>
    <form id="migrateForm">
      <label>Migration file</label>
      <select name="file" id="migrationFileSelect"><option>Loading...</option></select>
      <label>Target</label>
      <select name="target">
        <option value="all">All EBOS businesses</option>
        ${businessOptions}
      </select>
      <button type="submit">Run migration</button>
    </form>
  </fieldset>`;
}

function page(clients, ebosClients) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ERA Dash OS</title>
<style>
  * { box-sizing: border-box; overflow-wrap: break-word; word-break: break-word; min-width: 0; }
  html, body { overflow-x: hidden; max-width: 100vw; }
  body { font-family: sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  td, th { border: 1px solid #ccc; padding: 6px 10px; text-align: left; font-size: 14px; }
  fieldset { margin: 1rem 0; }
  label { display: block; margin: 6px 0 2px; font-size: 14px; }
  input, select { padding: 6px; width: 260px; max-width: 100%; }
  button { margin-top: 10px; padding: 6px 14px; cursor: pointer; }
  #log { background: #111; color: #0f0; padding: 10px; height: 220px; overflow-y: auto; white-space: pre-wrap; font-family: monospace; font-size: 12px; }
  .hidden { display: none; }
  .danger { color: #b00; }
  .claude-hint { font-family: monospace; font-size: 12px; background: #f0f0f0; padding: 2px 4px; border-radius: 3px; cursor: help; }
  @media (max-width: 860px) {
    body { margin: 1rem auto; padding: 0 12px; font-size: 15px; }
    /* Wide operational tables (9 columns on the Clients table) scroll
       within themselves on a phone instead of shrinking to unreadable
       text or blowing out the page. */
    table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; white-space: nowrap; }
    input, select { width: 100%; min-height: 40px; font-size: 15px; }
    button { min-height: 40px; font-size: 15px; padding: 8px 14px; }
  }
</style>
</head>
<body>
  <h1>ERA Dash OS</h1>
  <p><a href="/workstation">Open the EBOS build workstation &rarr;</a> &mdash; build a new business's ordering/booking app by clicking through, no coding.</p>
  <p><a href="/workstation-esf">Open the ESF build workstation &rarr;</a> &mdash; build a new business's staff workflow app by clicking through, no coding.</p>

  <h2>Clients</h2>
  <table>
    <tr><th>Name</th><th>URL</th><th>Provider</th><th>IP</th><th>WhatsApp</th><th>Payment</th><th>Bot engine</th><th>Claude session</th><th></th></tr>
    ${clients.map(clientRow).join('') || '<tr><td colspan="9">No clients yet.</td></tr>'}
  </table>

  ${businessesSection(ebosClients)}

  <fieldset>
    <legend>Control server standby / failover</legend>
    <p class="muted">era-relay-standby is a second, independent copy of this whole control server (own IP, own Caddy, own TLS) -- ready in case this primary server ever goes down. Reachable directly at <a href="https://dash-standby.erasystems.com.ng" target="_blank">dash-standby.erasystems.com.ng</a> any time, for a no-risk check.</p>
    <button type="button" onclick="syncStandby()" title="Copies the current code, business registry, and secrets from this server to the standby. Run this any time after a real change -- new business, rotated secret, code push.">Sync to standby now</button>
    <button type="button" class="danger" onclick="doFailover('standby')" title="Repoints dash.erasystems.com.ng at the standby server. Only do this if this primary server is genuinely down or unreachable.">Switch dash.erasystems.com.ng to standby</button>
    <button type="button" onclick="doFailover('primary')" title="Switches dash.erasystems.com.ng back to this primary server.">Switch back to primary</button>
  </fieldset>

  <fieldset>
    <legend>Create new client</legend>
    <form id="createForm">
      <label>Client name</label>
      <input name="name" required placeholder="e.g. Sunset Catering">
      <label>Subdomain (optional, auto-generated from name if blank)</label>
      <input name="subdomain" placeholder="e.g. sunset-catering">
      <label>Custom domain instead (they own their own domain -- leave Subdomain blank if using this)</label>
      <input name="customDomain" placeholder="e.g. goldshop.com">
      <label><input type="checkbox" name="whatsapp" style="width:auto"> Needs WhatsApp</label>
      <label><input type="checkbox" name="pdf" style="width:auto"> Needs PDF documents</label>
      <label>Needs payment?</label>
      <select name="payment">
        <option value="">No</option>
        <option value="flutterwave">Flutterwave</option>
        <option value="paystack">Paystack</option>
      </select>
      <label>Size</label>
      <select name="size">
        <option value="small">Small</option>
        <option value="medium">Medium</option>
        <option value="large">Large</option>
      </select>
      <button type="submit">Create client</button>
    </form>
  </fieldset>

  <fieldset id="managePanel" class="hidden">
    <legend>Manage: <span id="manageClientName"></span></legend>

    <div id="manageEbosMonitoring" class="hidden" style="background:#f7f7f7;padding:10px;border-radius:4px;margin-bottom:14px;font-size:14px;"></div>

    <h4>Add / update WhatsApp</h4>
    <form id="whatsappForm">
      <label>Meta access token</label><input name="token" required>
      <label>Phone number ID</label><input name="phoneId" required>
      <label>Webhook verify token</label><input name="verifyToken" required>
      <button type="submit">Add WhatsApp</button>
    </form>

    <h4>Add / update Instagram</h4>
    <form id="instagramForm">
      <label>Instagram user ID</label><input name="userId" required>
      <label>Meta access token</label><input name="token" required>
      <label>Webhook verify token</label><input name="verifyToken" required>
      <button type="submit">Add Instagram</button>
    </form>

    <h4>Add / update payment</h4>
    <form id="paymentForm">
      <label>Provider</label>
      <select name="provider"><option value="flutterwave">Flutterwave</option><option value="paystack">Paystack</option></select>
      <label>Secret key</label><input name="secretKey" required>
      <label>Public key</label><input name="publicKey" required>
      <button type="submit">Add payment</button>
    </form>

    <h4>Environment variables</h4>
    <button type="button" onclick="loadEnv()">Load current</button>
    <div id="envList" style="margin:10px 0;font-family:monospace;font-size:12px;"></div>
    <form id="envForm">
      <label>Add / update (one KEY=value per line)</label>
      <textarea name="vars" rows="5" style="width:100%;font-family:monospace;font-size:13px;" placeholder="OPENAI_API_KEY=sk-...&#10;SOME_OTHER_VAR=value" required></textarea>
      <button type="submit">Set env vars</button>
    </form>

    <h4 class="danger">Tear down (deletes the server + repo, permanent)</h4>
    <form id="teardownForm">
      <label><input type="checkbox" name="confirm" required style="width:auto"> Yes, permanently delete this client</label>
      <button type="submit" class="danger">Tear down</button>
    </form>
  </fieldset>

  <h2>Output</h2>
  <div id="log">(idle)</div>

<script>
let currentClient = null;
let lastEbosStatus = [];
const OFFBOARDING_SOP_TEXT = ${JSON.stringify(OFFBOARDING_SOP)};

function renderManageMonitoring(name) {
  const el = document.getElementById('manageEbosMonitoring');
  const b = lastEbosStatus.find((x) => x.name === name);
  if (!b) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = '<strong>' + (b.up ? 'Up' : '<span class="danger">Down</span>')
    + '</strong> &mdash; AI cost this month: <strong>' + fmtUsd(b.aiCostThisMonthUsd) + '</strong>'
    + (b.aiCallsThisMonth != null ? ' (' + b.aiCallsThisMonth + ' calls)' : '')
    + ' &mdash; server: <strong>' + fmtUsd(b.serverCostMonthlyUsd) + '</strong>/mo'
    + ' &mdash; Chowdeck: <strong>' + (b.chowdeckEnabled ? 'on' : 'off') + '</strong>'
    + ' &mdash; last code push: ' + (b.lastPushedAt ? new Date(b.lastPushedAt).toLocaleString() : 'never')
    + (b.recentErrorCount ? '<br><strong class="danger">' + b.recentErrorCount + ' Claude/API error(s) in the last 30 min</strong>: ' + escClient(b.lastErrorMessage || '(no message)') : '')
    + (b.offboarded ? '<br><strong class="danger">Offboarded</strong> -- data was exported, server is still running untouched.' : '')
    + '<br><button type="button" id="mgmtPushBtn" style="margin-top:8px;">Push code update to this business</button>'
    + ' <button type="button" id="mgmtOffboardBtn" style="margin-top:8px;" title="Exports all of this business\\'s data and marks it offboarded. Never deletes the server or database -- that stays a separate, later, deliberate step.">Begin offboarding (exports data, never deletes anything)</button>'
    + '<details style="margin-top:8px;"><summary style="cursor:pointer;">Offboarding steps (SOP)</summary><pre style="white-space:pre-wrap;font-family:inherit;font-size:13px;background:#fff;padding:10px;border-radius:4px;margin-top:6px;">' + escClient(OFFBOARDING_SOP_TEXT) + '</pre></details>'
    + '<div id="waCatalogBlock" style="margin-top:10px;padding-top:10px;border-top:1px solid #ddd;">Loading WhatsApp Catalogue status...</div>';
  // Assigned via closure over the name variable, not string-built into an
  // inline onclick= attribute -- the previous version concatenated an
  // escaped JS-string literal (itself containing a double-quoted
  // .replace() call) straight into a double-quoted HTML attribute. That
  // collision broke out of the attribute on the embedded double-quote,
  // corrupting the rest of the page's inline script and leaving showPanel
  // undefined -- confirmed live via the browser console (SyntaxError at
  // parse time, then "showPanel is not defined" on click). A closure
  // sidesteps the whole class of escaping bug -- no attribute-quote
  // collision possible.
  document.getElementById('mgmtPushBtn').onclick = () => pushUpdate(name);
  document.getElementById('mgmtOffboardBtn').onclick = () => offboardBusiness(name);
  loadWaCatalogStatus(name);
}

async function loadWaCatalogStatus(name) {
  const el = document.getElementById('waCatalogBlock');
  try {
    const res = await fetch('/api/ebos/whatsapp-catalog-status?client=' + encodeURIComponent(name));
    const s = await res.json();
    if (!res.ok) { el.innerHTML = '<strong>WhatsApp Catalogue:</strong> <span class="danger">' + escClient(s.error || 'error') + '</span>'; return; }
    renderWaCatalogBlock(name, s);
  } catch (err) {
    el.innerHTML = '<strong>WhatsApp Catalogue:</strong> <span class="danger">' + escClient(err.message) + '</span>';
  }
}

function renderWaCatalogBlock(name, s) {
  const el = document.getElementById('waCatalogBlock');
  const n = "'" + name.replace(/'/g, "\\'") + "'";
  if (!s.catalogId) {
    el.innerHTML = '<strong>WhatsApp Catalogue:</strong> not set up.'
      + '<br><button type="button" style="margin-top:6px;" onclick="waCatalogEnable(' + n + ')">Enable WhatsApp Catalogue</button>';
  } else if (!s.connected) {
    el.innerHTML = '<strong>WhatsApp Catalogue:</strong> created and synced, not yet connected in Meta.'
      + '<p class="hint" style="margin:6px 0;">One manual step Meta doesn\\'t allow by API: in Meta Business Suite, go to WhatsApp Manager &rarr; Catalog, choose this business\\'s catalogue, click Connect Catalog.</p>'
      + '<button type="button" onclick="waCatalogConfirm(' + n + ')">I\\'ve connected it -- mark as done</button>';
  } else {
    el.innerHTML = '<strong>WhatsApp Catalogue:</strong> <span class="badge active">Connected</span>'
      + ' <button type="button" style="margin-left:8px;" onclick="waCatalogResync(' + n + ')">Resync now</button>';
  }
}

async function waCatalogEnable(name) {
  const el = document.getElementById('waCatalogBlock');
  el.innerHTML = 'Setting up...';
  const res = await fetch('/api/ebos/whatsapp-catalog-enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: name }) });
  const s = await res.json();
  if (!res.ok) { alert(s.error || 'Failed'); loadWaCatalogStatus(name); return; }
  alert('Synced ' + s.synced + ' item(s).' + (s.skippedNoPhoto ? ' ' + s.skippedNoPhoto + ' skipped (no photo).' : ''));
  renderWaCatalogBlock(name, s);
}

async function waCatalogResync(name) {
  const el = document.getElementById('waCatalogBlock');
  el.innerHTML = 'Syncing...';
  const res = await fetch('/api/ebos/whatsapp-catalog-resync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: name }) });
  const s = await res.json();
  if (!res.ok) { alert(s.error || 'Failed'); }
  else alert('Synced ' + s.synced + ' item(s).' + (s.skippedNoPhoto ? ' ' + s.skippedNoPhoto + ' skipped (no photo).' : ''));
  loadWaCatalogStatus(name);
}

async function waCatalogConfirm(name) {
  const res = await fetch('/api/ebos/whatsapp-catalog-confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: name }) });
  const s = await res.json();
  if (!res.ok) { alert(s.error || 'Failed'); return; }
  loadWaCatalogStatus(name);
}

async function offboardBusiness(name) {
  if (!confirm('Export ' + name + '\\'s data and mark it offboarded? This does NOT delete their server or database -- only exports their data and flags them as offboarded. You still need to release their WhatsApp number in Meta Business Manager separately.')) return;
  const res = await fetch('/api/ebos/offboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: name }) });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Failed'); return; }
  pollJob(data.jobId, () => loadEbosStatus());
}

async function syncStandby() {
  const res = await fetch('/api/ebos/sync-standby', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Failed'); return; }
  pollJob(data.jobId);
}

async function doFailover(to) {
  const msg = to === 'standby'
    ? 'Switch dash.erasystems.com.ng to the STANDBY server? Only do this if the primary is genuinely down. DNS takes a few minutes to fully propagate.'
    : 'Switch dash.erasystems.com.ng back to the PRIMARY server?';
  if (!confirm(msg)) return;
  const res = await fetch('/api/ebos/failover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to }) });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Failed'); return; }
  pollJob(data.jobId);
}

function showPanel(name) {
  currentClient = name;
  document.getElementById('manageClientName').textContent = name;
  document.getElementById('managePanel').classList.remove('hidden');
  renderManageMonitoring(name);
}

function pollJob(jobId, onDone) {
  const logEl = document.getElementById('log');
  logEl.textContent = '';
  const iv = setInterval(async () => {
    const res = await fetch('/api/jobs/' + jobId);
    const job = await res.json();
    logEl.textContent = job.log || '(no output yet)';
    logEl.scrollTop = logEl.scrollHeight;
    if (job.status !== 'running') {
      clearInterval(iv);
      logEl.textContent += '\\n\\n-- ' + job.status.toUpperCase() + ' --';
      if (onDone) onDone(job);
    }
  }, 2000);
}

async function submitJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Failed'); return; }
  pollJob(data.jobId, () => setTimeout(() => location.reload(), 1500));
}

document.getElementById('createForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  submitJson('/api/create', {
    name: f.get('name'),
    subdomain: f.get('subdomain') || undefined,
    customDomain: f.get('customDomain') || undefined,
    whatsapp: f.get('whatsapp') === 'on',
    pdf: f.get('pdf') === 'on',
    payment: f.get('payment') || undefined,
    size: f.get('size'),
  });
});

document.getElementById('whatsappForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  submitJson('/api/add-whatsapp', { client: currentClient, token: f.get('token'), phoneId: f.get('phoneId'), verifyToken: f.get('verifyToken') });
});

document.getElementById('instagramForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  submitJson('/api/add-instagram', { client: currentClient, userId: f.get('userId'), token: f.get('token'), verifyToken: f.get('verifyToken') });
});

document.getElementById('paymentForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  submitJson('/api/add-payment', { client: currentClient, provider: f.get('provider'), secretKey: f.get('secretKey'), publicKey: f.get('publicKey') });
});

async function loadEnv() {
  const el = document.getElementById('envList');
  el.textContent = 'Loading...';
  const res = await fetch('/api/env/' + currentClient);
  const data = await res.json();
  if (!res.ok) { el.textContent = 'Error: ' + (data.error || 'failed to load'); return; }
  el.innerHTML = data.length
    ? data.map((e) => '<div>' + e.key + '=' + e.value + '</div>').join('')
    : '(no .env found or it is empty)';
}

document.getElementById('envForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = new FormData(e.target).get('vars');
  const updates = {};
  for (const line of raw.split('\\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    updates[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  if (Object.keys(updates).length === 0) { alert('No valid KEY=value lines found.'); return; }
  submitJson('/api/set-env', { client: currentClient, updates });
});

async function pushUpdate(name, allEbos) {
  const label = allEbos ? 'every EBOS business' : name;
  if (!confirm('Push the current code to ' + label + '? This rebuilds the dashboard container -- secrets are reused as-is, nothing is regenerated.')) return;
  const res = await fetch('/api/push-update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(allEbos ? { allEbos: true } : { client: name }) });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Failed'); return; }
  pollJob(data.jobId, () => setTimeout(() => location.reload(), 1500));
}

async function restartFixbot() {
  if (!confirm('Restart the fix-bot service? Any investigation currently in progress will be interrupted.')) return;
  const res = await fetch('/api/fixbot/restart', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Failed'); return; }
  pollJob(data.jobId);
}

async function confirmDns(name) {
  const res = await fetch('/api/confirm-dns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: name }) });
  if (!res.ok) { alert('Failed to confirm'); return; }
  location.reload();
}

document.getElementById('teardownForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!confirm('Really tear down ' + currentClient + '? This deletes the server and cannot be undone.')) return;
  submitJson('/api/teardown', { client: currentClient, confirm: true });
});

function escClient(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

function fmtUsd(value) {
  return value == null ? '?' : '$' + Number(value).toFixed(2);
}

function renderEbosTotals(data) {
  const totalsEl = document.getElementById('ebosTotals');
  if (!totalsEl) return;
  if (!data.length) { totalsEl.textContent = ''; return; }
  const downCount = data.filter((b) => !b.up).length;
  const sum = (key) => data.reduce((s, b) => (b[key] != null ? s + b[key] : s), 0);
  const missing = (key) => data.some((b) => b[key] == null);
  const aiTotal = fmtUsd(sum('aiCostThisMonthUsd')) + (missing('aiCostThisMonthUsd') ? ' (some unknown)' : '');
  const serverTotal = fmtUsd(sum('serverCostMonthlyUsd')) + (missing('serverCostMonthlyUsd') ? ' (some unknown)' : '');
  totalsEl.innerHTML = '<strong>' + data.length + ' business' + (data.length === 1 ? '' : 'es') + '</strong>'
    + (downCount ? ', <strong class="danger">' + downCount + ' down</strong>' : ', all up')
    + ' &mdash; total AI cost this month: <strong>' + aiTotal + '</strong>'
    + ' &mdash; total server cost: <strong>' + serverTotal + '</strong>/mo';
}

async function toggleChowdeck(name, enabled) {
  if (!confirm((enabled ? 'Enable' : 'Disable') + ' Chowdeck delivery for ' + name + '? Uses the one shared Chowdeck account for every business.')) {
    loadEbosStatus();
    return;
  }
  const res = await fetch('/api/ebos/chowdeck-toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: name, enabled }) });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Failed'); loadEbosStatus(); return; }
  pollJob(data.jobId, () => loadEbosStatus());
}

async function toggleDeliveryMode(name, enabled) {
  if (!confirm((enabled ? 'Enable' : 'Disable') + ' own-rider delivery for ' + name + '?')) {
    loadEbosStatus();
    return;
  }
  const res = await fetch('/api/ebos/delivery-mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: name, mode: enabled ? 'own_riders' : 'none' }) });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Failed'); loadEbosStatus(); return; }
  loadEbosStatus();
}

async function toggleVoiceMode(name, enabled) {
  if (!confirm((enabled ? 'Enable' : 'Disable') + ' voice ordering for ' + name + '?')) {
    loadEbosStatus();
    return;
  }
  const res = await fetch('/api/ebos/voice-mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: name, enabled }) });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Failed'); loadEbosStatus(); return; }
  loadEbosStatus();
}

async function loadEbosStatus() {
  const el = document.getElementById('ebosStatusRows');
  if (!el) return;
  try {
    const res = await fetch('/api/ebos/status');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'failed to load');
    lastEbosStatus = data;
    if (currentClient) renderManageMonitoring(currentClient);
    renderEbosTotals(data);
    el.innerHTML = data.length
      ? data.map((b) =>
          '<tr>'
          + '<td>' + escClient(b.displayName) + '<br><a href="https://' + escClient(b.subdomain) + '" target="_blank">' + escClient(b.subdomain) + '</a></td>'
          + '<td>' + (b.up ? 'up' : '<strong class="danger">down</strong>') + '</td>'
          + '<td>' + fmtUsd(b.aiCostThisMonthUsd) + (b.aiCallsThisMonth != null ? ' (' + b.aiCallsThisMonth + ' calls)' : '') + '</td>'
          + '<td>' + fmtUsd(b.serverCostMonthlyUsd) + '</td>'
          + '<td>' + (b.concernCount1h == null ? '?' : (b.concernCount1h > 0 ? '<strong class="danger">' + b.concernCount1h + '</strong>' : '0')) + '</td>'
          + '<td><label><input type="checkbox" style="width:auto" ' + (b.chowdeckEnabled ? 'checked' : '') + ' onchange="toggleChowdeck(\\'' + escClient(b.name) + '\\', this.checked)"> ' + (b.chowdeckEnabled ? 'on' : 'off') + '</label></td>'
          + '<td><label><input type="checkbox" style="width:auto" ' + (b.deliveryMode === 'own_riders' ? 'checked' : '') + ' onchange="toggleDeliveryMode(\\'' + escClient(b.name) + '\\', this.checked)"> ' + (b.deliveryMode === 'own_riders' ? 'on' : 'off') + '</label></td>'
          + '<td><label><input type="checkbox" style="width:auto" ' + (b.voiceEnabled ? 'checked' : '') + ' onchange="toggleVoiceMode(\\'' + escClient(b.name) + '\\', this.checked)"> ' + (b.voiceEnabled ? 'on' : 'off') + '</label></td>'
          + '<td>' + (b.lastPushedAt ? new Date(b.lastPushedAt).toLocaleString() : 'never') + '</td>'
          + '</tr>'
        ).join('')
      : '<tr><td colspan="9">No businesses yet.</td></tr>';
  } catch (err) {
    const totalsEl = document.getElementById('ebosTotals');
    if (totalsEl) totalsEl.textContent = '';
    el.innerHTML = '<tr><td colspan="9">Error: ' + escClient(err.message) + '</td></tr>';
  }
}
loadEbosStatus();
setInterval(loadEbosStatus, 60000);

async function loadChowdeckSecretStatus() {
  const el = document.getElementById('chowdeckSecretStatus');
  if (!el) return;
  try {
    const res = await fetch('/api/ebos/chowdeck-secret-status');
    const data = await res.json();
    el.textContent = data.configured ? 'configured' : 'not set yet';
  } catch (err) {
    el.textContent = 'error checking';
  }
}
loadChowdeckSecretStatus();

const chowdeckSecretForm = document.getElementById('chowdeckSecretForm');
if (chowdeckSecretForm) {
  chowdeckSecretForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const res = await fetch('/api/ebos/chowdeck-secret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secretKey: f.get('secretKey'), merchantReference: f.get('merchantReference') }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Failed'); return; }
    e.target.reset();
    loadChowdeckSecretStatus();
    alert('Saved. Toggle Chowdeck on for a business above to start using it.');
  });
}

async function loadMigrationFiles() {
  const el = document.getElementById('migrationFileSelect');
  if (!el) return;
  try {
    const res = await fetch('/api/ebos/migrations');
    const files = await res.json();
    el.innerHTML = files.length
      ? files.map((f) => '<option value="' + escClient(f) + '">' + escClient(f) + '</option>').join('')
      : '<option value="">No migration files found</option>';
  } catch (err) {
    el.innerHTML = '<option value="">Error loading files</option>';
  }
}
loadMigrationFiles();

const migrateForm = document.getElementById('migrateForm');
if (migrateForm) {
  migrateForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const file = f.get('file');
    const target = f.get('target');
    if (!file) { alert('No migration file selected.'); return; }
    if (!confirm('Run ' + file + ' against ' + (target === 'all' ? 'ALL EBOS businesses' : target) + '? This changes database schema.')) return;
    const body = target === 'all' ? { allEbos: true, file } : { client: target, file };
    const res = await fetch('/api/ebos/migrate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Failed'); return; }
    pollJob(data.jobId);
  });
}
</script>
</body>
</html>`;
}

// Its own page, deliberately separate from the main dashboard -- the raw
// feed merges every EBOS business's recent messages, which stops being
// "quick to glance at" the moment there are enough businesses/volume for
// it to matter (Chidera's own example: 20 restaurants at ~200 messages
// each). The main page keeps only the lightweight per-business count
// ("Code errors (1h)"); this page is where you actually sit and watch.
function monitoringPage(ebosClients) {
  const businessOptions = ebosClients.map((c) => `<option value="${esc(c.name)}">${esc(c.displayName || c.name)}</option>`).join('');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bot Monitoring — ERA Dash OS</title>
<style>
  * { box-sizing: border-box; overflow-wrap: break-word; word-break: break-word; min-width: 0; }
  html, body { overflow-x: hidden; max-width: 100vw; }
  body { font-family: sans-serif; max-width: 1300px; margin: 2rem auto; padding: 0 1rem; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  td, th { border: 1px solid #ccc; padding: 6px 10px; text-align: left; font-size: 14px; }
  .muted { color: #666; font-size: 13px; }
  select, button { padding: 6px; }
  @media (max-width: 860px) {
    body { margin: 1rem auto; padding: 0 12px; font-size: 15px; }
    table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; white-space: nowrap; }
  }
</style>
</head>
<body>
  <p><a href="/">&larr; Back to ERA Dash OS</a></p>
  <h1>Bot Monitoring</h1>
  <p class="muted">Recent real conversations, merged into one feed -- not filtered to only flagged moments, so you can actually watch, not just wait to be told something's wrong. Rows highlighted in red are real code errors (the bot hit an exception, or a Claude/API call failed) -- the thing you're responsible for. Handovers and "bot didn't know that" are normal business activity, shown for context but not flagged.</p>
  <div style="margin:6px 0;">
    <label style="display:inline;">Business: </label>
    <select id="monitorClient" style="width:auto;display:inline;" onchange="loadMonitorFeed()">
      <option value="">All businesses</option>
      ${businessOptions}
    </select>
    <label style="display:inline;margin-left:10px;">Window: </label>
    <select id="monitorHours" style="width:auto;display:inline;" onchange="loadMonitorFeed()">
      <option value="1">Last 1 hour</option>
      <option value="3" selected>Last 3 hours</option>
      <option value="12">Last 12 hours</option>
      <option value="24">Last 24 hours</option>
    </select>
    <button type="button" style="margin:0 0 0 8px;" onclick="loadMonitorFeed()">Refresh now</button>
    <label style="margin-left:10px;"><input type="checkbox" id="monitorAutoRefresh" style="width:auto;" checked> Auto-refresh (20s)</label>
    <span id="monitorFeedStatus" class="muted" style="margin-left:8px;"></span>
  </div>
  <table>
    <tr><th>Time</th><th>Business</th><th>Customer</th><th>Dir</th><th>Trigger</th><th>Message</th></tr>
    <tbody id="monitorFeedRows"><tr><td colspan="6">Loading...</td></tr></tbody>
  </table>

<script>
function escClient(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

// Real code errors only -- matches ebos-templates/dashboard/routes/api.js's
// codeErrorCount definition. kb_miss/field_reprompt/handovers are normal
// business activity, shown for context but not flagged.
const MONITOR_CONCERN_TRIGGERS = ['error_recovery'];
let monitorTimer = null;

async function loadMonitorFeed() {
  const el = document.getElementById('monitorFeedRows');
  const statusEl = document.getElementById('monitorFeedStatus');
  const hours = document.getElementById('monitorHours').value;
  const client = document.getElementById('monitorClient').value;
  const url = '/api/ebos/monitor-feed?hours=' + hours + (client ? '&client=' + encodeURIComponent(client) : '');
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'failed to load');
    statusEl.textContent = data.length + ' messages, updated ' + new Date().toLocaleTimeString();
    el.innerHTML = data.length
      ? data.map((m) => {
          const flagged = MONITOR_CONCERN_TRIGGERS.includes(m.trigger);
          return '<tr' + (flagged ? ' style="background:#fff3cd;"' : '') + '>'
            + '<td>' + new Date(m.created_at).toLocaleString() + '</td>'
            + '<td>' + escClient(m.businessName) + '</td>'
            + '<td>' + escClient(m.customer_name || m.phone_number || '(unknown)') + '</td>'
            + '<td>' + escClient(m.direction) + '</td>'
            + '<td>' + escClient(m.trigger || '') + (flagged ? ' &#9888;' : '') + '</td>'
            + '<td style="white-space:pre-wrap;">' + escClient(m.body) + '</td>'
            + '</tr>';
        }).join('')
      : '<tr><td colspan="6">No messages in this window.</td></tr>';
  } catch (err) {
    el.innerHTML = '<tr><td colspan="6">Error: ' + escClient(err.message) + '</td></tr>';
    statusEl.textContent = '';
  }
}

function scheduleAutoRefresh() {
  if (monitorTimer) clearInterval(monitorTimer);
  if (document.getElementById('monitorAutoRefresh').checked) {
    monitorTimer = setInterval(loadMonitorFeed, 20000);
  }
}
document.getElementById('monitorAutoRefresh').addEventListener('change', scheduleAutoRefresh);

loadMonitorFeed();
scheduleAutoRefresh();
</script>
</body>
</html>`;
}

app.get('/monitoring', (req, res) => {
  const ebosClients = getEbosClients(loadRegistry());
  res.send(monitoringPage(ebosClients));
});

app.get('/', (req, res) => {
  const registry = loadRegistry();
  res.send(page(registry.clients, getEbosClients(registry)));
});

app.get('/api/ebos/status', async (req, res) => {
  const ebosClients = getEbosClients(loadRegistry());
  let hetznerToken = null;
  try {
    hetznerToken = loadSecrets().HETZNER_TOKEN || null;
  } catch {
    // Server cost just comes back null for every row below if secrets.env
    // can't be read -- uptime/AI cost still work without it.
  }
  const statuses = await Promise.all(ebosClients.map((c) => ebosBusinessStatus(c, hetznerToken)));
  res.json(statuses);
});

// Bot Monitoring's raw-content half -- merges every business's recent
// conversation feed into one chronological list, capped so the page stays
// readable no matter how many businesses are live.
app.get('/api/ebos/monitor-feed', async (req, res) => {
  const hours = Math.min(Number(req.query.hours) || 3, 24);
  let ebosClients = getEbosClients(loadRegistry());
  // Optional single-business filter -- the /monitoring page's real answer
  // to "20 restaurants x 200 messages gets excessive": narrow to one
  // business instead of always fetching and merging every business's feed.
  if (req.query.client) {
    ebosClients = ebosClients.filter((c) => c.name === req.query.client);
  }
  const perBusiness = await Promise.all(ebosClients.map((c) => ebosMonitorFeed(c, hours)));
  const merged = perBusiness
    .flat()
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 300);
  res.json(merged);
});

// WhatsApp Catalogue (Meta's native in-chat shop) -- ERA-side only, on
// purpose. Chidera doesn't want a business to see or trigger this setup
// themselves, so unlike the bot's own product list (which stays on their
// dashboard), these calls only exist here, authenticated with the
// business's ebosAdminToken exactly like ebosBusinessStatus above.
function ebosClientOrThrow(name) {
  const client = findClient(loadRegistry(), name);
  if (!client) throw Object.assign(new Error(`No client "${name}" in the registry.`), { status: 404 });
  return client;
}

async function callBusinessApi(client, path, method = 'GET', body) {
  const res = await fetch(`https://${client.subdomain}${path}`, {
    method,
    headers: {
      'x-era-admin-token': client.ebosAdminToken || '',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const responseBody = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(responseBody.error || `Business API returned ${res.status}`);
  return responseBody;
}

app.get('/api/ebos/whatsapp-catalog-status', async (req, res) => {
  try {
    const client = ebosClientOrThrow(req.query.client);
    res.json(await callBusinessApi(client, '/api/whatsapp-catalog/status'));
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/api/ebos/whatsapp-catalog-enable', async (req, res) => {
  try {
    const client = ebosClientOrThrow(req.body.client);
    res.json(await callBusinessApi(client, '/api/whatsapp-catalog/enable', 'POST'));
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/api/ebos/whatsapp-catalog-resync', async (req, res) => {
  try {
    const client = ebosClientOrThrow(req.body.client);
    res.json(await callBusinessApi(client, '/api/whatsapp-catalog/resync', 'POST'));
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/api/ebos/whatsapp-catalog-confirm', async (req, res) => {
  try {
    const client = ebosClientOrThrow(req.body.client);
    res.json(await callBusinessApi(client, '/api/whatsapp-catalog/confirm-connected', 'POST'));
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Delivery add-on mode (own_riders/relay/none) -- a database row on that
// business's own dashboard, not a registry/.env flag like chowdeckEnabled
// below, so this calls its API rather than editing anything here. relay
// isn't offered from this control -- own_riders and none only, since
// relay is blocked on a written Chowdeck commercial agreement per the
// addon spec and isn't being built against yet.
app.post('/api/ebos/delivery-mode', async (req, res) => {
  try {
    const { client: name, mode } = req.body;
    if (!['none', 'own_riders'].includes(mode)) return res.status(400).json({ error: 'mode must be "none" or "own_riders"' });
    const client = ebosClientOrThrow(name);
    res.json(await callBusinessApi(client, '/api/delivery-config', 'POST', { mode }));
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/api/ebos/voice-mode', async (req, res) => {
  try {
    const { client: name, enabled } = req.body;
    const client = ebosClientOrThrow(name);
    res.json(await callBusinessApi(client, '/api/voice-config', 'POST', { enabled: Boolean(enabled) }));
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// ONE shared Chowdeck account for every business, on purpose -- CHOWDECK_
// SECRET_KEY/CHOWDECK_MERCHANT_REFERENCE live once in secrets.env, never
// per-business. Turning this on for a business pushes those same two
// values into just that business's .env (surgical patch via set-env.mjs,
// not a template re-render -- see push-update.mjs's header comment for why
// that distinction matters). This is the ERA-side half of the two-tier
// gate; engine/delivery.js's chowdeckAvailable() still separately requires
// the business's own "Delivery enabled" toggle before it actually uses it.
app.post('/api/ebos/chowdeck-toggle', (req, res) => {
  const { client, enabled } = req.body;
  if (!client || typeof enabled !== 'boolean') return res.status(400).json({ error: 'client and enabled (boolean) are required' });
  if (!findClient(loadRegistry(), client)) return res.status(404).json({ error: `No client "${client}" in the registry.` });

  let secrets;
  try {
    secrets = loadSecrets();
  } catch (err) {
    return res.status(500).json({ error: `Could not read secrets.env: ${err.message}` });
  }
  if (enabled && (!secrets.CHOWDECK_SECRET_KEY || !secrets.CHOWDECK_MERCHANT_REFERENCE)) {
    return res.status(400).json({ error: 'Add CHOWDECK_SECRET_KEY and CHOWDECK_MERCHANT_REFERENCE to secrets.env first -- there is no per-business value to fall back to.' });
  }

  const args = enabled
    ? [`--client=${client}`, `--CHOWDECK_SECRET_KEY=${secrets.CHOWDECK_SECRET_KEY}`, `--CHOWDECK_MERCHANT_REFERENCE=${secrets.CHOWDECK_MERCHANT_REFERENCE}`, `--DELIVERY_PROVIDER=chowdeck`]
    : [`--client=${client}`, `--CHOWDECK_SECRET_KEY=`, `--CHOWDECK_MERCHANT_REFERENCE=`, `--DELIVERY_PROVIDER=manual`];

  const jobId = startJob('set-env.mjs', args, (job) => {
    if (job.status !== 'done') return;
    const registry = loadRegistry();
    upsertClient(registry, { name: client, chowdeckEnabled: enabled });
    saveRegistry(registry);
  });
  res.json({ jobId });
});

// Schema migrations (scripts/migrate.mjs) -- additive-only SQL files
// already written and reviewed as code (ebos-templates/migrations/), so
// what's exposed here is only "pick one of those and run it", never a
// free-form SQL box. Rare and deliberate on purpose (see migrate.mjs's own
// header), but still has to be clickable here -- "come back to Claude
// Code to run a migration" is exactly the standing-ops gap this panel
// exists to close.
app.get('/api/ebos/migrations', (req, res) => {
  try {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ebos/migrate', (req, res) => {
  const { client, allEbos, file } = req.body;
  if (!file) return res.status(400).json({ error: 'file is required' });
  if (!client && !allEbos) return res.status(400).json({ error: 'client or allEbos is required' });
  const relFile = path.join('ebos-templates', 'migrations', file);
  const args = [allEbos ? '--all-ebos' : `--client=${client}`, `--file=${relFile}`];
  const jobId = startJob('migrate.mjs', args);
  res.json({ jobId });
});

// The ONE shared Chowdeck account (see /api/ebos/chowdeck-toggle above) --
// set once here instead of asking for an SSH session/Claude Code every
// time it needs to be entered or rotated. Never returns the actual stored
// values back to the browser, only whether they're currently set.
app.get('/api/ebos/chowdeck-secret-status', (req, res) => {
  try {
    const secrets = loadSecrets();
    res.json({ configured: Boolean(secrets.CHOWDECK_SECRET_KEY && secrets.CHOWDECK_MERCHANT_REFERENCE) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ebos/chowdeck-secret', (req, res) => {
  const { secretKey, merchantReference } = req.body;
  if (!secretKey || !merchantReference) return res.status(400).json({ error: 'secretKey and merchantReference are required' });
  try {
    patchSecrets({ CHOWDECK_SECRET_KEY: secretKey, CHOWDECK_MERCHANT_REFERENCE: merchantReference });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/clients', (req, res) => {
  res.json(loadRegistry().clients);
});

app.post('/api/create', (req, res) => {
  const { name, subdomain, customDomain, whatsapp, pdf, payment, size } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (subdomain && customDomain) return res.status(400).json({ error: 'Use either Subdomain or Custom domain, not both.' });
  const args = [`--name=${name}`];
  if (customDomain) args.push(`--custom-domain=${customDomain}`);
  else if (subdomain) args.push(`--subdomain=${subdomain}`);
  if (whatsapp) args.push('--whatsapp');
  if (pdf) args.push('--pdf');
  if (payment) args.push(`--payment=${payment}`);
  if (size) args.push(`--size=${size}`);
  const jobId = startJob('create-client.mjs', args);
  res.json({ jobId });
});

app.post('/api/add-whatsapp', (req, res) => {
  const { client, token, phoneId, verifyToken } = req.body;
  if (!client || !token || !phoneId || !verifyToken) return res.status(400).json({ error: 'missing fields' });
  const jobId = startJob('add-whatsapp.mjs', [`--client=${client}`, `--token=${token}`, `--phone-id=${phoneId}`, `--verify-token=${verifyToken}`]);
  res.json({ jobId });
});

app.post('/api/add-instagram', (req, res) => {
  const { client, userId, token, verifyToken } = req.body;
  if (!client || !userId || !token || !verifyToken) return res.status(400).json({ error: 'missing fields' });
  const jobId = startJob('add-instagram.mjs', [`--client=${client}`, `--user-id=${userId}`, `--token=${token}`, `--verify-token=${verifyToken}`]);
  res.json({ jobId });
});

app.post('/api/add-payment', (req, res) => {
  const { client, provider, secretKey, publicKey } = req.body;
  if (!client || !provider || !secretKey || !publicKey) return res.status(400).json({ error: 'missing fields' });
  const jobId = startJob('add-payment.mjs', [`--client=${client}`, `--provider=${provider}`, `--secret-key=${secretKey}`, `--public-key=${publicKey}`]);
  res.json({ jobId });
});

app.get('/api/env/:client', async (req, res) => {
  try {
    const stdout = await runScript('get-env.mjs', [`--client=${req.params.client}`]);
    res.json(JSON.parse(stdout));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/set-env', (req, res) => {
  const { client, updates } = req.body;
  if (!client || !updates || typeof updates !== 'object' || Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'client and at least one env var update are required' });
  }
  const args = [`--client=${client}`, ...Object.entries(updates).map(([k, v]) => `--${k}=${v}`)];
  const jobId = startJob('set-env.mjs', args);
  res.json({ jobId });
});

app.post('/api/confirm-dns', (req, res) => {
  // Not a script job -- just clears the persisted "still needs DNS" flag,
  // so it's a direct registry write, synchronous, no job polling needed.
  const { client } = req.body;
  if (!client) return res.status(400).json({ error: 'client is required' });
  const registry = loadRegistry();
  if (!findClient(registry, client)) return res.status(404).json({ error: `No client "${client}" in the registry.` });
  upsertClient(registry, { name: client, dnsPending: false, dnsPendingInstructions: null });
  saveRegistry(registry);
  res.json({ ok: true });
});

// Self-service restart for fixbot/server.js -- the answer to "how do I
// restart it" without SSH or asking Claude, same job-runner mechanism as
// everything else on this page. scripts/restart-fixbot.mjs does the
// actual systemctl call plus a real healthz check, not just fire-and-hope.
app.post('/api/fixbot/restart', (req, res) => {
  const jobId = startJob('restart-fixbot.mjs', []);
  res.json({ jobId });
});

// Rolls the current template/dashboard code out to an already-live client --
// scripts/push-update.mjs itself is what's safe here (reads the server's
// own .env back and reuses every value, never regenerates secrets); this
// route is just the click-to-run wrapper around it, same job-polling
// pattern as every other action on this page. --all-ebos runs it across
// every EBOS business in one go instead of one row at a time.
app.post('/api/push-update', (req, res) => {
  const { client, allEbos } = req.body;
  if (!client && !allEbos) return res.status(400).json({ error: 'client or allEbos is required' });
  const args = allEbos ? ['--all-ebos'] : [`--client=${client}`];
  const jobId = startJob('push-update.mjs', args);
  res.json({ jobId });
});

app.post('/api/teardown', (req, res) => {
  const { client, confirm } = req.body;
  if (!client || confirm !== true) return res.status(400).json({ error: 'confirmation required' });
  const jobId = startJob('teardown-client.mjs', [`--client=${client}`]);
  res.json({ jobId });
});

// The SAFE offboarding step -- never deletes anything, see offboard-
// business.mjs's own header for exactly what this does and doesn't do.
app.post('/api/ebos/offboard', (req, res) => {
  const { client } = req.body;
  if (!client) return res.status(400).json({ error: 'client is required' });
  const jobId = startJob('offboard-business.mjs', [`--client=${client}`]);
  res.json({ jobId });
});

// Standby / failover -- keeps era-relay-standby (a second copy of this
// exact control server, its own IP) up to date, and does the actual DNS
// switch when it's genuinely needed. See sync-standby.mjs/failover-
// standby.mjs's own headers for the full reasoning.
app.post('/api/ebos/sync-standby', (req, res) => {
  const jobId = startJob('sync-standby.mjs', []);
  res.json({ jobId });
});

app.post('/api/ebos/failover', (req, res) => {
  const { to } = req.body;
  if (to !== 'standby' && to !== 'primary') return res.status(400).json({ error: 'to must be "standby" or "primary"' });
  const jobId = startJob('failover-standby.mjs', [`--to=${to}`]);
  res.json({ jobId });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'unknown job' });
  res.json(job);
});

// The ERA Dash OS workstation -- the no-code builder for a new EBOS
// business (see panel/workstation/, a separate React app from this file's
// plain-HTML client list). Already behind the basic-auth gate above.
// Reuses this file's own /api/jobs/:id for progress polling, same as every
// other long-running action here.
app.use('/api/workstation', workstationRoutes);
app.use('/workstation', express.static(WORKSTATION_DIST));
app.get('/workstation/*', (req, res) => {
  res.sendFile(path.join(WORKSTATION_DIST, 'index.html'));
});

// Same pattern, for ESF (build schema v2.0's own workstation section) --
// a separate React app (panel/workstation-esf/), not a tab bolted onto the
// EBOS one, since the two products' config shapes (catalogue/bot fields vs
// staff/task/step) don't overlap.
app.use('/api/workstation-esf', workstationEsfRoutes);
app.use('/workstation-esf', express.static(WORKSTATION_ESF_DIST));
app.get('/workstation-esf/*', (req, res) => {
  res.sendFile(path.join(WORKSTATION_ESF_DIST, 'index.html'));
});

// Bound to all interfaces because Caddy reaches this over
// host.docker.internal (this runs on the bare host, not in the Bali docker
// network Caddy shares with the other containers) -- the actual access
// control is the firewall (only the docker bridge subnet may reach this
// port) plus HTTP basic auth above, same pattern as the existing
// sandbox-sync-trigger listener.
const port = process.env.PORT || 4100;
app.listen(port, '0.0.0.0', () => console.log(`ERA Dash OS panel listening on 0.0.0.0:${port}`));

// Runs scripts/check-bot-health.mjs on its own timer instead of needing a
// separate cron entry on the control server -- this panel is already a
// permanent background service (systemd, Restart=always), so it's a
// simpler, one-less-moving-part home for "check every 15 minutes" than
// installing anything extra. Logs go to this service's own journal
// (journalctl -u era-dash-panel). A delayed first run, not immediate on
// boot, avoids firing right as the process (and its DB/secrets access)
// is still starting up.
//
// FIXBOT_ALERTS_ENABLED=0 opts a panel instance out entirely -- added
// after discovering the standby copy (dash-standby.erasystems.com.ng,
// era-relay-standby) has its own working ALERT_WA_TOKEN and its own copy
// of the registry, so left unguarded it would independently check every
// business and send duplicate WhatsApp alerts alongside the primary's own
// check. Set on the standby's systemd unit only -- primary stays enabled
// by default (unset/anything but '0').
const BOT_HEALTH_CHECK_INTERVAL_MS = 15 * 60 * 1000;
if (process.env.FIXBOT_ALERTS_ENABLED === '0') {
  console.log('FIXBOT_ALERTS_ENABLED=0 -- this instance will not run bot-health checks or send alerts.');
} else setTimeout(() => {
  runBotHealthCheck().catch((err) => console.error('Bot health check failed:', err));
  setInterval(() => {
    runBotHealthCheck().catch((err) => console.error('Bot health check failed:', err));
  }, BOT_HEALTH_CHECK_INTERVAL_MS);
}, 60_000);
