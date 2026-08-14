import express from 'express';
import basicAuth from 'express-basic-auth';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry, saveRegistry, findClient, upsertClient } from '../scripts/lib/registry.mjs';
import { startJob, getJob, runScript } from './jobs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// Public on purpose, before the auth gate below -- Meta's App Review needs
// to reach this without credentials.
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'privacy-policy.html'));
});

// Placeholder webhook for the ERA Dash OS app's own test number during Meta
// setup/App Review -- just proves a callback URL is live and logs what
// arrives. NOT the real per-client routing (each client's own server has
// its own webhook, see add-whatsapp.mjs's printed URL) -- that's a separate
// piece to design once Embedded Signup is actually wired up for many
// clients through one app.
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;

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

app.post('/webhook/whatsapp', (req, res) => {
  console.log('WEBHOOK EVENT:', JSON.stringify(req.body));
  res.sendStatus(200);
});

app.use(
  basicAuth({
    users: { [process.env.PANEL_USER || 'admin']: process.env.PANEL_PASSWORD },
    challenge: true,
  })
);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// EBOS is the one deployment marked isEbos: true in the registry (see
// create-client.mjs's --template=ebos path) -- it's provisioned once, not
// once-per-business, so "find the EBOS client" is just this lookup, never a
// picker.
function getEbosClient(registry) {
  return registry.clients.find((c) => c.isEbos) || null;
}

async function ebosAdminFetch(ebosClient, urlPath, options = {}) {
  const res = await fetch(`https://${ebosClient.subdomain}/admin/api${urlPath}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ebosClient.ebosAdminToken}`,
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `EBOS admin API ${urlPath} failed (${res.status})`);
  return data;
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
      <td>${c.hasBotEngine ? 'yes' : 'no'}</td>
      <td>
        <a class="claude-hint" href="eraterm://${esc(c.name)}" title="Opens a real terminal on this computer, already in this business's folder (C:\\Users\\user\\${esc(c.name)}). One-time setup needed first: that folder must exist locally, and the eraterm:// link handler must be registered on this machine.">Open terminal</a><br>
        <code class="claude-hint" style="margin-top:4px;display:inline-block;" title="Type this once you're in the terminal, or after /rename once to start.">claude --resume ${esc(c.displayName || c.name)}</code>
      </td>
      <td>
        <button onclick="showPanel('${esc(c.name)}')">Manage</button>
      </td>
    </tr>${dnsRow}`;
}

function businessesSection(ebosClient) {
  if (!ebosClient) {
    return `<h2>Businesses (EBOS)</h2><p>No EBOS deployment registered yet. Provision it once from the control server: <code>node scripts/create-client.mjs --name="EBOS" --subdomain=ebos --template=ebos</code>.</p>`;
  }
  return `
  <h2>Businesses (EBOS)</h2>
  <p class="muted">Onboarding a business here is a database write against the one EBOS deployment (${esc(ebosClient.subdomain)}) -- no server, no DNS, seconds not minutes.</p>
  <table>
    <tr><th>Name</th><th>Type</th><th>Owner email</th></tr>
    <tbody id="businessRows"><tr><td colspan="3">Loading...</td></tr></tbody>
  </table>
  <fieldset>
    <legend>Onboard new business</legend>
    <form id="createBusinessForm">
      <label>Business name</label><input name="name" required>
      <label>Type</label>
      <select name="type">
        <option value="restaurant">Restaurant / food</option>
        <option value="apartment">Shortlet / apartment</option>
        <option value="car_rental">Car rental</option>
        <option value="lashes_nails">Lashes, nails and installation</option>
      </select>
      <label>Address</label><input name="address">
      <label>Business phone number</label><input name="phoneNumber">
      <label>Owner name</label><input name="ownerName" required>
      <label>Owner email (their login)</label><input name="ownerEmail" type="email" required>
      <button type="submit">Onboard business</button>
    </form>
  </fieldset>
  <div id="ownerLoginResult"></div>`;
}

function page(clients, ebosClient) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>ERA Dash OS</title>
<style>
  body { font-family: sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  td, th { border: 1px solid #ccc; padding: 6px 10px; text-align: left; font-size: 14px; }
  fieldset { margin: 1rem 0; }
  label { display: block; margin: 6px 0 2px; font-size: 14px; }
  input, select { padding: 4px; width: 260px; }
  button { margin-top: 10px; padding: 6px 14px; cursor: pointer; }
  #log { background: #111; color: #0f0; padding: 10px; height: 220px; overflow-y: auto; white-space: pre-wrap; font-family: monospace; font-size: 12px; }
  .hidden { display: none; }
  .danger { color: #b00; }
  .claude-hint { font-family: monospace; font-size: 12px; background: #f0f0f0; padding: 2px 4px; border-radius: 3px; cursor: help; }
</style>
</head>
<body>
  <h1>ERA Dash OS</h1>

  <h2>Clients</h2>
  <table>
    <tr><th>Name</th><th>URL</th><th>Provider</th><th>IP</th><th>WhatsApp</th><th>Payment</th><th>Bot engine</th><th>Claude session</th><th></th></tr>
    ${clients.map(clientRow).join('') || '<tr><td colspan="9">No clients yet.</td></tr>'}
  </table>

  ${businessesSection(ebosClient)}

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

    <h4>Add / update WhatsApp</h4>
    <form id="whatsappForm">
      <label>Meta access token</label><input name="token" required>
      <label>Phone number ID</label><input name="phoneId" required>
      <label>Webhook verify token</label><input name="verifyToken" required>
      <button type="submit">Add WhatsApp</button>
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

function showPanel(name) {
  currentClient = name;
  document.getElementById('manageClientName').textContent = name;
  document.getElementById('managePanel').classList.remove('hidden');
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

async function loadBusinesses() {
  const el = document.getElementById('businessRows');
  if (!el) return;
  try {
    const res = await fetch('/api/ebos/businesses');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'failed to load');
    el.innerHTML = data.length
      ? data.map((b) => '<tr><td>' + escClient(b.name) + '</td><td>' + escClient(b.type) + '</td><td>' + escClient(b.owner_email || '') + '</td></tr>').join('')
      : '<tr><td colspan="3">No businesses yet.</td></tr>';
  } catch (err) {
    el.innerHTML = '<tr><td colspan="3">Error: ' + escClient(err.message) + '</td></tr>';
  }
}
loadBusinesses();

const createBusinessForm = document.getElementById('createBusinessForm');
if (createBusinessForm) {
  createBusinessForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = Object.fromEntries(f.entries());
    const resultEl = document.getElementById('ownerLoginResult');
    resultEl.textContent = 'Onboarding...';
    const res = await fetch('/api/ebos/businesses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { resultEl.innerHTML = '<p class="danger">' + escClient(data.error || 'Failed') + '</p>'; return; }
    resultEl.innerHTML = '<p><strong>' + escClient(data.business.name) + '</strong> is ready. Owner login (shown once, save it now):<br>'
      + 'Email: <code>' + escClient(data.ownerLogin.email) + '</code><br>'
      + 'Password: <code>' + escClient(data.ownerLogin.password) + '</code></p>';
    e.target.reset();
    loadBusinesses();
  });
}
</script>
</body>
</html>`;
}

app.get('/', (req, res) => {
  const registry = loadRegistry();
  res.send(page(registry.clients, getEbosClient(registry)));
});

app.get('/api/ebos/businesses', async (req, res) => {
  const ebosClient = getEbosClient(loadRegistry());
  if (!ebosClient) return res.status(404).json({ error: 'No EBOS deployment registered yet.' });
  try {
    res.json(await ebosAdminFetch(ebosClient, '/businesses'));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/ebos/businesses', async (req, res) => {
  const ebosClient = getEbosClient(loadRegistry());
  if (!ebosClient) return res.status(404).json({ error: 'No EBOS deployment registered yet.' });
  try {
    const data = await ebosAdminFetch(ebosClient, '/businesses', { method: 'POST', body: JSON.stringify(req.body) });
    res.status(201).json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
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

app.post('/api/teardown', (req, res) => {
  const { client, confirm } = req.body;
  if (!client || confirm !== true) return res.status(400).json({ error: 'confirmation required' });
  const jobId = startJob('teardown-client.mjs', [`--client=${client}`]);
  res.json({ jobId });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'unknown job' });
  res.json(job);
});

// Bound to all interfaces because Caddy reaches this over
// host.docker.internal (this runs on the bare host, not in the Bali docker
// network Caddy shares with the other containers) -- the actual access
// control is the firewall (only the docker bridge subnet may reach this
// port) plus HTTP basic auth above, same pattern as the existing
// sandbox-sync-trigger listener.
const port = process.env.PORT || 4100;
app.listen(port, '0.0.0.0', () => console.log(`ERA Dash OS panel listening on 0.0.0.0:${port}`));
