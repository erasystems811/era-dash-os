# era-dash-os

The automation "engine" behind ERA Dash OS — turns a client's answers into a
fully running app: a new Hetzner server, a GitHub repo, a DNS subdomain,
and the standard stack (n8n + Postgres + PostgREST + a starter dashboard,
fronted by Caddy) deployed and running.

**Fixing a bug on any live ERA system? Read [`FIX-PROTOCOL.md`](FIX-PROTOCOL.md) first.**

**Want the panel's "Open terminal" links to work on this computer? See [`local-setup/README.md`](local-setup/README.md).**

No form/UI yet — this phase is just the engine, run by hand (or by Claude on
your behalf) until it's proven, then a form gets built on top of it.

## One-time setup

1. Copy `secrets.env.example` to `/opt/era-control/secrets.env` on the control
   server (currently the same droplet Bali runs on: `143.198.179.150`) and
   fill in the 7 keys. `chmod 600` it.
2. Copy this whole repo to `/opt/era-control/era-dash-os` on that server.
3. Run everything below **from that server** (`ssh root@143.198.179.150`,
   then `cd /opt/era-control/era-dash-os`) — the scripts read secrets and the
   client registry from `/opt/era-control/`.

## Create a new client

```
node scripts/create-client.mjs --name="Client Name" [--whatsapp] [--payment=flutterwave|paystack] [--pdf] [--size=small|medium|large]
```

Creates the droplet, repo, DNS record, deploys and starts the app. Prints the
live URL, repo link, dashboard login, and what (if anything) still needs a
manual follow-up.

## Add WhatsApp or payment to an existing client later

```
node scripts/add-whatsapp.mjs --client=slug --token=... --phone-id=... --verify-token=...
node scripts/add-payment.mjs --client=slug --provider=flutterwave --secret-key=... --public-key=...
```

These only wire the technical side. Meta's business verification and the
payment provider's KYC are manual steps on their own dashboards that can't be
scripted — the scripts tell you what's left.

## Tear down a (test) client

```
node scripts/teardown-client.mjs --client=slug
```

Deletes the droplet and GitHub repo. Use for cleaning up test clients while
verifying this automation, not for casual real-client offboarding.

## EBOS (ERA Business Order System)

EBOS is a shared, multi-tenant ordering/booking platform (restaurant, shortlet/apartment,
car rental, lashes and nails) — one deployment serving many small businesses, not one
deployment per business. Spec: `ERA-Business-Order-System-Build-Schema-v1.1.md`.

It's provisioned exactly like any other client, just from a different template set
(`ebos-templates/` instead of `templates/`) — a one-time (or rare) action:

```
node scripts/create-client.mjs --name="EBOS" --subdomain=ebos --template=ebos --size=small
```

**Onboarding an individual business is NOT another `create-client.mjs` run.** Once EBOS
is provisioned, new businesses are onboarded from the panel's "Businesses (EBOS)"
section — a database write against the running EBOS deployment (owner login generated
and shown once), no server, no DNS, no SSH. See `ebos-templates/dashboard/routes/admin-api.js`
for the API the panel calls.

Phases 4 (order/booking engine), 6 (AI layer) and 7 (WhatsApp) are not built yet — this
covers the doc's Phase 1–3 (database, business configuration, catalogue) plus the
onboarding screen.

## DNS

erasystems.com.ng's DNS lives on a DirectAdmin server behind Go54's panel
(`da17.host-ww.net:2222`). DNS automation uses a DirectAdmin "Login Key"
(Account menu > Login Keys), scoped to `CMD_API_DNS_CONTROL` only and locked
to the control server's IP — confirmed working live 2026-07-31. If DNS setup
ever fails for the wrong reason (e.g. the login key gets removed/regenerated),
it falls back to printing the manual record to paste in instead of blocking
the rest of setup.
