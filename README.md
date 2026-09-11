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

## ESF (ERA StaffFlow)

ESF is a config-driven staff workflow/checklist engine over WhatsApp (opening/closing
checklists, restock, attendance, proof-of-task) for any staffed business — retail,
cosmetics, boutique, restaurant, salon. Spec: `ERA-StaffFlow-Build-Schema-v2.0.md`.

**Unlike EBOS, ESF is NOT multi-tenant.** Every business gets its own dedicated
deployment — own server, own database, own subdomain, own WhatsApp number — same
physical-isolation model EBOS itself uses. It's provisioned exactly like any other
client, just from a different template set (`esf-templates/` instead of
`ebos-templates/` or `templates/`):

```
node scripts/create-client.mjs --name="Grace Stores" --template=esf [--whatsapp]
```

`--esf-seed=path/to/config.json` bakes a real business (business details, staff, tasks
and their steps, alert routing) straight into the new database at provision time —
`scripts/lib/esf-seed.mjs` turns the JSON into SQL, same mechanism as
`scripts/lib/ebos-seed.mjs` does for EBOS. The owner logs in with real per-business
credentials (`owner_user`, bcrypt — `esf-templates/dashboard/lib/auth.js`), not the
generic Basic Auth pair. If `GOOGLE_SERVICE_ACCOUNT_JSON` is set in the control
server's `secrets.env`, the same run also creates and shares this business's Google
Sheet (`scripts/lib/esf-sheet.mjs`) — optional, same as `--whatsapp`/`--payment`.

What's built so far (build order stages 1–10 of the v2.0 spec): the schema, the
generic run/entry engine covering all nine proof types including a real `step_override`
(with its reason actually shown to the staff member, not applied silently —
`esf-templates/dashboard/engine/`), the WhatsApp channel (webhook, wake-template
handling for the 24h window, sandbox mode via `ESF_SANDBOX=1`), missing-detection and
alert dispatch (dedup + quiet hours), Google Sheet creation and its 15-minute re-sync
job, and the daily summary. A regression suite covers all of it —
`ESF_TEST_PGLITE=1 ESF_SANDBOX=1 node sandbox/test-engine.mjs` (and
`test-proof-types.mjs`, `test-scheduler.mjs`, `ESF_TEST_PGLITE=1 node
sandbox/test-sheet-sync.mjs` — no server or Docker needed for any of them) plus
`node scripts/lib/google-auth.test.mjs` and `node scripts/lib/esf-sheet.test.mjs` for
the Google integration's JWT signing and request shapes (mocked — no real Google
account exists in this environment to test the actual API calls against).

Not yet built: the dashboard beyond a bare login + today's-runs page (the rest of
stage 9 — task/step CRUD, override log, alert_route editor), the ERA Dash OS
workstation for click-to-provision onboarding (stage 14, deliberately last, waiting
on a real pilot business), and cross-staff `countersign` routing (recorded as
self-reported for now, flagged inline rather than silently wrong) — see the build
schema's section 14 for the full list of flagged gaps. Also worth knowing: the v2.0
doc's section 2.4 assumed n8n workflow imports for the scheduled jobs; there is no
n8n-workflow-import convention anywhere in this repo, so they run as plain
`setInterval` jobs inside the dashboard process instead, matching how EBOS's own
background work already runs — a deliberate deviation from the doc, not an oversight.

## Bot Monitoring (across every EBOS business)

Once a business is handed over, its dashboard is theirs to run — but the panel's "Bot
Monitoring" section (below "EBOS Businesses") gives a central view across every business at
once: a per-business concern count for the last hour (bot didn't understand, forced
handover, Claude/API error) plus one merged, chronological feed of real recent
conversations across all businesses — not gated behind a flag, since not everything worth
noticing registers as a system error. Backed by `/api/monitor/summary` and
`/api/monitor/feed` on each business's own dashboard (`ebos-templates/dashboard/routes/api.js`),
reusing signals each business already logs for itself (`message.trigger`,
`customers.handover_reason`, `ai_errors`) rather than a second logging path.

`scripts/check-bot-health.mjs`, run on a schedule (cron on the control server), is the
proactive half — sends a WhatsApp alert when a business crosses a concern threshold in the
trailing hour. Needs `ALERT_WA_TOKEN`/`ALERT_WA_PHONE_NUMBER_ID`/`ALERT_RECIPIENT_PHONE` in
`secrets.env` (see `secrets.env.example`) before it can actually send anything.

## Backups

Every client's Postgres database, backed up daily to the control server's own disk —
deliberately a different machine than the one each database actually runs on, since a backup
sitting next to the thing it's backing up isn't a real backup. Add to the control server's
crontab (`crontab -e`):

```
0 3 * * * cd /opt/era-control/era-dash-os && node scripts/backup-all-clients.mjs >> /var/log/era-backups.log 2>&1
```

Dumps land at `/opt/era-control/backups/<client-slug>/<slug>-<timestamp>.sql.gz` (override with
`ERA_BACKUP_DIR`); the last 14 per client are kept, older ones pruned automatically (override
with `ERA_BACKUP_KEEP`). Reuses the same `ALERT_WA_*` secrets as Bot Monitoring above to send
one WhatsApp message if any client's backup fails that run — silent on a normal successful
run, doesn't page for routine noise.

To restore: `gunzip -c <file>.sql.gz | docker exec -i <slug>-postgres-1 psql -U app <slug>` —
same shape as `create-client.mjs`'s own initial schema load, just restoring a real dump instead
of a fresh `init.sql`. Worth actually testing this once against a spare server before you ever
need it for real, not just trusting the command exists.

Not yet off-site (S3 / OCI Object Storage) — this covers "the server that runs the database
dies," not "the control server itself dies too." Worth adding once this is proven, not a
blocker for the first real improvement over having nothing.

## DNS

erasystems.com.ng's DNS lives on a DirectAdmin server behind Go54's panel
(`da17.host-ww.net:2222`). DNS automation uses a DirectAdmin "Login Key"
(Account menu > Login Keys), scoped to `CMD_API_DNS_CONTROL` only and locked
to the control server's IP — confirmed working live 2026-07-31. If DNS setup
ever fails for the wrong reason (e.g. the login key gets removed/regenerated),
it falls back to printing the manual record to paste in instead of blocking
the rest of setup.
