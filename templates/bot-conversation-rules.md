# Bot Conversation Rules — Reusable Reference

Distilled from building Bali (event venue WhatsApp bot), so the next client doesn't
start from scratch. These are the conventions that turned out to matter — most were
learned the hard way, from a real bug or a real owner correction. Reuse the pattern,
adapt the specifics (roles, commands, business logic) to the new client.

## 1. The one safety rule that matters most

**A message reaches a real customer ONLY through an explicit, deliberate trigger —
never as a side effect of anything else.** The two allowed triggers:

- PM swipe-replies to something the client actually sent
- PM types `[event/client name]: message`

No other path may ever relay to a client — not "only one thing is open," not "the
booking is connected," not any other implicit inference, no matter how convenient.
This was stated twice by the owner, the second time as "I won't tolerate any leak by
mistake." If a feature seems to need an implicit relay for convenience, ask before
building it — don't assume.

## 2. Command syntax conventions (PM-facing)

Keep these fuzzy/natural on the input side, but the underlying trigger logic itself
must be explicit and deterministic — never let an LLM decide *whether* to act, only
help with *wording*.

- **Reach a specific staff role:** `role: message` (e.g. `lawyer: please check this`).
  Gate behind an explicit allowlist of roles whose process is actually mapped —
  don't wire up every role from day one.
- **Generate an invoice for a real booking:** `invoice [event name][: details]` —
  fuzzy-matched against `generate/create/make/send/draft invoice for/to X`. Anything
  after a colon is treated as PM-supplied negotiation details, fed through the same
  extraction as a real transcript.
- **Generate a one-off invoice with no booking/customer at all:** same command, but
  when no booking matches AND real details were given, skip the booking/customer
  system entirely — extract line items, render the PDF, send it straight back to the
  PM. Nothing saved to any table, no client ever contacted. This is for a PM who
  explicitly doesn't want to "follow the customer route." If the PM gave a name but
  no details, ask for them **and track the outbound ask by its WhatsApp message ID**
  so a swipe-reply with the details is recognized and routed correctly — don't let it
  fall through to the generic chat fallback.

## 3. LLM reliability — patterns that bite, every time, in every codebase like this

These aren't Bali-specific quirks. Expect every one of these on a new client build.

- **Never trust an LLM with date arithmetic.** Resolve relative dates ("next
  Friday", "tomorrow") with deterministic code, not a model call. Verified live:
  gpt-4o resolved "friday next week" to the wrong day.
- **A bare day-of-month with no month WILL get a hallucinated month and year if you
  don't explicitly forbid it.** ("23rd" → the model invented a full date, wrong year
  included.) State explicitly: a day alone is not a full date, don't guess.
- **Capitalization silently biases classifiers.** A lowercase answer ("mad party
  entertainment") got rejected while the identical capitalized text passed. State
  explicitly: accept any capitalization, WhatsApp users type in lowercase.
- **Casual openers bias classifiers too.** "hey any update?" got misread as a
  non-question because of the "hey," despite explicit contrary examples. Judge the
  whole message, not the opener.
- **A bare short answer loses all meaning once separated from its question.** PM
  replying "full" to "is payment full or in parts?" got rejected as meaningless when
  fed to the model alone — restate the question inline whenever you're re-running
  extraction after a follow-up question. This will bite any "ask a clarifying
  question, then re-extract" flow.
- **For anything structural (what to ask, in what order, whether to trigger an
  action), use deterministic code + small randomized phrase pools — never free-form
  LLM decision-making.** Free-form generation is fine, even preferred, for wording
  once the content is already decided by code. The owner's own words: "I don't trust
  that LLM discretion."
- **Verify every extraction fix against the real API directly, both positive and
  negative cases, before deploying.** A couple of passing checks is not enough for
  anything that feeds a number a human might rubber-stamp (invoice totals) — run the
  real failing case 5-6 times, not once.
- **After deploying, verify the fix actually landed in the live system** (query the
  workflow's stored code / hit the real endpoint) — a "sync succeeded" log message is
  not proof. A cron job or a race can silently revert an uncommitted edit.

## 4. Sandbox conventions (build this for every client, don't skip it)

- Fully separate n8n instance + separate database. Structurally incapable of
  reaching a real phone or a real payment provider — not just gated by a flag.
- Multi-persona test UI: several simulated people live at once (customer + PM +
  lawyer in parallel), not one switchable persona.
- Role list read dynamically from the database's own role constraint/options — never
  hardcode a fixed cast. New roles show up automatically.
- Snapshot-based undo, one action at a time, not just an all-or-nothing reset.
- **Never trigger an escalation/notify path against a live person without warning
  them first.** Most roles (PM, lawyer) have exactly one real contact — there is no
  synthetic stand-in. A "test" message can and will reach them for real.

## 5. Migration/infra gotchas (if this ever moves servers)

- Postgres roles are cluster-wide, but grants are per-database — diff `\du` AND
  `\dp`/`pg_sequences` for **every** database on the old vs new server, not just the
  main one.
- A `SERIAL`/`GENERATED ... AS IDENTITY` column's backing sequence needs its own
  grant, separate from the table grant — this won't surface until an INSERT is
  actually attempted.
- **Never leave a code fix as a bare file edit on the server if any sync job runs
  `git checkout`/pulls on a schedule** — it will get silently wiped. Commit and push
  to the real git remote as part of every fix, not after.

## 6. PM control model

- Bot runs the conversation by default (bot-led). PM can take over at any point
  (pm-led / "connected"), and once connected, generally stays connected through
  invoicing/contract/signed, not just during live negotiation.
- The PM has full authority to issue direct commands to the bot itself (generate an
  invoice, rename an event, correct a draft) — these are **tasks**, not customer
  messages, and should be recognized as commands even when there's no underlying
  client conversation happening. Don't force every PM action through a
  customer-conversation lens.
- Multiple bookings/clients can be connected to the PM simultaneously — no
  open/close lock required to work more than one at a time.
