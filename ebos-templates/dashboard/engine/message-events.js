import { EventEmitter } from 'node:events';

// Chidera, 2026-09-25: "that customer reply coming in and staff seeing it
// pop in live without refreshing it" -- the earlier fix (a 15s poll on
// ConversationDetail.jsx/Conversations.jsx) meant a reply could sit
// unseen for up to 15 seconds; this makes it genuinely instant instead.
// One Node process per business (each business is its own container --
// docker-compose.yml.template), so a single in-process EventEmitter is
// the whole pub/sub mechanism -- no Redis, no separate service. Every
// real message (engine/flow.js's logMessage, inbound or outbound) emits
// here; routes/api.js's SSE routes below turn that into a push to
// whichever staff browser tabs are actually open and watching.
export const messageEvents = new EventEmitter();
// Unbounded -- one listener per open SSE connection (one per staff
// browser tab watching a conversation or the conversation list), easily
// more than the default warning threshold of 10 during a busy shift.
messageEvents.setMaxListeners(0);
