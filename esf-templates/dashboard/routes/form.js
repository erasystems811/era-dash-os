// The public, no-login web form for a task.mode='form' run -- build schema
// v2.0 section 6: "she taps once to open it, fills every field, submits
// once." Scoped by run.form_token (an unguessable random string), not
// owner_user auth -- this is staff-facing, and staff never log in
// anywhere (build schema v2.0 section 3.2's own rule).
import express from 'express';
import { getRunByFormToken, getTaskById, getStepsForTask, getEffectiveProof, submitForm } from '../engine/run-engine.js';

export const router = express.Router();

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function page(title, body) {
  return `<html><head><title>${esc(title)}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 20px 16px 60px; background: #f2f3f7; color: #14161f; }
      h1 { font-size: 20px; margin-bottom: 4px; }
      .subtitle { color: #676c7c; font-size: 13px; margin-top: 0; }
      .field { background: #fff; border: 1px solid #dde0e8; border-radius: 6px; padding: 14px; margin-bottom: 12px; }
      .field label { display: block; font-weight: 600; margin-bottom: 8px; }
      .field input[type=text], .field input[type=number], .field textarea, .field select { width: 100%; box-sizing: border-box; font-size: 16px; padding: 8px; border: 1px solid #dde0e8; border-radius: 4px; }
      .field .error { color: #c8352a; font-size: 12.5px; margin-top: 6px; }
      .skip-row { margin-top: 8px; font-size: 13px; color: #676c7c; }
      button { width: 100%; font-size: 16px; font-weight: 600; padding: 12px; border-radius: 6px; border: none; background: #33308f; color: #fff; margin-top: 8px; }
      .empty { text-align: center; color: #676c7c; padding: 60px 20px; }
    </style>
    </head><body>${body}</body></html>`;
}

function fieldHtml(step, effective, errorMessage) {
  const cfg = effective.proof_config || {};
  const name = `step_${step.id}`;
  let inputHtml;
  switch (effective.proof_type) {
    case 'tap':
      inputHtml = `<label><input type="checkbox" name="${name}" value="done"> Done</label>`;
      break;
    case 'number':
      inputHtml = `<input type="number" name="${name}" ${cfg.min != null ? `min="${cfg.min}"` : ''} ${cfg.max != null ? `max="${cfg.max}"` : ''}>`;
      break;
    case 'text':
      inputHtml = `<textarea name="${name}" rows="3"></textarea>`;
      break;
    case 'choice':
      inputHtml = `<select name="${name}"><option value="">Choose...</option>${(cfg.options || []).map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select>`;
      break;
    case 'code':
    case 'api':
    case 'countersign':
      inputHtml = `<input type="text" name="${name}">`;
      break;
    default:
      // location/photo are excluded from form-mode tasks at the builder
      // (RUN_INCOMPATIBLE check in routes/tasks.js) -- this only shows if
      // that guard was somehow bypassed (a step edited into an existing
      // form-mode task some other way). Flagged, not silently broken.
      inputHtml = `<p class="error">This step (${esc(effective.proof_type)}) needs the chat, not this form -- reply to the bot directly for this one.</p>`;
  }
  const skipRow = step.optional
    ? `<div class="skip-row"><label><input type="checkbox" name="skip_${step.id}"> Skip (does not apply)</label></div>`
    : '';
  return `<div class="field">
    <label>${step.seq}. ${esc(step.instruction)}</label>
    ${inputHtml}
    ${skipRow}
    ${errorMessage ? `<div class="error">${esc(errorMessage)}</div>` : ''}
  </div>`;
}

async function renderForm(run, task, errors = {}) {
  const steps = await getStepsForTask(run.task_id);
  const fieldsHtml = await Promise.all(
    steps.map(async (step) => {
      const effective = await getEffectiveProof(step, run.staff_id);
      return fieldHtml(step, effective, errors[step.id]);
    })
  );
  return page(
    task.name,
    `<h1>${esc(task.name)}</h1>
     <p class="subtitle">Fill in every step below, then submit once.</p>
     <form method="post">
       ${fieldsHtml.join('')}
       <button type="submit">Submit</button>
     </form>`
  );
}

router.get('/:token', async (req, res) => {
  const run = await getRunByFormToken(req.params.token);
  if (!run || run.status !== 'open') {
    return res.send(page('Not available', `<div class="empty">This form is no longer available -- it may already have been submitted.</div>`));
  }
  const task = await getTaskById(run.task_id);
  res.send(await renderForm(run, task));
});

router.post('/:token', async (req, res) => {
  const run = await getRunByFormToken(req.params.token);
  if (!run || run.status !== 'open') {
    return res.send(page('Not available', `<div class="empty">This form is no longer available -- it may already have been submitted.</div>`));
  }
  const task = await getTaskById(run.task_id);
  const steps = await getStepsForTask(run.task_id);

  const submissions = {};
  for (const step of steps) {
    const skip = Boolean(req.body[`skip_${step.id}`]);
    const raw = req.body[`step_${step.id}`];
    if (skip) {
      submissions[step.id] = { skip: true };
      continue;
    }
    if (raw === undefined || raw === '') continue; // left blank -- required-ness is checked server-side
    submissions[step.id] = { input: { type: 'text', text: String(raw) } };
  }

  const result = await submitForm(run, submissions);
  if (result.errors) {
    return res.send(await renderForm(run, task, result.errors));
  }
  res.send(
    page(
      'Submitted',
      `<div class="empty">${result.blocked ? 'Submitted. One or more items need a manager before this can close out -- they have been told.' : 'Submitted. Thank you.'}</div>`
    )
  );
});
