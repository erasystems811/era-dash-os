// The WhatsApp-triggered fix agent's orchestrator -- see the
// project_whatsapp_fix_bot memory for the full design and why. Runs as its
// own permanent service (systemd, like panel/server.js) on the control
// server, so it can drive a Managed Agents session's event stream for as
// long as an investigation takes, and can deploy a confirmed fix with
// plain local shell access (no SSH hop -- it's already on that box).
//
// One investigation at a time on purpose (see lib/state.mjs) -- this is a
// WhatsApp conversation with one person, not a queue.
import 'express-async-errors';
import express from 'express';
import { execSync } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { loadState, saveState } from './lib/state.mjs';
import { sendWhatsApp, isAffirmative, isNegative } from './lib/whatsapp.mjs';
import { loadSecrets } from '../scripts/lib/secrets.mjs';
import { loadRegistry } from '../scripts/lib/registry.mjs';

const secrets = loadSecrets();
const client = new Anthropic({ apiKey: secrets.ANTHROPIC_API_KEY });

const SESSION_BUDGET_CENTS = 300; // $3 hard cap, per Chidera's instruction
const BUDGET_TOP_UP_CENTS = 200; // added on top when she replies to keep going past the cap
const REPO_URL = 'https://github.com/erasystems811/era-dash-os';

const app = express();
app.use(express.json());

// Bali's n8n inbound router is the only caller -- see n8n/01-inbound-router.json's
// "Route by Role" switch, new branch for Chidera's own number. Never reachable
// without this token, so a stray/forged webhook can't kick off a paid session
// or a deploy.
function requireOpsToken(req, res, next) {
  if (!secrets.FIXBOT_WEBHOOK_TOKEN || req.header('x-fixbot-token') !== secrets.FIXBOT_WEBHOOK_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

app.post('/webhook/ops', requireOpsToken, (req, res) => {
  const text = (req.body?.text || '').trim();
  // Ack immediately -- same reasoning as every other WhatsApp webhook in
  // this repo, the real work happens async below and can take minutes.
  res.json({ ok: true });
  handleIncoming(text).catch((err) => notifyFailure(err, 'handleIncoming'));
});

// Any unhandled failure anywhere in this service -- a bad Anthropic API
// call, the account genuinely out of credit, a network blip, a bug in
// this file -- must reach Chidera, not just sit silent in a log she'll
// never check. Found missing 2026-08-30: she pointed out she'd never even
// know if the Anthropic account ran out of credit, since every failure
// point here only ever did console.error before this existed. Also clears
// activeSession so a crash never leaves fixbot permanently stuck thinking
// an investigation is still running.
async function notifyFailure(err, where) {
  console.error(`${where} failed:`, err);
  const message = describeError(err);
  try {
    await sendWhatsApp(secrets, `⚠ Something went wrong (${where}): ${message}`);
  } catch (sendErr) {
    console.error('Also failed to send the failure notice itself:', sendErr);
  }
  const state = loadState();
  if (state.activeSession) saveState({ ...state, activeSession: null });
}

// Anthropic's low-balance error is a 400 whose message contains "credit
// balance" -- there's no dedicated error type/code for it as of this
// writing, so this is a substring check, not a status-code branch. Falls
// back to the raw error message for anything else, trimmed so a WhatsApp
// text doesn't turn into a stack trace.
function describeError(err) {
  const raw = err?.message || String(err);
  if (/credit balance/i.test(raw)) {
    return "Your Anthropic account is out of credit -- top it up before I can investigate anything else.";
  }
  return raw.slice(0, 300);
}

app.get('/healthz', (req, res) => res.json({ ok: true }));

// n8n's routing check (see n8n/01-inbound-router.json's new branch) --
// lets it decide "does fixbot currently care about the next message from
// Chidera" without n8n itself having to know the keyword convention.
app.get('/status', requireOpsToken, (req, res) => {
  const state = loadState();
  res.json({ active: Boolean(state.activeSession) });
});

// Chidera also messages Bali/era-demo's own bots as herself to test them --
// see the project_whatsapp_fix_bot memory. fixbot must never act on a
// message that wasn't actually meant for it, even if something upstream
// forwards it here by mistake: only a message that starts with a trigger
// word starts a NEW investigation. Once an investigation is active,
// anything from her counts as part of that conversation (a follow-up
// answer, a "yes"/"no", "continue") -- no keyword needed there, since at
// that point ambiguity has already been resolved by fixbot itself asking.
const START_TRIGGER = /^\s*fix\b/i;

async function handleIncoming(text) {
  const state = loadState();
  if (!state.activeSession) {
    if (!START_TRIGGER.test(text)) {
      console.log(`Ignored (no active session, no trigger word): "${text}"`);
      return;
    }
    return startInvestigation(text);
  }

  const { status } = state.activeSession;
  if (status === 'awaiting_deploy_confirm') return resolveDeployConfirm(text);
  if (status === 'awaiting_budget_confirm') return resolveBudgetConfirm(text);

  // Investigation already running -- treat this as a follow-up into the
  // same conversation (e.g. she answers a clarifying question) rather than
  // starting a second, competing session.
  await client.beta.sessions.events.send(state.activeSession.sessionId, {
    events: [{ type: 'user.message', content: [{ type: 'text', text }] }],
  });
}

async function startInvestigation(text) {
  const state = loadState();
  if (!state.agentId || !state.environmentId) {
    await sendWhatsApp(secrets, "I'm not set up yet — run fixbot's setup step first (node fixbot/scripts/setup-agent.mjs).");
    return;
  }

  const registry = loadRegistry();
  const ebosClients = registry.clients.filter((c) => c.isEbos && !c.offboarded);
  const named = ebosClients.find((c) => text.toLowerCase().includes((c.displayName || c.name).toLowerCase()));
  const clientName = named ? named.name : state.pendingAlert?.clientName;

  if (!clientName) {
    await sendWhatsApp(secrets, "I don't have anything to investigate right now — no recent alert, and you didn't name a business.");
    return;
  }
  const targetClient = ebosClients.find((c) => c.name === clientName);
  if (!targetClient) {
    await sendWhatsApp(secrets, `I don't recognise "${clientName}" as a live EBOS business.`);
    return;
  }

  const taskText = `Investigate and fix a real code error on the EBOS business "${targetClient.displayName || targetClient.name}".
Subdomain: ${targetClient.subdomain}
Admin token for this business's own API (send as the x-era-admin-token header): ${targetClient.ebosAdminToken}
What Chidera was told: ${state.pendingAlert?.detail || '(no alert detail on file — she asked directly)'}
Her message just now: "${text}"

Start with GET https://${targetClient.subdomain}/api/monitor/summary?hours=6 and GET https://${targetClient.subdomain}/api/monitor/feed?hours=6 (both need the x-era-admin-token header above) via web_fetch to see the real recent errors, then read the mounted repository under /workspace/era-dash-os to find the actual bug in the shared engine.`;

  const session = await client.beta.sessions.create({
    agent: { type: 'agent', id: state.agentId, version: state.agentVersion },
    environment_id: state.environmentId,
    title: `Fix investigation: ${targetClient.displayName || targetClient.name}`,
    budget: { type: 'limit', max_list_cost: { amount: String(SESSION_BUDGET_CENTS), currency: 'USD' } },
    resources: [
      {
        type: 'github_repository',
        url: REPO_URL,
        mount_path: '/workspace/era-dash-os',
        authorization_token: secrets.GITHUB_TOKEN,
        checkout: { type: 'branch', name: 'main' },
      },
    ],
    initial_events: [{ type: 'user.message', content: [{ type: 'text', text: taskText }] }],
  });

  saveState({
    ...state,
    activeSession: { sessionId: session.id, clientName, status: 'investigating', pendingToolUseId: null, pendingFix: null, startedAt: new Date().toISOString() },
  });
  await sendWhatsApp(secrets, `On it — looking into ${targetClient.displayName || targetClient.name} now. I'll text you what I find.`);
  driveSession(session.id).catch((err) => notifyFailure(err, 'driveSession'));
}

// The long-running loop for one session. Runs to an idle/terminated
// boundary and returns -- resolveDeployConfirm/resolveBudgetConfirm
// re-invoke it after sending the resolving event, since the stream ends
// (goes idle) while paused waiting on us.
async function driveSession(sessionId) {
  const stream = await client.beta.sessions.events.stream(sessionId);
  for await (const event of stream) {
    await handleEvent(sessionId, event);
    if (event.type === 'session.status_terminated') break;
    if (event.type === 'session.status_idle') {
      if (event.stop_reason.type === 'requires_action') continue; // handled inside handleEvent, which pauses us via state
      if (event.stop_reason.type === 'budget_reached') break; // handled inside handleEvent, which pauses us via state
      // end_turn or retries_exhausted -- the agent is genuinely done (or
      // gave up) with nothing left pending, not paused waiting on Chidera.
      // Clear activeSession here too, not just on session.status_terminated
      // -- a session can sit idle at end_turn for a long time without ever
      // terminating, and a stale activeSession would make every later
      // message look like a "follow-up" into a conversation that's
      // actually already finished, instead of starting a fresh one.
      const state = loadState();
      if (state.activeSession?.sessionId === sessionId) {
        saveState({ ...state, activeSession: null });
        if (event.stop_reason.type === 'end_turn') {
          await sendWhatsApp(secrets, "That's everything for now — text me again (starting with \"fix\") if you want me to look into something else.");
        } else {
          await sendWhatsApp(secrets, 'I ran into repeated errors and had to stop. Check the Console session log or try again.');
        }
      }
      break;
    }
  }
}

async function handleEvent(sessionId, event) {
  if (event.type === 'agent.message') {
    const text = event.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (text) await sendWhatsApp(secrets, text);
    return;
  }

  if (event.type === 'agent.custom_tool_use' && event.name === 'deploy_fix') {
    const state = loadState();
    saveState({ ...state, activeSession: { ...state.activeSession, status: 'awaiting_deploy_confirm', pendingToolUseId: event.id, pendingFix: event.input } });
    const files = (event.input.files_changed || []).join(', ');
    await sendWhatsApp(
      secrets,
      `🔧 Proposed fix: ${event.input.summary}\n\nFiles: ${files}\nBranch: ${event.input.branch}\n\nReply YES to deploy this, or tell me what to change instead.`
    );
    return;
  }

  if (event.type === 'session.status_idle' && event.stop_reason?.type === 'budget_reached') {
    const state = loadState();
    saveState({ ...state, activeSession: { ...state.activeSession, status: 'awaiting_budget_confirm' } });
    await sendWhatsApp(
      secrets,
      `I hit the $3 spending cap still investigating this. Reply CONTINUE if it's worth another look (adds $2 more), or I'll stop here.`
    );
    return;
  }

  if (event.type === 'session.status_terminated') {
    const state = loadState();
    saveState({ ...state, activeSession: null });
  }
}

async function resolveDeployConfirm(text) {
  const state = loadState();
  const { sessionId, pendingToolUseId, pendingFix, clientName } = state.activeSession;

  let resultText;
  if (isAffirmative(text)) {
    await sendWhatsApp(secrets, 'Deploying now...');
    try {
      await actuallyDeploy(pendingFix);
      resultText = 'Deployed successfully.';
      await sendWhatsApp(secrets, `✅ Deployed. ${clientName} should be running the fix now.`);
    } catch (err) {
      resultText = `Deploy failed: ${err.message}`;
      await sendWhatsApp(secrets, `❌ Deploy failed: ${err.message}`);
    }
  } else {
    resultText = isNegative(text) ? 'Chidera declined this fix.' : `Chidera replied instead of confirming: "${text}"`;
  }

  await client.beta.sessions.events.send(sessionId, {
    events: [{ type: 'user.custom_tool_result', custom_tool_use_id: pendingToolUseId, content: [{ type: 'text', text: resultText }] }],
  });
  saveState({ ...state, activeSession: { ...state.activeSession, status: 'investigating', pendingToolUseId: null, pendingFix: null } });
  driveSession(sessionId).catch((err) => notifyFailure(err, 'driveSession'));
}

async function resolveBudgetConfirm(text) {
  const state = loadState();
  const { sessionId } = state.activeSession;

  if (!isAffirmative(text)) {
    await sendWhatsApp(secrets, 'Okay, stopping there.');
    saveState({ ...state, activeSession: null });
    return;
  }

  const session = await client.beta.sessions.retrieve(sessionId);
  const consumedCents = Math.ceil(Number(session.usage?.list_cost?.amount || SESSION_BUDGET_CENTS));
  const newCap = consumedCents + BUDGET_TOP_UP_CENTS;
  await client.beta.sessions.update(sessionId, { budget: { type: 'limit', max_list_cost: { amount: String(newCap), currency: 'USD' } } });
  await sendWhatsApp(secrets, `Continuing (raised the cap to $${(newCap / 100).toFixed(2)}).`);
  saveState({ ...state, activeSession: { ...state.activeSession, status: 'investigating' } });
  driveSession(sessionId).catch((err) => notifyFailure(err, 'driveSession'));
}

// The only place this service writes to the real repo/live businesses --
// everything before this point only ever touched the agent's own isolated
// sandbox. Merges the agent's already-pushed branch into main (never
// commits straight to main itself), pushes that back to GitHub so the repo
// stays the source of truth, then runs the real deploy: push-update.mjs
// for a business-template change, a panel restart for a panel change, or
// both if the fix touched both. Local shell access, no SSH -- this process
// already runs on the control server.
async function actuallyDeploy(fix) {
  const cwd = '/opt/era-control/era-dash-os';
  const authedUrl = `https://x-access-token:${secrets.GITHUB_TOKEN}@github.com/erasystems811/era-dash-os.git`;

  execSync(`git fetch "${authedUrl}" ${fix.branch}:refs/remotes/origin/${fix.branch}`, { cwd, stdio: 'pipe' });
  execSync(`git checkout main`, { cwd, stdio: 'pipe' });
  execSync(`git merge --no-edit origin/${fix.branch}`, { cwd, stdio: 'pipe' });
  execSync(`git push "${authedUrl}" main`, { cwd, stdio: 'pipe' });

  const files = fix.files_changed || [];
  const touchesBusinessTemplate = files.some((f) => f.startsWith('ebos-templates/') || f.startsWith('esf-templates/'));
  const touchesPanel = files.some((f) => f.startsWith('panel/'));

  if (touchesBusinessTemplate) {
    execSync('node push-update.mjs --all-ebos', { cwd: `${cwd}/scripts`, stdio: 'pipe', timeout: 5 * 60 * 1000 });
  }
  if (touchesPanel) {
    execSync('systemctl restart era-dash-panel.service', { stdio: 'pipe' });
  }
}

// Bound to all interfaces so Bali's n8n container can reach it over the
// docker bridge gateway (172.18.0.1, confirmed via `docker network
// inspect bali_default`) -- n8n has no host.docker.internal entry
// configured, same reasoning as panel/server.js's own bind. The real
// access control is the FIXBOT_WEBHOOK_TOKEN check on every route, not
// network position -- same model as this repo's other 0.0.0.0 services.
const port = process.env.PORT || 4200;
app.listen(port, '0.0.0.0', () => console.log(`fixbot orchestrator listening on 0.0.0.0:${port}`));
