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
