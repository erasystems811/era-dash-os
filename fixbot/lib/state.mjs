// The fixbot's own small persisted state -- agent/environment IDs (set once
// by scripts/setup-agent.mjs) plus at most one active investigation at a
// time. Deliberately one-at-a-time for v1: Chidera investigates one alert
// via WhatsApp before starting another, same mental model as a real text
// conversation. Same load/save-a-JSON-file pattern as scripts/lib/
// registry.mjs, just a separate file since this isn't a client record.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const STATE_PATH = process.env.FIXBOT_STATE_PATH || '/opt/era-control/fixbot-state.json';

export function loadState() {
  if (!existsSync(STATE_PATH)) return { agentId: null, agentVersion: null, environmentId: null, activeSession: null };
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
}

export function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}
