// Task + step builder -- JSON API consumed by client/src/pages/Tasks.jsx
// and TaskDetail.jsx (the "almost like a Google Form" screen: create a
// task, assign it to one person or a whole role, then add steps one at a
// time, each with its own proof_type -- the "question type" -- and
// whatever config that type needs -- the "answer format"). Nothing here
// is fixed -- a business designs its own tasks/steps, this screen is the
// only thing every business shares (build schema v2.0's whole premise).
import express from 'express';
import { pool } from '../lib/db.js';
import { requireOwner } from '../lib/auth.js';
import { FORM_INCOMPATIBLE_PROOF_TYPES } from '../engine/run-engine.js';

export const router = express.Router();
router.use(requireOwner);

const PROOF_TYPES = ['tap', 'photo', 'location', 'number', 'text', 'choice', 'code', 'api', 'countersign'];

function parseAssignTo(raw) {
  if (!raw) return { role: null, staff_id: null };
  if (raw.startsWith('role:')) return { role: raw.slice('role:'.length), staff_id: null };
  if (raw.startsWith('staff:')) return { role: null, staff_id: raw.slice('staff:'.length) };
  return { role: null, staff_id: null };
}

async function describeAssignment(task) {
  if (task.staff_id) {
    const { rows } = await pool.query(`select name from staff where id = $1`, [task.staff_id]);
    return `${rows[0]?.name || '(deleted staff member)'} only`;
  }
  if (task.role) return `Everyone with role: ${task.role}`;
  return 'Everyone';
}

router.get('/', async (req, res) => {
  const { rows: tasks } = await pool.query(`select * from task order by seq, name`);
  const out = await Promise.all(
    tasks.map(async (t) => ({
      id: t.id,
      name: t.name,
      assignment: await describeAssignment(t),
      days: t.days,
      available_from: t.available_from,
      due_by: t.due_by,
      mode: t.mode,
      active: t.active,
    }))
  );
  res.json(out);
});

router.post('/', async (req, res) => {
  const { name, assignTo, available_from, due_by, mode } = req.body;
  const days = [].concat(req.body.days || []).join(',');
  if (!name || !days || !available_from || !due_by) {
    return res.status(400).json({ error: 'Name, at least one day, available-from and due-by are all required.' });
  }
  const { role, staff_id } = parseAssignTo(assignTo);
  const { rows: seqRows } = await pool.query(`select coalesce(max(seq), 0) + 1 as next from task`);
  const { rows } = await pool.query(
    `insert into task (name, staff_id, role, seq, days, available_from, due_by, mode) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [name.trim(), staff_id, role, seqRows[0].next, days, available_from, due_by, mode === 'form' ? 'form' : 'chat']
  );
  res.json({ id: rows[0].id });
});

// The select value (e.g. "staff:<id>", "role:sales", "") that would
// re-select this task's current assignment, alongside the human-readable
// `assignment` string -- an edit form needs the raw value to pre-select
// the right option, describeAssignment()'s output isn't parseable back.
function assignToValue(task) {
  if (task.staff_id) return `staff:${task.staff_id}`;
  if (task.role) return `role:${task.role}`;
  return '';
}

router.get('/:id', async (req, res) => {
  const { rows: taskRows } = await pool.query(`select * from task where id = $1`, [req.params.id]);
  const task = taskRows[0];
  if (!task) return res.status(404).json({ error: 'Not found.' });
  const { rows: stepRows } = await pool.query(`select * from step where task_id = $1 order by seq`, [task.id]);
  const steps = stepRows.map((s) => ({ ...s, rawConfig: configToRawFields(s.proof_type, s.proof_config) }));
  res.json({
    task: {
      id: task.id,
      name: task.name,
      assignment: await describeAssignment(task),
      assignTo: assignToValue(task),
      days: task.days,
      available_from: task.available_from,
      due_by: task.due_by,
      mode: task.mode,
      active: task.active,
    },
    steps,
  });
});

router.patch('/:id', async (req, res) => {
  const { name, assignTo, available_from, due_by, mode } = req.body;
  const days = [].concat(req.body.days || []).join(',');
  if (!name || !days || !available_from || !due_by) {
    return res.status(400).json({ error: 'Name, at least one day, available-from and due-by are all required.' });
  }
  const { role, staff_id } = parseAssignTo(assignTo);
  const modeValue = mode === 'form' ? 'form' : 'chat';
  if (modeValue === 'form') {
    const { rows: incompatible } = await pool.query(
      `select instruction, proof_type from step where task_id = $1 and proof_type = any($2::text[]) order by seq`,
      [req.params.id, FORM_INCOMPATIBLE_PROOF_TYPES]
    );
    if (incompatible.length > 0) {
      const list = incompatible.map((s) => `"${s.instruction}" (${s.proof_type})`).join(', ');
      return res.status(400).json({ error: `Can't switch to form mode -- these steps need a live camera/GPS check and won't work in a form: ${list}. Change or remove them first.` });
    }
  }
  await pool.query(
    `update task set name = $1, staff_id = $2, role = $3, days = $4, available_from = $5, due_by = $6, mode = $7 where id = $8`,
    [name.trim(), staff_id, role, days, available_from, due_by, modeValue, req.params.id]
  );
  res.json({ ok: true });
});

router.post('/:id/toggle-active', async (req, res) => {
  await pool.query(`update task set active = not active where id = $1`, [req.params.id]);
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  const { rows: runCount } = await pool.query(`select count(*)::int as n from run where task_id = $1`, [req.params.id]);
  if (runCount[0].n > 0) {
    return res.status(400).json({ error: 'This task already has real runs recorded against it -- deleting it would destroy that history. Deactivate it instead.' });
  }
  await pool.query(`delete from task where id = $1`, [req.params.id]);
  res.json({ ok: true });
});

// --- Step builder ---

const PROOF_CONFIG_FIELDS = {
  tap: [],
  photo: [
    { name: 'min', label: 'Minimum photos', type: 'number', default: 1 },
    { name: 'max', label: 'Maximum photos', type: 'number' },
  ],
  location: [{ name: 'radius_m', label: 'Radius (meters)', type: 'number' }],
  number: [
    { name: 'label', label: 'What is this a count of', type: 'text' },
    { name: 'min', label: 'Minimum value', type: 'number' },
    { name: 'max', label: 'Maximum value', type: 'number' },
  ],
  text: [{ name: 'min_length', label: 'Minimum length', type: 'number', default: 1 }],
  choice: [{ name: 'options', label: 'Options, one per line', type: 'textarea' }],
  code: [{ name: 'source', label: 'Who holds the code', type: 'text' }],
  api: [
    { name: 'url', label: 'Verification URL', type: 'text' },
    { name: 'method', label: 'Method', type: 'select' },
    { name: 'headers', label: 'Headers, one per line', type: 'textarea' },
    { name: 'success_path', label: 'Success field', type: 'text' },
    { name: 'success_value', label: 'Success value', type: 'text' },
    { name: 'on_fail', label: 'On fail', type: 'select' },
  ],
  countersign: [{ name: 'role', label: 'Which role must confirm', type: 'text' }],
};

// Turns { proof_type, config: { <raw field name>: <raw string value> } }
// (as sent by TaskDetail.jsx's dynamic form) into the real proof_config
// JSON stored on the step -- numbers become real numbers, the options/
// headers textareas become a real array/object, and anything blank is
// dropped rather than stored as an empty string.
function buildProofConfig(proofType, rawConfig = {}) {
  const fields = PROOF_CONFIG_FIELDS[proofType] || [];
  const config = {};
  for (const f of fields) {
    const raw = rawConfig[f.name];
    if (raw === undefined || raw === null || raw === '') continue;
    if (f.name === 'options') config.options = String(raw).split('\n').map((s) => s.trim()).filter(Boolean);
    else if (f.name === 'headers') {
      const headers = {};
      for (const line of String(raw).split('\n')) {
        const i = line.indexOf(':');
        if (i === -1) continue;
        headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      config.headers = headers;
    } else if (f.type === 'number') config[f.name] = Number(raw);
    else config[f.name] = raw;
  }
  return config;
}

// The reverse of buildProofConfig -- turns a stored proof_config JSON back
// into the raw string values the edit form's fields need (options array ->
// newline-joined text, headers object -> "Name: value" lines, numbers ->
// strings for a controlled input's value). Lives here, not the client, so
// there's one source of truth for the field shape on both sides of an edit.
function configToRawFields(proofType, config = {}) {
  const fields = PROOF_CONFIG_FIELDS[proofType] || [];
  const raw = {};
  for (const f of fields) {
    if (f.name === 'options') raw.options = (config.options || []).join('\n');
    else if (f.name === 'headers') raw.headers = Object.entries(config.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
    else if (config[f.name] !== undefined) raw[f.name] = String(config[f.name]);
  }
  return raw;
}

// A form-mode task can't hold a location/photo step (build schema v2.0
// section 6's own stated limit, plus photo as an explicit v1 scope cut --
// see run-engine.js's FORM_INCOMPATIBLE_PROOF_TYPES). Checked here, at the
// one place a step actually gets its proof_type set, rather than
// discovered later when someone tries to fill out the form.
async function assertFormCompatible(taskId, proofType) {
  if (!FORM_INCOMPATIBLE_PROOF_TYPES.includes(proofType)) return null;
  const { rows } = await pool.query(`select mode from task where id = $1`, [taskId]);
  if (rows[0]?.mode !== 'form') return null;
  return `"${proofType}" needs a live camera/GPS check and can't go in a form-mode task -- switch this task to chat mode, or use a different proof type for this step.`;
}

router.post('/:id/steps', async (req, res) => {
  const { instruction, proof_type, on_problem, clock_action, config } = req.body;
  if (!instruction || !PROOF_TYPES.includes(proof_type)) {
    return res.status(400).json({ error: 'Instruction and a valid proof type are required.' });
  }
  const formError = await assertFormCompatible(req.params.id, proof_type);
  if (formError) return res.status(400).json({ error: formError });
  const proofConfig = buildProofConfig(proof_type, config);
  const { rows: seqRows } = await pool.query(`select coalesce(max(seq), 0) + 1 as next from step where task_id = $1`, [req.params.id]);
  const { rows } = await pool.query(
    `insert into step (task_id, seq, instruction, proof_type, proof_config, on_problem, optional, clock_action)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [req.params.id, seqRows[0].next, instruction.trim(), proof_type, JSON.stringify(proofConfig), on_problem || 'continue', Boolean(req.body.optional), clock_action || 'none']
  );
  res.json({ id: rows[0].id });
});

router.patch('/:id/steps/:stepId', async (req, res) => {
  const { instruction, proof_type, on_problem, clock_action, config } = req.body;
  if (!instruction || !PROOF_TYPES.includes(proof_type)) {
    return res.status(400).json({ error: 'Instruction and a valid proof type are required.' });
  }
  const formError = await assertFormCompatible(req.params.id, proof_type);
  if (formError) return res.status(400).json({ error: formError });
  const proofConfig = buildProofConfig(proof_type, config);
  await pool.query(
    `update step set instruction = $1, proof_type = $2, proof_config = $3, on_problem = $4, optional = $5, clock_action = $6
     where id = $7 and task_id = $8`,
    [instruction.trim(), proof_type, JSON.stringify(proofConfig), on_problem || 'continue', Boolean(req.body.optional), clock_action || 'none', req.params.stepId, req.params.id]
  );
  res.json({ ok: true });
});

router.delete('/:id/steps/:stepId', async (req, res) => {
  await pool.query(`delete from step where id = $1 and task_id = $2`, [req.params.stepId, req.params.id]);
  res.json({ ok: true });
});

// Reordering swaps this step's seq with its neighbour's -- simple and
// correct as long as seq values within a task are always a contiguous,
// unique sequence (true here: steps are only ever appended at max+1 and
// deleted outright, never given an arbitrary seq).
router.post('/:id/steps/:stepId/move', async (req, res) => {
  const { rows: steps } = await pool.query(`select id, seq from step where task_id = $1 order by seq`, [req.params.id]);
  const idx = steps.findIndex((s) => s.id === req.params.stepId);
  const swapWith = req.body.direction === 'up' ? idx - 1 : idx + 1;
  if (idx === -1 || swapWith < 0 || swapWith >= steps.length) return res.json({ ok: true });
  const a = steps[idx];
  const b = steps[swapWith];
  await pool.query(`update step set seq = $1 where id = $2`, [b.seq, a.id]);
  await pool.query(`update step set seq = $1 where id = $2`, [a.seq, b.id]);
  res.json({ ok: true });
});

// --- step_override: proof set per PERSON, not per business (build schema
// v2.0 section 3.7). The reason is always required here -- it's shown to
// the staff member (run-engine.js's promptFor), so a route that let you
// skip it would be creating exactly the "silent per-person rule" the whole
// table exists to avoid.

router.get('/:id/steps/:stepId/overrides', async (req, res) => {
  const { rows } = await pool.query(
    `select step_override.staff_id, step_override.proof_type, step_override.proof_config, step_override.reason, step_override.expires_on, staff.name as staff_name
     from step_override join staff on staff.id = step_override.staff_id
     where step_override.step_id = $1
     order by staff.name`,
    [req.params.stepId]
  );
  res.json(rows.map((r) => ({ ...r, rawConfig: configToRawFields(r.proof_type, r.proof_config) })));
});

router.post('/:id/steps/:stepId/overrides', async (req, res) => {
  const { staff_id, proof_type, config, reason, expires_on } = req.body;
  if (!staff_id || !PROOF_TYPES.includes(proof_type)) return res.status(400).json({ error: 'A staff member and a valid proof type are required.' });
  if (!reason?.trim()) return res.status(400).json({ error: 'A reason is required -- this is shown to the staff member, never a silent rule.' });
  const proofConfig = buildProofConfig(proof_type, config);
  await pool.query(
    `insert into step_override (step_id, staff_id, proof_type, proof_config, reason, expires_on)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (step_id, staff_id) do update set proof_type = excluded.proof_type, proof_config = excluded.proof_config, reason = excluded.reason, expires_on = excluded.expires_on`,
    [req.params.stepId, staff_id, proof_type, JSON.stringify(proofConfig), reason.trim(), expires_on || null]
  );
  res.json({ ok: true });
});

router.delete('/:id/steps/:stepId/overrides/:staffId', async (req, res) => {
  await pool.query(`delete from step_override where step_id = $1 and staff_id = $2`, [req.params.stepId, req.params.staffId]);
  res.json({ ok: true });
});
