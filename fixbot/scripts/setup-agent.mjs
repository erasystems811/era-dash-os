#!/usr/bin/env node
// Usage: node scripts/setup-agent.mjs
//
// One-time (or rare, when the persona/tools genuinely need to change)
// setup step -- creates the Managed Agent + Environment and stores their
// IDs in fixbot-state.json. Safe to re-run: if an agent/environment ID is
// already stored, this UPDATES that agent in place (new version) instead
// of creating a second one, per the Managed Agents rule "agent once,
// updated in place, never re-created per run" (see the claude-api skill's
// managed-agents-core.md).
//
// Deliberately narrow tool surface: bash/read/write/edit/glob/grep for
// investigating the mounted era-dash-os repo, web_fetch so it can call
// this business's own /api/monitor/summary and /api/monitor/feed to see
// the real error data (not just static code), and exactly one custom
// tool -- deploy_fix -- which is the ONLY way this agent can make a real
// live change. Everything else (reading code, trying things in its own
// sandbox, even git commit/push to a branch) it can do freely; going
// live always routes through deploy_fix, which fixbot/server.js gates on
// an actual WhatsApp "yes" from Chidera before it does anything.
import Anthropic from '@anthropic-ai/sdk';
import { loadState, saveState } from '../lib/state.mjs';
import { loadSecrets } from '../../scripts/lib/secrets.mjs';

const secrets = loadSecrets();
const client = new Anthropic({ apiKey: secrets.ANTHROPIC_API_KEY });

const AGENT_CONFIG = {
  name: 'ERA Ops Fix Agent',
  model: { id: 'claude-opus-5', effort: 'high' },
  system: `You are an ops assistant for ERA Systems' shared EBOS/ESF platform (era-dash-os). Chidera runs this platform for many small businesses; you are triggered when her Bot Monitoring alerts fire, meaning a specific business's bot hit a real code error (not a business/customer issue -- those never reach you).

Your job, in order:
1. Investigate the real cause using the mounted era-dash-os repository plus web_fetch against the business's own /api/monitor/summary and /api/monitor/feed endpoints (you'll be given the business name, subdomain, and admin token in the task). Read actual code, don't guess.
2. Reply with a short, plain-language diagnosis Chidera (not a developer) can understand -- what broke, why, and what you want to change. No jargon dumps.
3. Only when you have a specific, scoped fix: commit it to a new branch in the mounted repo (never commit straight to main) and push the branch, then call deploy_fix with a one-paragraph summary and the list of files changed. This is the ONLY way anything reaches a live business -- deploy_fix always pauses for a human to confirm before anything actually goes live, so call it as soon as you have a real fix ready rather than holding back.
4. If you cannot find a real fix, say so plainly instead of guessing or proposing a risky change "just in case."

Never touch a business's live server directly (no SSH, no docker commands) -- deploy_fix is the only path to production, and it's not yours to execute, only to request.`,
  tools: [
    {
      type: 'agent_toolset_20260401',
      default_config: { enabled: true },
      configs: [{ name: 'web_search', enabled: false }],
    },
    {
      type: 'custom',
      name: 'deploy_fix',
      description:
        "Request that a fix you've committed and pushed to a branch actually goes live. This ALWAYS pauses for a human (Chidera, over WhatsApp) to approve before anything happens -- call it as soon as you have a real, scoped fix ready, don't wait for extra certainty.",
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'One paragraph, plain language: what was broken, why, and what this fix changes.' },
          branch: { type: 'string', description: 'The git branch you pushed the fix to.' },
          files_changed: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths of every file the fix touches.' },
        },
        required: ['summary', 'branch', 'files_changed'],
      },
    },
  ],
};

const ENV_CONFIG = {
  name: 'era-fixbot-env',
  config: {
    type: 'cloud',
    networking: {
      type: 'limited',
      allow_package_managers: false,
      allowed_hosts: ['*.erasystems.com.ng', 'github.com', 'api.github.com'],
    },
  },
};

async function main() {
  const state = loadState();

  let environmentId = state.environmentId;
  if (!environmentId) {
    const env = await client.beta.environments.create(ENV_CONFIG);
    environmentId = env.id;
    console.log('Created environment:', environmentId);
  } else {
    console.log('Reusing existing environment:', environmentId);
  }

  let agentId = state.agentId;
  let agentVersion;
  if (!agentId) {
    const agent = await client.beta.agents.create(AGENT_CONFIG);
    agentId = agent.id;
    agentVersion = agent.version;
    console.log('Created agent:', agentId, 'version', agentVersion);
  } else {
    const agent = await client.beta.agents.update(agentId, AGENT_CONFIG);
    agentVersion = agent.version;
    console.log('Updated agent:', agentId, 'to version', agentVersion);
  }

  saveState({ ...state, agentId, agentVersion, environmentId });
  console.log('Saved to fixbot-state.json');
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
