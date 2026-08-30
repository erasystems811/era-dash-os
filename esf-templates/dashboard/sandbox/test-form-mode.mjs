#!/usr/bin/env node
// Regression suite for form delivery mode (build schema v2.0 section 6) --
// both the engine layer (run-engine.js's openFormRun/submitForm) and the
// public HTTP layer (routes/form.js), run against the real routers/
// functions with in-process PGlite. Run with:
//   ESF_TEST_PGLITE=1 ESF_SANDBOX=1 node sandbox/test-form-mode.mjs

import express from 'express';
import { pool } from '../lib/db.js';
import { openRunAndPrompt, getRunByFormToken } from '../engine/run-engine.js';
import { router as formRoutes } from '../routes/form.js';

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok: ${name}`);
}

async function seedStaff(phone, name, role) {
  const { rows } = await pool.query(`insert into staff (phone, name, role) values ($1, $2, $3) returning *`, [phone, name, role]);
  return rows[0];
}

async function seedTask(name, role, mode = 'form') {
  const { rows } = await pool.query(
    `insert into task (name, role, days, available_from, due_by, mode) values ($1, $2, 'MON,TUE,WED,THU,FRI,SAT,SUN', '00:00', '23:59', $3) returning *`,
    [name, role, mode]
  );
  return rows[0];
}

async function seedStep(taskId, { seq, instruction, proofType, proofConfig = {}, onProblem = 'continue', optional = false }) {
  const { rows } = await pool.query(
    `insert into step (task_id, seq, instruction, proof_type, proof_config, on_problem, optional) values ($1, $2, $3, $4, $5, $6, $7) returning *`,
    [taskId, seq, instruction, proofType, JSON.stringify(proofConfig), onProblem, optional]
  );
  return rows[0];
}

const PORT = 41997;
const BASE = `http://127.0.0.1:${PORT}`;

async function main() {
  console.log('=== form mode tests ===');
  await pool.query(`insert into business (name) values ('Grace Stores')`);

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use('/form', formRoutes);
  const server = app.listen(PORT);

  try {
    console.log('\n--- opening a form-mode run sends a link, not step-by-step chat ---');
    {
      const staff = await seedStaff('2348070000001', 'Ngozi', 'cashier');
      const task = await seedTask('Cash-up', 'cashier');
      await seedStep(task.id, { seq: 1, instruction: 'Till count', proofType: 'number', onProblem: 'alert' });
      await seedStep(task.id, { seq: 2, instruction: 'Any items on credit', proofType: 'choice', proofConfig: { options: ['Yes', 'No'] }, onProblem: 'continue' });

      await check('openRunAndPrompt sets a form_token and sends exactly one link message', async () => {
        const run = await openRunAndPrompt(task, staff);
        if (!run.form_token) throw new Error('expected form_token to be set');
        const { rows } = await pool.query(`select form_token from run where task_id = $1 and staff_id = $2`, [task.id, staff.id]);
        if (rows[0].form_token !== run.form_token) throw new Error('form_token not persisted');
      });

      let token;
      await check('GET /form/:token renders both steps as real fields', async () => {
        const { rows } = await pool.query(`select form_token from run where task_id = $1 and staff_id = $2`, [task.id, staff.id]);
        token = rows[0].form_token;
        const html = await fetch(`${BASE}/form/${token}`).then((r) => r.text());
        if (!/Till count/.test(html) || !/Any items on credit/.test(html)) throw new Error('expected both step instructions on the page');
        if (!/<select name="step_/.test(html)) throw new Error('expected the choice step to render as a real <select>');
      });

      await check('GET /form/:bad-token shows "not available" instead of erroring', async () => {
        const html = await fetch(`${BASE}/form/not-a-real-token`).then((r) => r.text());
        if (!/no longer available/i.test(html)) throw new Error(`expected a graceful "not available" page, got: ${html.slice(0, 200)}`);
      });

      await check('POST with a required field missing re-shows the form with an error, records NOTHING (all-or-nothing)', async () => {
        const { rows: stepRows } = await pool.query(`select id from step where task_id = $1 order by seq`, [task.id]);
        const res = await fetch(`${BASE}/form/${token}`, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ [`step_${stepRows[1].id}`]: 'No' }), // step 1 (number) left blank
        });
        const html = await res.text();
        if (!/required/i.test(html)) throw new Error(`expected a "required" error, got: ${html.slice(0, 300)}`);
        const { rows: entryCount } = await pool.query(`select count(*)::int as n from entry`);
        if (entryCount[0].n !== 0) throw new Error(`expected zero entries after a rejected submission, got ${entryCount[0].n}`);
      });

      await check('a full, valid submission records both entries and completes the run', async () => {
        const { rows: stepRows } = await pool.query(`select id from step where task_id = $1 order by seq`, [task.id]);
        const res = await fetch(`${BASE}/form/${token}`, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ [`step_${stepRows[0].id}`]: '45000', [`step_${stepRows[1].id}`]: 'No' }),
        });
        const html = await res.text();
        if (!/Submitted/.test(html)) throw new Error(`expected a submitted confirmation, got: ${html.slice(0, 200)}`);
        const { rows } = await pool.query(`select status, form_token from run where task_id = $1 and staff_id = $2`, [task.id, staff.id]);
        if (rows[0].status !== 'complete') throw new Error(`expected run status complete, got ${rows[0].status}`);
        if (rows[0].form_token !== null) throw new Error('expected form_token cleared after a completed submission');
      });

      await check('the token is single-use -- the same link now shows "not available"', async () => {
        const html = await fetch(`${BASE}/form/${token}`).then((r) => r.text());
        if (!/no longer available/i.test(html)) throw new Error('expected the token to be dead after submission');
      });
    }

    console.log('\n--- on_problem is evaluated AFTER the whole submission, not mid-fill ---');
    {
      const staff = await seedStaff('2348070000002', 'Tunde', 'sales');
      const task = await seedTask('Closing', 'sales');
      // api/on_fail=flag is the one proof type that produces a real
      // structural "problem" answer without throwing a hard validation
      // error -- an unreachable URL fails the fetch, which callApiProof
      // treats the same as a non-matching response (proof-types.js).
      await seedStep(task.id, {
        seq: 1, instruction: 'Payment reference', proofType: 'api', onProblem: 'block',
        proofConfig: { url: 'http://127.0.0.1:9/verify/{{value}}', success_path: 'status', success_value: 'success', on_fail: 'flag' },
      });
      await seedStep(task.id, { seq: 2, instruction: 'Shelf tidy', proofType: 'tap', onProblem: 'continue' });
      const run = await openRunAndPrompt(task, staff);

      await check('a structural "problem" (unverified api reference, on_problem=block) still lets step 2 get recorded, THEN the run ends up blocked', async () => {
        const { rows: stepRows } = await pool.query(`select id from step where task_id = $1 order by seq`, [task.id]);
        const res = await fetch(`${BASE}/form/${run.form_token}`, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ [`step_${stepRows[0].id}`]: 'REF-123', [`step_${stepRows[1].id}`]: 'done' }),
        });
        const html = await res.text();
        if (!/manager/i.test(html)) throw new Error(`expected the blocked-confirmation message, got: ${html.slice(0, 200)}`);

        const { rows: entries } = await pool.query(
          `select step_id, answer from entry where run_id = (select id from run where task_id = $1 and staff_id = $2) order by (select seq from step where step.id = entry.step_id)`,
          [task.id, staff.id]
        );
        if (entries.length !== 2) throw new Error(`expected both steps recorded (block doesn't stop the rest of the form from being saved), got ${entries.length}`);
        if (entries[0].answer !== 'problem' || entries[1].answer !== 'done') throw new Error(`unexpected answers: ${JSON.stringify(entries)}`);

        const { rows } = await pool.query(`select status from run where task_id = $1 and staff_id = $2`, [task.id, staff.id]);
        if (rows[0].status !== 'blocked') throw new Error(`expected run status blocked, got ${rows[0].status}`);

        const { rows: alerts } = await pool.query(`select count(*)::int as n from alert_log where event = 'blocked'`);
        if (alerts[0].n !== 1) throw new Error(`expected exactly one blocked alert logged, got ${alerts[0].n}`);
      });
    }

    console.log('\n--- optional steps can be skipped ---');
    {
      const staff = await seedStaff('2348070000003', 'Ada', 'stylist');
      const task = await seedTask('Prep', 'stylist');
      await seedStep(task.id, { seq: 1, instruction: 'Extra notes', proofType: 'text', proofConfig: { min_length: 3 }, optional: true });
      const run = await openRunAndPrompt(task, staff);

      await check('checking the skip box completes the run without needing the field filled', async () => {
        const { rows: stepRows } = await pool.query(`select id from step where task_id = $1`, [task.id]);
        const res = await fetch(`${BASE}/form/${run.form_token}`, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ [`skip_${stepRows[0].id}`]: 'on' }),
        });
        const html = await res.text();
        if (!/Submitted/.test(html)) throw new Error(`expected a submitted confirmation, got: ${html.slice(0, 200)}`);
        const { rows } = await pool.query(`select answer from entry where run_id = (select id from run where task_id = $1 and staff_id = $2)`, [task.id, staff.id]);
        if (rows[0].answer !== 'skipped') throw new Error(`expected answer='skipped', got ${JSON.stringify(rows[0])}`);
      });
    }
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
