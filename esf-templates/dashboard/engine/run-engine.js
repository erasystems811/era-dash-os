// The generic run/entry state machine (build schema v2.0 section 2.7's
// "engine layer"). Reads task/step config fresh from Postgres on every
// call -- same discipline as ebos-templates/dashboard/engine/state-machine.js
// -- and is the ONE code path every business (retail, restaurant, salon...)
// runs through. Nothing business-specific lives here, only the nine generic
// engine rules from build schema v2.0 section 4.

import { randomBytes } from 'node:crypto';
import { pool } from '../lib/db.js';
import { validateProof, ReAskError } from './proof-types.js';
import { dispatchAlert } from './alerts.js';
import { sendWhatsApp, sendWhatsAppTemplate } from './whatsapp-send.js';
import { sendWakeTemplateIfNeeded } from '../bot-engine/wake-template.js';

const DAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

export function todayCode(date = new Date()) {
  return DAY_CODES[date.getDay()];
}

export async function getBusiness() {
  const { rows } = await pool.query(`select * from business limit 1`);
  return rows[0] || null;
}

export async function getStaffByPhone(phone) {
  const { rows } = await pool.query(`select * from staff where phone = $1 and active`, [phone]);
  return rows[0] || null;
}

async function getStaffById(id) {
  const { rows } = await pool.query(`select * from staff where id = $1`, [id]);
  return rows[0] || null;
}

async function getEffectiveProof(step, staffId) {
  const { rows } = await pool.query(
    `select proof_type, proof_config, reason from step_override
     where step_id = $1 and staff_id = $2 and (expires_on is null or expires_on >= current_date)`,
    [step.id, staffId]
  );
  if (rows[0]) return { proof_type: rows[0].proof_type, proof_config: rows[0].proof_config, overrideReason: rows[0].reason };
  return { proof_type: step.proof_type, proof_config: step.proof_config, overrideReason: null };
}

// Earliest still-open run for this staff member -- if she has more than one
// task due at once, task.seq (display order) decides which she's walked
// through first. Excludes a run currently waiting on someone ELSE's
// countersign confirmation -- otherwise she could just answer her own
// countersign step herself and the whole point of requiring a second
// person's confirmation would be defeated (caught by a real test: her own
// "hello?" was completing the run before this exclusion existed).
async function findOpenRunForStaff(staffId) {
  const { rows } = await pool.query(
    `select run.*, task.seq as task_seq, task.name as task_name, task.mode as task_mode
     from run join task on task.id = run.task_id
     where run.staff_id = $1 and run.status = 'open' and run.pending_countersign_staff_id is null
     order by task.seq asc, run.started_at asc
     limit 1`,
    [staffId]
  );
  return rows[0] || null;
}

// A run whose current countersign step is waiting on THIS staff member's
// confirmation -- checked before her own findOpenRunForStaff lookup, since
// the confirming person is very likely a different staff member with her
// own separate tasks/runs too (build schema v2.0's countersign proof type).
async function findPendingCountersignRun(staffId) {
  const { rows } = await pool.query(`select * from run where pending_countersign_staff_id = $1 and status = 'open' limit 1`, [staffId]);
  return rows[0] || null;
}

// One active staff member holding `role`, excluding the original staff
// member herself (a countersign is meant to be a second person). If more
// than one holds the role, the earliest-created is picked -- deterministic,
// not "whoever answers first" (that would need fanning the prompt out to
// several people and racing their replies, real added complexity for a
// case the spec doesn't ask for).
async function findConfirmingStaff(role, excludeStaffId) {
  if (!role) return null;
  const { rows } = await pool.query(
    `select * from staff where active and role = $1 and id != $2 order by created_at asc limit 1`,
    [role, excludeStaffId]
  );
  return rows[0] || null;
}

async function getStep(taskId, seq) {
  const { rows } = await pool.query(`select * from step where task_id = $1 and seq = $2`, [taskId, seq]);
  return rows[0] || null;
}

async function recordEntry({ run, step, staffId, answer, value = null, media_url = null, lat = null, lng = null, note = null, applied_proof_type }) {
  await pool.query(
    `insert into entry (run_id, step_id, staff_id, answer, value, media_url, lat, lng, note, applied_proof_type)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [run.id, step.id, staffId, answer, value, media_url, lat, lng, note, applied_proof_type]
  );
}

// Sequence enforcement (engine rule 1): the next step is only ever the
// current step's seq + 1 within the same task -- never computed any other
// way. Advances current_seq, or closes the run when there's no next step.
async function advance(run, currentStep) {
  const next = await getStep(run.task_id, currentStep.seq + 1);
  if (next) {
    await pool.query(`update run set current_seq = $1 where id = $2`, [next.seq, run.id]);
    return { done: false, nextStep: next };
  }
  await pool.query(`update run set status = 'complete', completed_at = now() where id = $1`, [run.id]);
  return { done: true, nextStep: null };
}

function alertContext(run, staffId) {
  return `${run.task_id}:${staffId}`;
}

// staffId is optional (the very first prompt before a run technically has
// one answering it yet still knows who it's for) -- when given, a
// step_override's reason is surfaced here, never silently applied. Build
// schema v2.0 section 3.7: "Make it visible to her, including the reason.
// Silent per person rules get discovered eventually, and being discovered
// is worse than being told."
async function promptFor(step, staffId = null) {
  const base = step.instruction;
  const skipHint = step.optional ? '\n(Reply SKIP if this does not apply.)' : '';
  let overrideNote = '';
  if (staffId) {
    const effective = await getEffectiveProof(step, staffId);
    if (effective.overrideReason) overrideNote = `\n(Note: ${effective.overrideReason})`;
  }
  return `${base}${skipHint}${overrideNote}`;
}

// Delivers one step's prompt to whichever phone should actually receive it,
// and returns { reply } ONLY when that recipient happens to be
// currentSenderId (the person who just texted) -- letting the caller (in
// every existing call site) reply the normal, single-message way. When the
// recipient is someone else entirely (a countersign confirmer), this sends
// directly and returns { reply: null }, so the caller still owes its own
// inbound sender a short, separate acknowledgment.
async function deliverStepPrompt(run, step, currentSenderId) {
  const effective = await getEffectiveProof(step, run.staff_id);

  if (effective.proof_type === 'countersign') {
    const confirmer = await findConfirmingStaff(effective.proof_config?.role, run.staff_id);
    if (confirmer) {
      await pool.query(`update run set pending_countersign_staff_id = $1 where id = $2`, [confirmer.id, run.id]);
      const owner = await getStaffById(run.staff_id);
      const msg = `${owner?.name || 'A colleague'} needs your confirmation: ${step.instruction}\nReply to confirm (or describe what you saw).`;
      await sendWhatsApp(confirmer.phone, msg);
      // TODO: the confirmer's own 24h WhatsApp window is not wake-template
      // checked here (unlike openRunAndPrompt's scheduled prompts) -- a
      // countersign confirmer who hasn't messaged this number in 24h will
      // silently fail to receive this. Flagged, not silently wrong; low
      // impact today since countersign is never step 1 in any worked
      // example this engine ships with.
      if (run.staff_id === currentSenderId) return { reply: `Sent to ${confirmer.name} for confirmation. You'll be told once it's done.` };
      return { reply: null };
    }
    // No matching staff to route to -- degrade to the same self-report
    // fallback proof-types.js's countersign case already documents, rather
    // than silently stalling the run on a confirmer that doesn't exist.
  }

  const text = await promptFor(step, run.staff_id);
  if (run.staff_id === currentSenderId) return { reply: text };
  const owner = await getStaffById(run.staff_id);
  if (owner) await sendWhatsApp(owner.phone, text);
  return { reply: null };
}

// Build schema v2.0 section 6: "she taps once to open it, fills every
// field, submits once." Not the same as a wake-template send -- a form
// link is its own real content (not a template Meta pre-approves), so it
// always needs a genuine freeform-window message; if that's outside the
// 24h window this send will fail exactly like any other freeform send
// would. TODO: no wake-template equivalent exists for form-mode opens yet
// -- flagged, not silently wrong, matching this codebase's existing
// discipline for known gaps.
async function openFormRun(run, task, staff) {
  const token = randomBytes(24).toString('hex');
  await pool.query(`update run set form_token = $1 where id = $2`, [token, run.id]);
  const publicUrl = process.env.PUBLIC_URL || '';
  await sendWhatsApp(staff.phone, `${task.name} is ready. Fill it out here: ${publicUrl}/form/${token}`);
  return { ...run, form_token: token };
}

// Opens a run and sends its first prompt, respecting the 24h WhatsApp
// window (bot-engine/wake-template.js). Called by the scheduler when a task
// becomes due -- never by a staff reply. currentSenderId is never set here
// (nobody has texted yet) -- deliverStepPrompt's own direct-send path
// covers a step-1 countersign, wake-template-unchecked per its own TODO.
export async function openRunAndPrompt(task, staff) {
  const today = new Date().toISOString().slice(0, 10);
  const existing = await pool.query(`select id from run where task_id = $1 and staff_id = $2 and run_date = $3`, [task.id, staff.id, today]);
  if (existing.rows[0]) return null; // already opened today -- engine rule 8, a run belongs to a date

  const { rows } = await pool.query(
    `insert into run (task_id, staff_id, run_date, current_seq, status, started_at) values ($1, $2, $3, 1, 'open', now()) returning *`,
    [task.id, staff.id, today]
  );
  const run = rows[0];
  const step = await getStep(task.id, 1);
  if (!step) return run; // task has no steps yet -- nothing to prompt

  if (task.mode === 'form') return openFormRun(run, task, staff);

  const effective = await getEffectiveProof(step, staff.id);
  if (effective.proof_type === 'countersign') {
    await deliverStepPrompt(run, step, null);
    return run;
  }

  const { rows: lastMsg } = await pool.query(
    `select created_at from message where staff_id = $1 and direction = 'inbound' order by created_at desc limit 1`,
    [staff.id]
  );

  const { sentTemplate } = await sendWakeTemplateIfNeeded({
    lastCustomerMessageAt: lastMsg[0]?.created_at || 0,
    sendTemplate: () => sendWhatsAppTemplate(staff.phone, 'esf_task_due'),
    // Nothing to actually queue -- the real prompt is re-derived from
    // run.current_seq/step on her next reply (see handleStaffReply's
    // wake_sent_at branch below), never cached as separate text. One
    // source of truth, same reasoning as run.wake_sent_at's schema comment.
    queuePendingText: async () => {},
    businessName: (await getBusiness())?.name,
    pendingText: null,
  });

  if (sentTemplate) {
    const { rows: updated } = await pool.query(`update run set wake_sent_at = now() where id = $1 returning *`, [run.id]);
    return updated[0];
  }
  await sendWhatsApp(staff.phone, await promptFor(step, staff.id));
  return run;
}

// The main entry point, called by webhook-whatsapp.js for every inbound
// message. Returns { reply } (text to send back to whoever just texted) or
// null if nothing should be sent.
export async function handleStaffReply({ staff, input }) {
  const pendingRun = await findPendingCountersignRun(staff.id);
  if (pendingRun) return handleCountersignConfirmation(pendingRun, staff, input);

  const run = await findOpenRunForStaff(staff.id);
  if (!run) {
    return { reply: 'No task is due for you right now. You will be messaged when one is.' };
  }

  // Wake-template flush: this is her first reply after a template woke the
  // conversation back open -- treat it as "the window is open again", not
  // as an answer, and send the real step content now (bot-engine/
  // wake-template.js's shouldFlushQueuedMessage contract: ANY reply flushes,
  // never pattern-matched against specific wording).
  if (run.wake_sent_at) {
    await pool.query(`update run set wake_sent_at = null where id = $1`, [run.id]);
    const step = await getStep(run.task_id, run.current_seq);
    if (!step) return { reply: 'This task has no steps configured yet -- ask your manager.' };
    return { reply: await promptFor(step, staff.id) };
  }

  const step = await getStep(run.task_id, run.current_seq);
  if (!step) return { reply: 'This task has no steps configured yet -- ask your manager.' };

  // A form-mode task's run still answers to a normal chat reply here, on
  // purpose -- openFormRun only changes what she was SENT (a link instead
  // of step 1's instruction), not the underlying run/step state machine.
  // If she'd rather just answer in the chat instead of opening the form,
  // that's a second valid interface into the exact same run, not a
  // separate code path to keep in sync (routes/form.js is the other one).

  // Optional-step skip, available on any step marked optional -- a plain
  // generic mechanism, not per-business config.
  if (step.optional && input.type === 'text' && /^skip$/i.test(input.text.trim())) {
    const effective = await getEffectiveProof(step, staff.id);
    await recordEntry({ run, step, staffId: staff.id, answer: 'skipped', applied_proof_type: effective.proof_type });
    return deliverNextStepOrComplete(run, step, staff.id);
  }

  // The generic "report a problem instead of proof" escape hatch, available
  // on every step regardless of proof_type -- see build schema v2.0
  // section 14 for why this (not a per-proof-type guess) is what
  // on_problem actually governs.
  const problemMatch = input.type === 'text' && /^problem\b[:\s]*/i.test(input.text.trim());
  if (problemMatch) {
    const effective = await getEffectiveProof(step, staff.id);
    const note = input.text.trim().replace(/^problem\b[:\s]*/i, '') || null;
    await recordEntry({ run, step, staffId: staff.id, answer: 'problem', note, applied_proof_type: effective.proof_type });
    return handleProblem(run, step, staff, note);
  }

  const effective = await getEffectiveProof(step, staff.id);
  let result;
  try {
    result = await validateProof({ proofType: effective.proof_type, proofConfig: effective.proof_config, input, business: await getBusiness() });
  } catch (err) {
    if (err instanceof ReAskError) return { reply: err.message };
    throw err;
  }

  await recordEntry({
    run,
    step,
    staffId: staff.id,
    answer: result.answer,
    value: result.value ?? null,
    media_url: result.media_url ?? null,
    lat: result.lat ?? null,
    lng: result.lng ?? null,
    note: result.note ?? null,
    applied_proof_type: effective.proof_type,
  });

  // Structural problem (out-of-radius location, an unverified `api` flag) --
  // same on_problem policy as a staff-reported problem.
  if (result.answer === 'problem') return handleProblem(run, step, staff, result.note);

  // Photo accumulation: proof_config.min > 1 means this step isn't
  // satisfied by the first photo alone -- each WhatsApp message only ever
  // carries one image, so multiple "done" entries against the same step
  // accumulate until the count is met, and only then does the run advance.
  // No separate counter column: entry is already the one source of truth
  // for what's been received, so this counts real rows instead of
  // maintaining a second number that could drift from them.
  if (effective.proof_type === 'photo' && (effective.proof_config?.min || 1) > 1) {
    const min = effective.proof_config.min;
    const { rows } = await pool.query(
      `select count(*)::int as n from entry where run_id = $1 and step_id = $2 and answer = 'done'`,
      [run.id, step.id]
    );
    if (rows[0].n < min) {
      return { reply: `Photo ${rows[0].n} of ${min} received. Please send ${min - rows[0].n} more.` };
    }
  }

  return deliverNextStepOrComplete(run, step, staff.id);
}

// A countersign confirmer's reply is deliberately simple, matching the
// self-report fallback's own leniency: any non-empty text counts as
// confirmation, recorded against the ORIGINAL staff member's run (it's
// still her task/entry), with a note naming who actually confirmed it --
// never silently attributed to her as if she'd done it herself.
async function handleCountersignConfirmation(run, confirmer, input) {
  if (input.type !== 'text' || !input.text?.trim()) {
    return { reply: 'Please reply to confirm (or describe what you saw).' };
  }
  const step = await getStep(run.task_id, run.current_seq);
  if (!step) return { reply: 'That confirmation is no longer needed -- thanks anyway.' };
  const effective = await getEffectiveProof(step, run.staff_id);

  await recordEntry({
    run,
    step,
    staffId: run.staff_id,
    answer: 'done',
    value: input.text.trim(),
    note: `Confirmed by ${confirmer.name} (${confirmer.role}).`,
    applied_proof_type: effective.proof_type,
  });
  await pool.query(`update run set pending_countersign_staff_id = null where id = $1`, [run.id]);

  const { reply } = await deliverNextStepOrComplete(run, step, confirmer.id);
  return { reply: reply || 'Thanks, recorded.' };
}

async function handleProblem(run, step, staff, note) {
  const business = await getBusiness();
  const cleanNote = note?.trim().replace(/\.+$/, '');
  const detail = `${business?.name || 'A business'}: ${staff.name} reported a problem on "${step.instruction}"${cleanNote ? ` -- ${cleanNote}` : ''}.`;

  if (step.on_problem === 'block') {
    await pool.query(`update run set status = 'blocked' where id = $1`, [run.id]);
    await dispatchAlert({ event: 'blocked', message: detail, context: alertContext(run, staff.id) });
    return { reply: 'Noted. This is paused and your manager has been told -- wait for them before continuing.' };
  }
  if (step.on_problem === 'alert') {
    await dispatchAlert({ event: 'problem', message: detail, context: alertContext(run, staff.id) });
  }
  // 'continue' (or 'alert', which still continues after notifying) both
  // advance normally.
  return deliverNextStepOrComplete(run, step, staff.id);
}

// Advances the run and either delivers the next step's prompt or the
// completion message -- to whichever phone actually owns the run
// (run.staff_id), which is usually currentSenderId (the common,
// self-answering case, handled with a single reply) but sometimes isn't
// (a countersign confirmer just completed someone else's step).
async function deliverNextStepOrComplete(run, step, currentSenderId) {
  const { done, nextStep } = await advance(run, step);
  if (!done) return deliverStepPrompt(run, nextStep, currentSenderId);

  const text = 'Task complete. Well done.';
  if (run.staff_id === currentSenderId) return { reply: text };
  const owner = await getStaffById(run.staff_id);
  if (owner) await sendWhatsApp(owner.phone, text);
  return { reply: null };
}

// --- Form mode (build schema v2.0 section 6) -- routes/form.js's engine
// layer, the same way everything above is webhook-whatsapp.js's. ---

export async function getRunByFormToken(token) {
  const { rows } = await pool.query(`select * from run where form_token = $1`, [token]);
  return rows[0] || null;
}

export async function getTaskById(taskId) {
  const { rows } = await pool.query(`select * from task where id = $1`, [taskId]);
  return rows[0] || null;
}

export async function getStepsForTask(taskId) {
  const { rows } = await pool.query(`select * from step where task_id = $1 order by seq`, [taskId]);
  return rows;
}

export { getEffectiveProof };

// Proof types that need real-time device interaction (a live GPS fix, the
// camera) don't fit "fill this out later, submit once" -- build schema
// v2.0 section 6 only names location as excluded; photo is excluded here
// too as an explicit v1 scope cut (no file-upload handling in the form
// yet), not silently dropped. Enforced at step create/edit time
// (routes/tasks.js) so a form-mode task can never end up with one of
// these in the first place, not discovered here at fill-time.
export const FORM_INCOMPATIBLE_PROOF_TYPES = ['location', 'photo'];

// Validates and records every step's answer as one atomic submission (all
// or nothing -- if anything fails validation, NOTHING is recorded, and the
// caller re-shows the form with field-level errors instead of a partial
// record). On success, on_problem is evaluated for every problem step
// AFTER all of them are already recorded -- section 6's own stated limit
// ("on_problem: block evaluates after submission, not during") -- so a
// block never stops her from finishing the rest of the form, it just marks
// the whole run blocked once she's done.
export async function submitForm(run, submissionsByStepId) {
  const steps = await getStepsForTask(run.task_id);
  const business = await getBusiness();
  const results = [];
  const errors = {};

  for (const step of steps) {
    const raw = submissionsByStepId[step.id];
    const effective = await getEffectiveProof(step, run.staff_id);

    if (step.optional && raw?.skip) {
      results.push({ step, effective, answer: 'skipped', value: null, media_url: null, lat: null, lng: null, note: null });
      continue;
    }
    if (!raw?.input) {
      if (step.optional) {
        results.push({ step, effective, answer: 'skipped', value: null, media_url: null, lat: null, lng: null, note: null });
        continue;
      }
      errors[step.id] = 'This step is required.';
      continue;
    }
    try {
      const result = await validateProof({ proofType: effective.proof_type, proofConfig: effective.proof_config, input: raw.input, business });
      results.push({ step, effective, ...result });
    } catch (err) {
      if (err instanceof ReAskError) errors[step.id] = err.message;
      else throw err;
    }
  }

  if (Object.keys(errors).length > 0) return { errors };

  const staff = await getStaffById(run.staff_id);
  let blocked = false;
  for (const r of results) {
    await recordEntry({
      run,
      step: r.step,
      staffId: run.staff_id,
      answer: r.answer,
      value: r.value ?? null,
      media_url: r.media_url ?? null,
      lat: r.lat ?? null,
      lng: r.lng ?? null,
      note: r.note ?? null,
      applied_proof_type: r.effective.proof_type,
    });
    if (r.answer !== 'problem') continue;
    const cleanNote = r.note?.trim().replace(/\.+$/, '');
    const detail = `${business?.name || 'A business'}: ${staff?.name || 'A staff member'} reported a problem on "${r.step.instruction}"${cleanNote ? ` -- ${cleanNote}` : ''}.`;
    if (r.step.on_problem === 'block') {
      blocked = true;
      await dispatchAlert({ event: 'blocked', message: detail, context: alertContext(run, run.staff_id) });
    } else if (r.step.on_problem === 'alert') {
      await dispatchAlert({ event: 'problem', message: detail, context: alertContext(run, run.staff_id) });
    }
  }

  await pool.query(
    `update run set status = $1, completed_at = case when $1 = 'complete' then now() else null end, form_token = null where id = $2`,
    [blocked ? 'blocked' : 'complete', run.id]
  );
  return { blocked };
}
