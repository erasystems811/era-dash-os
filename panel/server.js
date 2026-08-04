import express from 'express';
import basicAuth from 'express-basic-auth';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry } from '../scripts/lib/registry.mjs';
import { startJob, getJob } from './jobs.mjs';

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

function clientRow(c) {
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
        <button onclick="showPanel('${esc(c.name)}')">Manage</button>
      </td>
    </tr>`;
}

function page(clients) {
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
</style>
</head>
<body>
  <h1>ERA Dash OS</h1>

  <h2>Clients</h2>
  <table>
    <tr><th>Name</th><th>URL</th><th>Provider</th><th>IP</th><th>WhatsApp</th><th>Payment</th><th>Bot engine</th><th></th></tr>
    ${clients.map(clientRow).join('') || '<tr><td colspan="8">No clients yet.</td></tr>'}
  </table>

  <fieldset>
    <legend>Create new client</legend>
    <form id="createForm">
      <label>Client name</label>
      <input name="name" required placeholder="e.g. Sunset Catering">
      <label>Subdomain (optional, auto-generated from name if blank)</label>
      <input name="subdomain" placeholder="e.g. sunset-catering">
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

document.getElementById('teardownForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!confirm('Really tear down ' + currentClient + '? This deletes the server and cannot be undone.')) return;
  submitJson('/api/teardown', { client: currentClient, confirm: true });
});
</script>
</body>
</html>`;
}

app.get('/', (req, res) => {
  const registry = loadRegistry();
  res.send(page(registry.clients));
});

app.get('/api/clients', (req, res) => {
  res.json(loadRegistry().clients);
});

app.post('/api/create', (req, res) => {
  const { name, subdomain, whatsapp, pdf, payment, size } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const args = [`--name=${name}`];
  if (subdomain) args.push(`--subdomain=${subdomain}`);
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
