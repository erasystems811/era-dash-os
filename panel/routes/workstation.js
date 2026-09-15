// The "Build" button's real destination -- takes what the workstation's
// tabs captured, writes it as a seed file, and runs the exact same
// create-client.mjs pipeline as any other client, just with
// --template=ebos --ebos-seed=<that file>. No new provisioning logic here
// on purpose: the workstation is a UI over the existing engine, not a
// second engine.
import express from 'express';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { startJob } from '../jobs.mjs';
import { loadSecrets } from '../../scripts/lib/secrets.mjs';

export const router = express.Router();

// Same menu-parsing prompt as ebos-templates/dashboard/engine/parse-menu.js
// -- duplicated, not imported, because the workstation runs before any
// business (and its own copy of the engine) exists. Uses the control
// server's shared ANTHROPIC_API_KEY, same secret every client already gets.
const MENU_PROMPT = `Extract every menu/service/catalogue item you can find into JSON. For each item, capture: name (string), description (string, empty if none given), price (number, in the currency's smallest whole unit as written -- e.g. "4,500" becomes 4500, "N2000" becomes 2000). Skip section headers, currency symbols alone, and anything that isn't an actual priced item. If a price is genuinely missing for an item, use null for that item's price and it will be skipped. Reply ONLY with JSON: {"items": [{"name": "...", "description": "...", "price": <number or null>}]}`;

async function callClaudeForMenu({ text, image }) {
  const secrets = loadSecrets();
  const content = image
    ? [{ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } }, { type: 'text', text: 'This is a photo of a menu. Extract every item.' }]
    : text;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': secrets.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 2048, system: MENU_PROMPT, messages: [{ role: 'user', content }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const raw = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  return (Array.isArray(parsed.items) ? parsed.items : [])
    .filter((i) => i && i.name && typeof i.price === 'number' && i.price > 0)
    .map((i) => ({ name: String(i.name).trim(), description: i.description ? String(i.description).trim() : '', price: i.price }));
}

router.post('/parse-menu', async (req, res) => {
  const { text, image } = req.body;
  if (!text && !image) return res.status(400).json({ error: 'Paste some menu text or attach a photo.' });
  try {
    const items = await callClaudeForMenu({ text, image });
    if (!items.length) return res.status(422).json({ error: "Couldn't find any priced items in that -- try again with clearer text or a clearer photo." });
    res.json({ items });
  } catch (err) {
    res.status(502).json({ error: `Could not read the menu: ${err.message}` });
  }
});

router.post('/build', (req, res) => {
  const { businessName, subdomain, size, provider, business, owner, catalogue, botFields, botStates, knowledgeBase } = req.body;

  if (!businessName || !business?.type || !owner?.name || !owner?.email) {
    return res.status(400).json({ error: 'Business name, business type, owner name and owner email are all required before building.' });
  }

  const seedDir = path.join(os.tmpdir(), 'era-workstation-seeds');
  mkdirSync(seedDir, { recursive: true });
  const seedPath = path.join(seedDir, `${randomUUID()}.json`);
  writeFileSync(seedPath, JSON.stringify({ business, owner, catalogue, botFields, botStates, knowledgeBase }));

  const args = [`--name=${businessName}`, '--template=ebos', `--ebos-seed=${seedPath}`];
  if (subdomain) args.push(`--subdomain=${subdomain}`);
  if (size) args.push(`--size=${size}`);
  // Defaults to create-client.mjs's own default (currently 'oracle') when
  // not passed -- the workstation UI's own form controls whether this is
  // ever sent, same as size/subdomain above.
  if (provider) args.push(`--provider=${provider}`);

  const jobId = startJob('create-client.mjs', args);
  res.json({ jobId });
});
