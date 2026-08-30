import { pool } from '../lib/db.js';
import { defineStates } from '../bot-engine/index.js';

// Loads the state map fresh from bot_state every call rather than caching --
// it's meant to be editable live from the Train the bot tab and the
// workstation's conversation-flow canvas, and this stays cheap (one query)
// against the small row count involved.
export async function loadStateMachine() {
  const { rows } = await pool.query('select key, allowed_next from bot_state');
  const transitions = {};
  for (const r of rows) transitions[r.key] = r.allowed_next || [];
  return defineStates(transitions);
}
