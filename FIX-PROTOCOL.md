# The Fix Protocol

The standard process for fixing any bug on any live ERA system — Bali, the
Bali Operational Management System, era-dash-os itself, or any future
client. Read this before fixing a live bug. Every step here already caught
a real failure the first time it was used (2026-08-04, fixing Bali's
`client_reference` intake bug) — this isn't theory.

1. **Reproduce with real evidence first.** Query the real database, check
   real logs, or reproduce it in sandbox. Never fix a guess.

2. **Find the root cause, not the symptom.** Trace back to the actual
   mechanism. (Real example: the bug wasn't "the PM didn't get notified" —
   it was "one field could never be marked answered," which meant intake
   could never complete, which meant the notification step never ran.
   Fixing the symptom would have meant hand-triggering notifications
   forever instead of fixing the one thing actually broken.)

3. **Test in isolation before touching anything live.** Sandbox or a local
   copy first, whenever one exists.

4. **Commit and push to git *before* syncing to production.** Never leave
   a fix as a bare file edit on a server. A scheduled sync/cron job can
   silently wipe uncommitted local changes — confirmed live: this happened
   mid-fix, the edit vanished with no error, `git status` just quietly
   showed a clean tree until it was re-checked.

5. **Deploy through the real pipeline, never a bare file edit.**

6. **Verify directly against the live system after deploying.** Query the
   actual database or API. A "sync succeeded" log line is not proof —
   confirmed live: a sync reported failure for the one file that actually
   mattered, because a stale root-owned temp file from a prior run was
   silently blocking the container's default non-root user from touching
   it again.

7. **Save the bug as a permanent test/fixture case**, once a project has a
   test harness, so it can never quietly regress.

8. **Ask: is this fix specific to one client, or a general pattern?** If
   general, fold it into the shared toolkit (`bot-engine/`, this repo's
   scripts) so every future client inherits it automatically instead of
   re-learning the same lesson later.

See also `templates/bot-conversation-rules.md` for the conversation-logic
lessons distilled from building Bali, and `bot-engine/README.md` for the
reusable building blocks those lessons turned into.

## Known regression checks (step 7, in practice)

- **`scripts/verify-panel-script.mjs`** — run before deploying any change to
  `panel/server.js`. That file's `page()` function is one giant template
  literal containing the client-side `<script>` as literal text; a single
  `\'` anywhere in it (should be `\\'`) gets silently consumed by the
  *outer* template literal's own escape processing before the browser ever
  sees it, breaking every `onclick` handler on the page with no visible
  error on load — this exact bug shipped live 2026-08-30 (every "Manage"
  button dead, EBOS totals stuck on "Loading..."). `node --check
  panel/server.js` does **not** catch this class of bug, because the outer
  file is valid syntax — only the runtime STRING it produces is broken.
  This script runs the real server locally (dummy registry/secrets, no
  auth, scratch port — `PANEL_DISABLE_AUTH=1`/`ERA_REGISTRY_PATH`/
  `ERA_SECRETS_PATH`/`PORT` all exist for exactly this), fetches its real
  rendered HTML, and syntax-checks the actual `<script>` text a browser
  would receive.

## Restarting the panel

Always `systemctl restart era-dash-panel.service` on the control server —
never start it by hand (`node server.js &`, `nohup node server.js &`,
etc.). A manually-started instance isn't tracked by systemd, so the next
`systemctl restart` starts a fresh copy on top of it without killing it —
the old one just sits there orphaned, holding no port, doing nothing,
silently eating memory until someone notices and kills it by PID (as
happened 2026-08-30, root cause of the leftover-process cleanup that day).
