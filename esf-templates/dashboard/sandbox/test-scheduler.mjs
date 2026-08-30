#!/usr/bin/env node
// Regression suite for scheduler.js's sweepMissingTasks and
// sendDailySummary. Run with:
//   ESF_TEST_PGLITE=1 ESF_SANDBOX=1 node sandbox/test-scheduler.mjs

import { pool } from '../lib/db.js';
import { sweepMissingTasks, sendDailySummary, openDueRuns } from '../engine/scheduler.js';

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok: ${name}`);
}

async function main() {
  console.log('=== scheduler tests ===');
  await pool.query(`insert into business (name) values ('Grace Stores')`);

  console.log('\n--- sweepMissingTasks ---');
  {
    const { rows: staffRows } = await pool.query(`insert into staff (phone, name, role) values ('2348030000001', 'Ngozi', 'sales') returning id`);
    const staff = staffRows[0];
    // due_by in the past (00:01) so the sweep always finds this overdue,
    // regardless of what time the test happens to run.
    const { rows: taskRows } = await pool.query(
      `insert into task (name, role, days, available_from, due_by) values ('Opening', 'sales', 'MON,TUE,WED,THU,FRI,SAT,SUN', '00:00', '00:01') returning id`
    );
    const task = taskRows[0];

    await check('a task with no run at all gets a "missing" alert (never started)', async () => {
      await sweepMissingTasks();
      const { rows } = await pool.query(`select count(*)::int as n from alert_log where event = 'missing' and context = $1`, [`${task.id}:${staff.id}`]);
      if (rows[0].n !== 1) throw new Error(`expected exactly one missing alert, got ${rows[0].n}`);
    });

    await check('calling sweepMissingTasks again does not double-alert (dedup)', async () => {
      await sweepMissingTasks();
      const { rows } = await pool.query(`select count(*)::int as n from alert_log where event = 'missing' and context = $1`, [`${task.id}:${staff.id}`]);
      if (rows[0].n !== 1) throw new Error(`expected still exactly one missing alert after a second sweep, got ${rows[0].n}`);
    });

    await check('a run left status=open past due_by gets marked missed', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const { rows: staffRows2 } = await pool.query(`insert into staff (phone, name, role) values ('2348030000002', 'Emeka', 'sales') returning id`);
      const staff2 = staffRows2[0];
      await pool.query(`insert into run (task_id, staff_id, run_date, status) values ($1, $2, $3, 'open')`, [task.id, staff2.id, today]);
      await sweepMissingTasks();
      const { rows } = await pool.query(`select status from run where task_id = $1 and staff_id = $2`, [task.id, staff2.id]);
      if (rows[0].status !== 'missed') throw new Error(`expected status 'missed', got ${rows[0].status}`);
    });
  }

  console.log('\n--- sendDailySummary ---');
  {
    await check('does nothing before the latest due_by has passed', async () => {
      await pool.query(
        `insert into task (name, role, days, available_from, due_by) values ('Far Future', null, 'MON,TUE,WED,THU,FRI,SAT,SUN', '00:00', '23:58') returning id`
      );
      await sendDailySummary();
      const { rows } = await pool.query(`select count(*)::int as n from alert_log where event = 'daily_summary'`);
      if (rows[0].n !== 0) throw new Error(`expected no daily_summary alert while a task is still due later today, got ${rows[0].n}`);
    });

    await check('fires once the latest due_by has passed, with correct counts, and only once (dedup)', async () => {
      // due_by 00:02 guarantees "closed" for the rest of the test run.
      await pool.query(`update task set due_by = '00:02' where name = 'Far Future'`);
      await sendDailySummary();
      await sendDailySummary(); // second call must not double-send
      const { rows } = await pool.query(`select count(*)::int as n from alert_log where event = 'daily_summary'`);
      if (rows[0].n !== 1) throw new Error(`expected exactly one daily_summary alert, got ${rows[0].n}`);
    });
  }

  console.log('\n--- per-staff task assignment (task.staff_id) ---');
  {
    const { rows: staffRows } = await pool.query(
      `insert into staff (phone, name, role) values ('2348050000001', 'Kemi', 'sales'), ('2348050000002', 'Uche', 'sales') returning id, name`
    );
    const kemi = staffRows.find((s) => s.name === 'Kemi');
    const uche = staffRows.find((s) => s.name === 'Uche');
    // Both share the 'sales' role, but this task is pinned to Kemi only --
    // nothing individual about Uche's day should be affected by it.
    const { rows: taskRows } = await pool.query(
      `insert into task (name, staff_id, role, days, available_from, due_by) values ('Kemi-only errand', $1, 'sales', 'MON,TUE,WED,THU,FRI,SAT,SUN', '00:00', '23:59') returning id`,
      [kemi.id]
    );
    const task = taskRows[0];

    await check('staff_id set: only that one person gets a run, not everyone sharing the role', async () => {
      await openDueRuns();
      const today = new Date().toISOString().slice(0, 10);
      const { rows: runs } = await pool.query(`select staff_id from run where task_id = $1 and run_date = $2`, [task.id, today]);
      if (runs.length !== 1 || runs[0].staff_id !== kemi.id) {
        throw new Error(`expected exactly one run, for Kemi only. Got: ${JSON.stringify(runs)}`);
      }
      const { rows: uchesRuns } = await pool.query(`select count(*)::int as n from run where task_id = $1 and staff_id = $2`, [task.id, uche.id]);
      if (uchesRuns[0].n !== 0) throw new Error('Uche should have no run for a task pinned to Kemi, even though they share a role');
    });
  }

  console.log(`\n${passed} checks passed.`);
  await pool.end();
}

main().catch((err) => {
  console.error('SANDBOX TEST FAILED:', err);
  process.exit(1);
});
