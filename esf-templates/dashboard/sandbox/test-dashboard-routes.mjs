#!/usr/bin/env node
// Regression suite for the task/step builder (routes/tasks.js) and staff
// roster (routes/staff.js) JSON APIs -- what client/src/pages/{Staff,Tasks,
// TaskDetail}.jsx actually call. Runs the real routers behind a minimal
// test harness (fake session, in-process PGlite) so this exercises the
// real request handlers and real SQL, not a reimplementation. Run with:
//   ESF_TEST_PGLITE=1 node sandbox/test-dashboard-routes.mjs

import express from 'express';
import { pool } from '../lib/db.js';
import { router as staffRoutes } from '../routes/staff.js';
import { router as taskRoutes } from '../routes/tasks.js';
import { router as alertRoutes } from '../routes/alerts.js';

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok: ${name}`);
}

const PORT = 41998;
const BASE = `http://127.0.0.1:${PORT}`;

async function postJson(path, body) {
  return fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
}

async function main() {
  console.log('=== dashboard JSON API (staff + task/step builder) tests ===');
  await pool.query(`insert into business (name) values ('Grace Stores')`);

  const app = express();
  app.use(express.json());
  // Stands in for cookie-session + lib/auth.js's loadOwner -- every request
  // here is "logged in" as an owner with override rights, since auth
  // itself (bcrypt/session) is already covered by its own logic, not
  // re-tested here. requireOwner (used by both routers below) checks
  // req.owner directly, not req.session -- set that directly rather than
  // faking the session round-trip.
  app.use((req, res, next) => {
    req.owner = { id: 'test-owner', role: 'owner', can_override: true };
    next();
  });
  app.use('/staff', staffRoutes);
  app.use('/tasks', taskRoutes);
  app.use('/alert-routes', alertRoutes);
  const server = app.listen(PORT);

  try {
    let kemiId, ucheId, taskId, stepAId, stepBId;

    await check('POST /staff adds a staff member', async () => {
      const res = await postJson('/staff', { name: 'Kemi', phone: '2348060000001', role: 'stylist', shift_start: '09:00', shift_end: '18:00' });
      if (!res.ok) throw new Error(`expected 200, got ${res.status}`);
      const { rows } = await pool.query(`select id from staff where phone = '2348060000001'`);
      if (!rows[0]) throw new Error('staff row was not created');
      kemiId = rows[0].id;
    });

    await check('POST /staff rejects a duplicate phone number', async () => {
      const res = await postJson('/staff', { name: 'Someone Else', phone: '2348060000001', role: 'cashier' });
      const body = await res.json();
      if (res.status !== 400 || !/already registered/i.test(body.error)) throw new Error(`expected a 400 with a duplicate-phone message, got ${res.status}: ${JSON.stringify(body)}`);
      const { rows } = await pool.query(`select count(*)::int as n from staff where phone = '2348060000001'`);
      if (rows[0].n !== 1) throw new Error('a duplicate-phone insert should not have created a second row');
    });

    await check('a second staff member sharing the same role', async () => {
      await postJson('/staff', { name: 'Uche', phone: '2348060000002', role: 'stylist' });
      const { rows } = await pool.query(`select id from staff where phone = '2348060000002'`);
      ucheId = rows[0].id;
      if (!ucheId) throw new Error('second staff row was not created');
    });

    await check('GET /staff returns real JSON rows', async () => {
      const res = await fetch(`${BASE}/staff`);
      const list = await res.json();
      if (!Array.isArray(list) || list.length !== 2) throw new Error(`expected 2 staff, got ${JSON.stringify(list)}`);
    });

    await check('POST /tasks with assignTo=staff:<id> pins the task to one person, not the role', async () => {
      const res = await postJson('/tasks', {
        name: 'Client service', assignTo: `staff:${kemiId}`,
        days: ['MON', 'TUE', 'WED', 'THU', 'FRI'], available_from: '09:00', due_by: '19:00', mode: 'chat',
      });
      const body = await res.json();
      if (!res.ok) throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(body)}`);
      taskId = body.id;
      const { rows } = await pool.query(`select staff_id, role from task where id = $1`, [taskId]);
      if (rows[0].staff_id !== kemiId || rows[0].role !== null) throw new Error(`expected staff_id=${kemiId}, role=null, got ${JSON.stringify(rows[0])}`);
    });

    await check('the task detail JSON describes the assignment correctly ("Kemi only") and returns a re-selectable assignTo value', async () => {
      const { task } = await fetch(`${BASE}/tasks/${taskId}`).then((r) => r.json());
      if (task.assignment !== 'Kemi only') throw new Error(`expected "Kemi only", got "${task.assignment}"`);
      if (task.assignTo !== `staff:${kemiId}`) throw new Error(`expected assignTo="staff:${kemiId}", got "${task.assignTo}"`);
    });

    await check('PATCH /tasks/:id edits the task in place -- reassigning from Kemi-only to the whole role', async () => {
      const res = await fetch(`${BASE}/tasks/${taskId}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Client service', assignTo: 'role:stylist', days: ['MON', 'TUE'], available_from: '09:00', due_by: '19:00', mode: 'chat' }),
      });
      if (!res.ok) throw new Error(`expected 200, got ${res.status}`);
      const { rows } = await pool.query(`select staff_id, role, days from task where id = $1`, [taskId]);
      if (rows[0].staff_id !== null || rows[0].role !== 'stylist' || rows[0].days !== 'MON,TUE') {
        throw new Error(`expected reassigned to role:stylist and days MON,TUE, got ${JSON.stringify(rows[0])}`);
      }
    });

    await check('adding a "number" step with min/max produces real numeric proof_config, not strings', async () => {
      const res = await postJson(`/tasks/${taskId}/steps`, {
        instruction: 'Payment collected', proof_type: 'number', on_problem: 'alert',
        config: { label: 'Amount', min: '0', max: '500000' },
      });
      if (!res.ok) throw new Error(`expected 200, got ${res.status}`);
      const { rows } = await pool.query(`select id, proof_config from step where task_id = $1 and seq = 1`, [taskId]);
      stepAId = rows[0].id;
      const cfg = rows[0].proof_config;
      if (cfg.min !== 0 || cfg.max !== 500000 || cfg.label !== 'Amount') throw new Error(`unexpected proof_config: ${JSON.stringify(cfg)}`);
      if (typeof cfg.min !== 'number' || typeof cfg.max !== 'number') throw new Error(`min/max must be real numbers, not strings: ${JSON.stringify(cfg)}`);
    });

    await check('GET /tasks/:id returns rawConfig that round-trips the stored proof_config back into editable form fields', async () => {
      const { steps } = await fetch(`${BASE}/tasks/${taskId}`).then((r) => r.json());
      const step = steps.find((s) => s.id === stepAId);
      if (step.rawConfig.min !== '0' || step.rawConfig.max !== '500000' || step.rawConfig.label !== 'Amount') {
        throw new Error(`expected rawConfig to mirror the stored numbers as strings, got ${JSON.stringify(step.rawConfig)}`);
      }
    });

    await check('PATCH /tasks/:id/steps/:stepId edits a step in place -- changing proof type entirely, not just its config', async () => {
      const res = await fetch(`${BASE}/tasks/${taskId}/steps/${stepAId}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instruction: 'Confirm payment received', proof_type: 'tap', on_problem: 'continue', config: {} }),
      });
      if (!res.ok) throw new Error(`expected 200, got ${res.status}`);
      const { rows } = await pool.query(`select instruction, proof_type, proof_config, seq from step where id = $1`, [stepAId]);
      if (rows[0].instruction !== 'Confirm payment received' || rows[0].proof_type !== 'tap') {
        throw new Error(`unexpected step after edit: ${JSON.stringify(rows[0])}`);
      }
      if (Object.keys(rows[0].proof_config).length !== 0) throw new Error(`expected an empty proof_config for tap, got ${JSON.stringify(rows[0].proof_config)}`);
      if (rows[0].seq !== 1) throw new Error(`editing a step must not change its position (seq), got ${rows[0].seq}`);
    });

    await check('adding a "choice" step turns the textarea into a real options array', async () => {
      await postJson(`/tasks/${taskId}/steps`, {
        instruction: 'Was the client satisfied', proof_type: 'choice', on_problem: 'continue',
        config: { options: 'Very satisfied\nSatisfied\nNot satisfied' },
      });
      const { rows } = await pool.query(`select id, proof_config from step where task_id = $1 and seq = 2`, [taskId]);
      stepBId = rows[0].id;
      const cfg = rows[0].proof_config;
      if (!Array.isArray(cfg.options) || cfg.options.length !== 3 || cfg.options[1] !== 'Satisfied') {
        throw new Error(`expected a 3-item options array, got ${JSON.stringify(cfg)}`);
      }
    });

    await check('adding an "api" step turns the headers textarea into a real headers object', async () => {
      await postJson(`/tasks/${taskId}/steps`, {
        instruction: 'Payment reference', proof_type: 'api', on_problem: 'continue',
        config: {
          url: 'https://api.example.com/verify/{{value}}',
          headers: 'Authorization: Bearer {{secret.PAYSTACK_KEY}}\nAccept: application/json',
          success_path: 'status', success_value: 'success', on_fail: 'reject',
        },
      });
      const { rows } = await pool.query(`select proof_config from step where task_id = $1 and seq = 3`, [taskId]);
      const cfg = rows[0].proof_config;
      if (cfg.headers?.Authorization !== 'Bearer {{secret.PAYSTACK_KEY}}' || cfg.headers?.Accept !== 'application/json') {
        throw new Error(`unexpected headers object: ${JSON.stringify(cfg.headers)}`);
      }
      if (cfg.success_path !== 'status' || cfg.on_fail !== 'reject') throw new Error(`unexpected config: ${JSON.stringify(cfg)}`);
    });

    await check('"move down" on step 1 swaps it with step 2', async () => {
      await postJson(`/tasks/${taskId}/steps/${stepAId}/move`, { direction: 'down' });
      const { rows } = await pool.query(`select id, seq from step where task_id = $1 order by seq`, [taskId]);
      if (rows[0].id !== stepBId || rows[1].id !== stepAId) throw new Error(`expected steps swapped, got ${JSON.stringify(rows.map((r) => r.id))}`);
    });

    await check('deleting a step removes only that step', async () => {
      await fetch(`${BASE}/tasks/${taskId}/steps/${stepBId}`, { method: 'DELETE' });
      const { rows } = await pool.query(`select count(*)::int as n from step where task_id = $1`, [taskId]);
      if (rows[0].n !== 2) throw new Error(`expected 2 remaining steps, got ${rows[0].n}`);
    });

    await check('a task with a real run recorded against it cannot be deleted', async () => {
      await pool.query(`insert into run (task_id, staff_id, run_date, status) values ($1, $2, current_date, 'complete')`, [taskId, kemiId]);
      const res = await fetch(`${BASE}/tasks/${taskId}`, { method: 'DELETE' });
      const body = await res.json();
      if (res.status !== 400 || !/deactivate/i.test(body.error)) throw new Error(`expected a 400 telling them to deactivate instead, got ${res.status}: ${JSON.stringify(body)}`);
      const { rows } = await pool.query(`select count(*)::int as n from task where id = $1`, [taskId]);
      if (rows[0].n !== 1) throw new Error('task should still exist after a blocked delete');
    });

    await check('toggle-active flips the task, and back', async () => {
      await postJson(`/tasks/${taskId}/toggle-active`);
      let { rows } = await pool.query(`select active from task where id = $1`, [taskId]);
      if (rows[0].active !== false) throw new Error('expected task to be inactive after one toggle');
      await postJson(`/tasks/${taskId}/toggle-active`);
      ({ rows } = await pool.query(`select active from task where id = $1`, [taskId]));
      if (rows[0].active !== true) throw new Error('expected task to be active again after a second toggle');
    });

    await check('a task assigned to a whole role (not one person) targets everyone with that role', async () => {
      await postJson('/tasks', { name: 'Team huddle', assignTo: 'role:stylist', days: ['MON'], available_from: '08:00', due_by: '08:30', mode: 'chat' });
      const { rows } = await pool.query(`select staff_id, role from task where name = 'Team huddle'`);
      if (rows[0].staff_id !== null || rows[0].role !== 'stylist') throw new Error(`unexpected role assignment: ${JSON.stringify(rows[0])}`);
    });

    await check('GET /tasks lists every task with its assignment description', async () => {
      const list = await fetch(`${BASE}/tasks`).then((r) => r.json());
      const huddle = list.find((t) => t.name === 'Team huddle');
      if (!huddle || huddle.assignment !== 'Everyone with role: stylist') throw new Error(`unexpected list entry: ${JSON.stringify(huddle)}`);
    });

    let alertRouteId;
    await check('POST /alert-routes rejects an invalid event/channel', async () => {
      const res = await postJson('/alert-routes', { event: 'made_up_event', channel: 'whatsapp', target: '234...' });
      if (res.status !== 400) throw new Error(`expected a 400 for an invalid event, got ${res.status}`);
    });

    await check('POST /alert-routes creates a real alert_route row', async () => {
      const res = await postJson('/alert-routes', { event: 'blocked', channel: 'whatsapp', target: '2348000000000', quiet_hours: '22:00-07:00' });
      const body = await res.json();
      if (!res.ok) throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(body)}`);
      alertRouteId = body.id;
      const { rows } = await pool.query(`select event, channel, target, quiet_hours from alert_route where id = $1`, [alertRouteId]);
      if (rows[0].event !== 'blocked' || rows[0].target !== '2348000000000') throw new Error(`unexpected row: ${JSON.stringify(rows[0])}`);
    });

    await check('GET /alert-routes lists it', async () => {
      const list = await fetch(`${BASE}/alert-routes`).then((r) => r.json());
      if (!list.some((r) => r.id === alertRouteId)) throw new Error(`expected the created row in the list, got ${JSON.stringify(list)}`);
    });

    await check('DELETE /alert-routes/:id removes it', async () => {
      await fetch(`${BASE}/alert-routes/${alertRouteId}`, { method: 'DELETE' });
      const { rows } = await pool.query(`select count(*)::int as n from alert_route where id = $1`, [alertRouteId]);
      if (rows[0].n !== 0) throw new Error('expected the row to be gone after delete');
    });

    await check('step_override: POST without a reason is rejected (reason is shown to staff, never optional)', async () => {
      const res = await postJson(`/tasks/${taskId}/steps/${stepAId}/overrides`, { staff_id: kemiId, proof_type: 'tap', config: {} });
      if (res.status !== 400) throw new Error(`expected a 400 without a reason, got ${res.status}`);
    });

    await check('step_override: POST creates a real per-staff override', async () => {
      const res = await postJson(`/tasks/${taskId}/steps/${stepAId}/overrides`, {
        staff_id: kemiId, proof_type: 'tap', config: {}, reason: 'Camera is broken this week -- just confirm by text.',
      });
      if (!res.ok) throw new Error(`expected 200, got ${res.status}`);
      const { rows } = await pool.query(`select proof_type, reason from step_override where step_id = $1 and staff_id = $2`, [stepAId, kemiId]);
      if (rows[0].proof_type !== 'tap' || !/Camera is broken/.test(rows[0].reason)) throw new Error(`unexpected row: ${JSON.stringify(rows[0])}`);
    });

    await check('step_override: GET lists it with the staff name and a re-editable rawConfig', async () => {
      const list = await fetch(`${BASE}/tasks/${taskId}/steps/${stepAId}/overrides`).then((r) => r.json());
      if (list.length !== 1 || list[0].staff_name !== 'Kemi') throw new Error(`unexpected list: ${JSON.stringify(list)}`);
    });

    await check('step_override: posting again for the SAME staff+step updates it, rather than creating a duplicate', async () => {
      await postJson(`/tasks/${taskId}/steps/${stepAId}/overrides`, {
        staff_id: kemiId, proof_type: 'photo', config: { min: '1' }, reason: 'Actually just send a photo instead.',
      });
      const { rows } = await pool.query(`select count(*)::int as n from step_override where step_id = $1 and staff_id = $2`, [stepAId, kemiId]);
      if (rows[0].n !== 1) throw new Error(`expected exactly one override row (updated, not duplicated), got ${rows[0].n}`);
      const { rows: check2 } = await pool.query(`select proof_type from step_override where step_id = $1 and staff_id = $2`, [stepAId, kemiId]);
      if (check2[0].proof_type !== 'photo') throw new Error(`expected the update to have taken effect, got ${check2[0].proof_type}`);
    });

    await check('step_override: DELETE removes it', async () => {
      await fetch(`${BASE}/tasks/${taskId}/steps/${stepAId}/overrides/${kemiId}`, { method: 'DELETE' });
      const { rows } = await pool.query(`select count(*)::int as n from step_override where step_id = $1 and staff_id = $2`, [stepAId, kemiId]);
      if (rows[0].n !== 0) throw new Error('expected the override gone after delete');
    });

    let formTaskId;
    await check('a form-mode task cannot have a location step added to it', async () => {
      const created = await postJson('/tasks', { name: 'Form task', assignTo: '', days: ['MON'], available_from: '08:00', due_by: '09:00', mode: 'form' });
      formTaskId = (await created.json()).id;
      const res = await postJson(`/tasks/${formTaskId}/steps`, { instruction: 'Clock in', proof_type: 'location', on_problem: 'block', config: {} });
      const body = await res.json();
      if (res.status !== 400 || !/form-mode/.test(body.error)) throw new Error(`expected a 400 explaining why, got ${res.status}: ${JSON.stringify(body)}`);
      const { rows } = await pool.query(`select count(*)::int as n from step where task_id = $1`, [formTaskId]);
      if (rows[0].n !== 0) throw new Error('the rejected step must not have been created');
    });

    await check('...nor a photo step (v1 scope cut, same guard)', async () => {
      const res = await postJson(`/tasks/${formTaskId}/steps`, { instruction: 'Photo of shelf', proof_type: 'photo', on_problem: 'continue', config: {} });
      if (res.status !== 400) throw new Error(`expected a 400, got ${res.status}`);
    });

    await check('...but a compatible proof type (tap) is accepted on the same form-mode task', async () => {
      const res = await postJson(`/tasks/${formTaskId}/steps`, { instruction: 'Confirm', proof_type: 'tap', on_problem: 'continue', config: {} });
      if (!res.ok) throw new Error(`expected 200, got ${res.status}`);
    });

    await check('switching an existing CHAT task with a location step to form mode is rejected', async () => {
      const created = await postJson('/tasks', { name: 'Chat task with location', assignTo: '', days: ['MON'], available_from: '08:00', due_by: '09:00', mode: 'chat' });
      const chatTaskId = (await created.json()).id;
      await postJson(`/tasks/${chatTaskId}/steps`, { instruction: 'Clock in', proof_type: 'location', on_problem: 'block', config: {} });
      const res = await fetch(`${BASE}/tasks/${chatTaskId}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Chat task with location', assignTo: '', days: ['MON'], available_from: '08:00', due_by: '09:00', mode: 'form' }),
      });
      const body = await res.json();
      if (res.status !== 400 || !/location/.test(body.error)) throw new Error(`expected a 400 naming the location step, got ${res.status}: ${JSON.stringify(body)}`);
      const { rows } = await pool.query(`select mode from task where id = $1`, [chatTaskId]);
      if (rows[0].mode !== 'chat') throw new Error('mode must not have changed after a rejected switch');
    });
  } finally {
    server.close();
  }

  console.log(`\n${passed} checks passed.`);
  await pool.end();
}

main().catch((err) => {
  console.error('SANDBOX TEST FAILED:', err);
  process.exit(1);
});
