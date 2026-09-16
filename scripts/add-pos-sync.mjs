#!/usr/bin/env node
// Usage:
//   node add-pos-sync.mjs --subdomain=era-demo.erasystems.com.ng --admin-token=... --api-key=MONIEPOINT_API_KEY [--business-id=123]
//
// Connects a client's REAL Moniepoint POS account so their terminal sales
// start showing up on their dashboard's POS tab. Requires the business
// owner's own Moniepoint API key -- ERA never has one of its own to
// substitute (see feedback_no_secrets_in_code / the standing rule that
// third-party credentials always come from the business owner).
//
// Deliberately takes --subdomain/--admin-token directly instead of looking
// the client up in the local registry.json (scripts/lib/registry.mjs) --
// era-demo and most real EBOS clients are created through the panel's own
// Workstation flow, which keeps its own separate registry the local one
// never sees (the same gap that bit push-update.mjs earlier). Passing these
// explicitly means this script works regardless of which registry, if any,
// actually knows about the client.
//
// What this does, against docs.pos.moniepoint.com's real API:
//   1. GET  /v1/introspect                          -- confirm the key, find businessId
//   2. POST /v1/webhook-subscriptions                -- register our webhook URL for V1_POS_TRANSACTION
//   3. PUT  /v1/webhook-subscriptions/{id}/authentication -- set Basic auth creds Moniepoint will send us
//   4. POST https://<subdomain>/api/pos-sync-config/credentials -- store enabled+credentials on the client's own dashboard
//
// NOT done here, and can't be from a script: Moniepoint's own business/KYC
// verification for the client's POS account -- that's already done by the
// time he can generate an API key at all.
import crypto from 'node:crypto';

const MONIEPOINT_API = 'https://api.pos.moniepoint.com';

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    args[key] = rest.join('=');
  }
  if (!args.subdomain || !args['admin-token'] || !args['api-key']) {
    throw new Error('Usage: add-pos-sync.mjs --subdomain=client.example.com --admin-token=... --api-key=... [--business-id=123]');
  }
  return args;
}

async function moniepoint(apiKey, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${MONIEPOINT_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Moniepoint ${method} ${path} failed ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const endpointUrl = `https://${args.subdomain}/webhook/moniepoint`;

  let businessId = args['business-id'] ? Number(args['business-id']) : null;
  if (!businessId) {
    const intro = await moniepoint(args['api-key'], '/v1/introspect');
    if (!intro.businesses?.length) throw new Error('This API key has no businesses attached -- check it with the client.');
    if (intro.businesses.length > 1) {
      throw new Error(
        `This API key covers multiple businesses -- pass --business-id= explicitly:\n` +
        intro.businesses.map((b) => `  ${b.id}: ${b.businessName}`).join('\n')
      );
    }
    businessId = intro.businesses[0].id;
    console.log(`Using business "${intro.businesses[0].businessName}" (id ${businessId}) from the API key.`);
  }

  console.log(`Registering webhook subscription for ${endpointUrl} ...`);
  const subscription = await moniepoint(args['api-key'], '/v1/webhook-subscriptions', {
    method: 'POST',
    body: { endpointUrl, eventTypes: ['V1_POS_TRANSACTION'], businessId },
  });
  console.log(`Subscription created: ${subscription.id}`);

  const webhookUsername = `era-${crypto.randomBytes(6).toString('hex')}`;
  const webhookPassword = crypto.randomBytes(24).toString('base64url');

  console.log('Setting webhook Basic auth credentials ...');
  await moniepoint(args['api-key'], `/v1/webhook-subscriptions/${subscription.id}/authentication`, {
    method: 'PUT',
    body: { authenticationMethod: 'BASIC', username: webhookUsername, password: webhookPassword },
  });

  console.log(`Storing credentials on ${args.subdomain}'s own dashboard ...`);
  const storeRes = await fetch(`https://${args.subdomain}/api/pos-sync-config/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-era-admin-token': args['admin-token'] },
    body: JSON.stringify({ provider: 'moniepoint', apiKey: args['api-key'], webhookUsername, webhookPassword }),
  });
  if (!storeRes.ok) {
    throw new Error(
      `Moniepoint subscription ${subscription.id} was created and authenticated, but storing it on ` +
      `${args.subdomain} failed (${storeRes.status}). The Moniepoint side is already done -- fix the ` +
      `dashboard side and re-POST to /api/pos-sync-config/credentials with the same webhookUsername/` +
      `webhookPassword rather than re-running this whole script (that would create a second, duplicate ` +
      `subscription).`
    );
  }

  console.log(`Done. POS sync is live for ${args.subdomain} -- real terminal sales will start appearing on its POS tab as they happen.`);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
