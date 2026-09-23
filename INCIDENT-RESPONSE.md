# Incident Response

What actually happens when something goes wrong — a server down, a suspected
breach, data loss, or a third-party outage. Read this when something IS
wrong, not as theory beforehand. Every mechanism named here is real and
already built (not aspirational) as of 2026-09-21.

## What's actually running, so "which server" has a real answer

- **era-control** (`145.241.212.131`) — the admin panel + era-demo's own
  EBOS instance. `dash.erasystems.com.ng` points here.
- **era-standby** (`145.241.193.64`) — a synced copy of era-control, kept
  current automatically every 30 minutes (`scripts/sync-standby.mjs`, on
  era-control's own crontab). Not serving real traffic unless deliberately
  failed over to.
- **Oracle shared box** (`84.8.155.23`) — pomodoro and dee, sharing one
  server.
- **Hetzner box** (`188.245.23.101`) — bare, no client on it yet.

Third parties this depends on and doesn't control: **Meta** (WhatsApp
Business API), **Anthropic** (Claude API), **Paystack** (payments),
**Oracle Cloud** / **Hetzner** (hosting), **DirectAdmin** (DNS).

## 1. How you'd actually find out

- **Automated**: bot-health checks run every 15 minutes and alert via
  WhatsApp (`ALERT_WA_*` secrets, `scripts/lib/alert.mjs`) if a business's
  bot starts erroring.
- **Automated**: `backup-all-clients.mjs` (every 6h) and
  `verify-backups.mjs` (weekly) alert the same way on failure.
- **Manual**: a business owner reports something broken, or you notice it
  yourself.

Whoever notices first, the next step is always the same: figure out which
of the four scenarios below this actually is, before doing anything.

## 2. Classify it first

| Symptom | Likely scenario | Go to |
|---|---|---|
| One business's bot not responding, others fine | That business's own server/container issue | §3 |
| era-control / the panel itself unreachable | Primary server down | §4 |
| Data looks wrong, deleted, or corrupted | Data loss | §5 |
| Unexplained access, leaked credential, suspicious activity | Suspected breach | §6 |
| Everything's fine on our end but messages aren't sending/AI isn't responding/payments aren't going through | Third-party outage | §7 |

## 3. One business down (its own server/container)

1. SSH in, check `docker compose ps` in that business's `/opt/<slug>/`
   directory — which container actually died.
2. Check `docker compose logs <service> --tail=50` for the real error.
3. If it's a bad deploy: redeploy the last known-good code
   (`scripts/push-update.mjs --client=<slug>`) rather than guessing at a
   fix live.
4. If the SERVER itself is compromised or unrecoverable: use
   `scripts/migrate-client.mjs` to stand up a clean copy on a new server
   from the last real backup, verify it works, then
   `scripts/cutover-client.mjs` to point traffic at it. The old server
   stays up as a rollback until you're confident. This is the exact
   process already proven live moving pomodoro/dee to Oracle, 2026-09-20.

## 4. era-control itself down

1. Confirm it's actually down, not just DNS lag: try the IP directly
   (`curl http://145.241.212.131:4100/`).
2. If era-control is genuinely unreachable, fail over to the standby:
   ```
   node scripts/sync-standby.mjs      # get it current first, if reachable
   node scripts/failover-standby.mjs --to=standby
   ```
   This repoints `dash.erasystems.com.ng` DNS to era-standby with a short
   (300s) TTL — expect propagation within a few minutes, not the usual
   hour.
3. Once era-control is fixed/rebuilt, switch back:
   `node scripts/failover-standby.mjs --to=primary`, then run
   `sync-standby.mjs` again so the standby picks up anything that changed
   while it was live.
4. Note: era-demo (the EBOS instance) also lives on era-control's own
   server. A primary-server failure takes era-demo down too, not just the
   panel — the standby only carries the panel/registry, not a duplicate
   era-demo deployment.

## 5. Data loss / corruption

1. Don't guess-fix — first confirm exactly what's wrong (which table, which
   rows, since when).
2. Restore from the most recent verified backup:
   `/opt/era-control/backups/<slug>/<slug>-<timestamp>.sql.gz` — restore
   procedure is the same role-preamble + data + grants sequence
   `scripts/migrate-client.mjs` and `scripts/verify-backups.mjs` both use.
3. Check `registry.json`'s `lastBackupVerifiedOk` for that client first —
   if the last verification failed, that backup may not be trustworthy;
   go back further.
4. After restoring, run `node scripts/verify-backups.mjs` again to confirm
   the CURRENT state is sound, not just that a backup file exists.

## 6. Suspected breach (leaked credential, unauthorized access)

1. **Rotate the specific credential immediately** — don't wait to fully
   understand the breach first. A rotated key can't be un-rotated back
   into being useful to whoever has it.
   - API keys (Oracle, Hetzner, Anthropic, Meta, Paystack): generate new,
     update `secrets.env` via the same `patchSecrets` pattern used
     throughout this codebase, restart affected services.
   - Panel login password: change it directly, restart
     `era-dash-panel.service` on BOTH era-control and era-standby (they
     share credentials via `sync-standby.mjs` — rotating on one only
     doesn't help until the next sync, so do both by hand right away).
2. **Contain**: if a specific server is compromised (not just a leaked
   key), isolate it — pull it out of DNS, don't try to clean a
   compromised box in place. Stand up clean via `migrate-client.mjs` as
   in §3.
3. **Assess what data was actually exposed** — which business(es), which
   tables, real customer PII (names/phone numbers/order history) or just
   internal config.
4. **Notify, within a defined window**: if real customer personal data
   (names, phone numbers, order/payment history) was exposed, Nigeria's
   NDPR expects notification to affected individuals and the regulator
   without undue delay. Treat "without undue delay" as: assess within 24
   hours of confirming the breach, notify within 72 hours of that
   assessment if personal data was involved. This is a real legal
   obligation, not a courtesy — if in doubt on the exact notification
   text/process, get that reviewed rather than improvising it live during
   an incident.
5. **Document what happened** — what was exposed, when, how it was found,
   what was rotated/fixed — for both the notification itself and for §8
   below.

## 7. Third-party outage (Meta / Anthropic / Paystack / Oracle / Hetzner)

Nothing to fix on our end — these are outside our control. What to
actually do:

1. Confirm it's really them, not us: check their public status page,
   confirm the same failure reproduces against a fresh, direct API call.
2. If it's WhatsApp/Meta: messages queue on Meta's side and typically
   deliver once they recover — no action needed beyond monitoring.
3. If it's Anthropic (Claude): bots degrade to their fallback behavior
   (see each business's own error handling) — customers may briefly get a
   generic response instead of an AI-parsed one. Same story: monitor, no
   fix available on our end.
4. If it's Paystack: payment confirmations delay. Orders stay in
   `confirmation` state until the webhook eventually arrives — don't
   manually mark things paid without confirming with Paystack directly.
5. Communicate the outage to affected business owners if it's lasting more
   than a few minutes, so they're not left guessing.

## 8. After any real incident

Same discipline as `FIX-PROTOCOL.md` step 7 — fold what was learned back
into the system, don't just fix the instance and move on:

- If a script/process had a real gap (like the wrong `PRIMARY_IP` found
  and fixed in `failover-standby.mjs` while writing this document,
  2026-09-21), fix the tool, not just the one incident.
- If detection was too slow, ask whether monitoring needs to cover this
  case.
- Update this document if a real incident revealed a scenario it doesn't
  cover.
