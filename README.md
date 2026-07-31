# era-dash-os

The automation "engine" behind ERA Dash OS — turns a client's answers into a
fully running app: a new DigitalOcean droplet, a GitHub repo, a DNS subdomain,
and the standard stack (n8n + Postgres + PostgREST + a starter dashboard,
fronted by Caddy) deployed and running.

No form/UI yet — this phase is just the engine, run by hand (or by Claude on
your behalf) until it's proven, then a form gets built on top of it.

## One-time setup

1. Copy `secrets.env.example` to `/opt/era-control/secrets.env` on the control
   server (currently the same droplet Bali runs on: `143.198.179.150`) and
   fill in the 5 keys. `chmod 600` it.
2. Copy this whole repo to `/opt/era-control/era-dash-os` on that server.
3. Run everything below **from that server** (`ssh root@143.198.179.150`,
   then `cd /opt/era-control/era-dash-os`) — the scripts read secrets and the
   client registry from `/opt/era-control/`.

## Create a new client

```
node scripts/create-client.mjs --name="Client Name" [--whatsapp] [--payment=flutterwave|paystack] [--pdf]
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

## Known gap to verify before real use

`scripts/lib/dns.mjs` — the exact Go54/WhoGoHost DNS API endpoint shape
wasn't fully confirmed from their public docs while building this. It's
wrapped so a failure there doesn't block the rest of setup (falls back to
printing the manual DNS record to add), but confirm/fix the real endpoint the
first time this runs with a real `GO54_API_KEY`.
