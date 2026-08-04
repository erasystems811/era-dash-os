# bot-engine

Reusable building blocks for every ERA client's WhatsApp bot logic. These are
not a form to fill in -- there's no spec file describing "your" bot. You (or
Claude Code) write the actual flow -- the stages, the questions, the business
rules -- as real code, using the functions in `lib/`. The rules that kept
breaking on Bali live in these functions instead of being something a builder
has to remember:

- `lib/states.js` -- define a bot's stages and allowed moves in one place.
  Nothing else should track "what stage is this" with its own ad hoc string
  check.
- `lib/extract.js` -- one config-driven way to pull a field out of a
  message. Define a field once (`defineField`), extract it with
  `extractField` -- never hand-write a new one-off prompt per field.
- `lib/send.js` -- the only function allowed to send a message. Enforces:
  role-prefixed internal messages, the handoff introduction to a customer,
  the no-`*`/no-bullet-dash formatting rule, and that a message can only go
  out via an explicit trigger, never as a side effect.
- `lib/swipe-reply.js` -- permanent log of who an outbound message was
  relaying, so a swipe-reply always routes back correctly (repeatable, never
  a one-time flag).
- `lib/handoff.js` -- detects an explicit customer request for a specific
  role, checked only against the roles that business has marked
  customer-requestable.
- `lib/wake-template.js` -- the 24h-window WhatsApp template flow: send the
  template, queue the real content, flush it on ANY reply (never pattern-match
  a specific word).

Run `node bot-engine/lib/lib.test.mjs` any time one of these changes -- it's
the regression check for the toolkit itself, not for any one client's flow.

See `../templates/bot-conversation-rules.md` for the full reasoning behind
each rule and the real incidents that produced it, and `../FIX-PROTOCOL.md`
for how to fix a bug on a live bot without it silently getting undone or
quietly coming back.
