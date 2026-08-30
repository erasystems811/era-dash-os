#!/usr/bin/env node
// Regression suite for engine/sheet-sync.js's query + format layer -- the
// part that's actually testable without a real Google service account
// (see google-auth.test.mjs for why syncBusinessSheet's own Google calls
// aren't covered here). Run with:
//   ESF_TEST_PGLITE=1 node sandbox/test-sheet-sync.mjs

import { pool } from '../lib/db.js';
import { queryTodayRows, queryAttendanceRows, queryHistoryRows, formatTodayRows, formatAttendanceRows, formatHistoryRows } from '../engine/sheet-sync.js';

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok: ${name}`);
}

async function main() {
  console.log('=== sheet-sync query + format tests ===');

  const { rows: staffRows } = await pool.query(
    `insert into staff (phone, name, role, shift_start) values ('2348020000001', 'Blessing', 'sales', '08:00:00') returning id`
  );
  const staffId = staffRows[0].id;

  const { rows: taskRows } = await pool.query(
    `insert into task (name, role, days, available_from, due_by) values ('Opening', 'sales', 'MON,TUE,WED,THU,FRI,SAT,SUN', '00:00', '23:59') returning id`
  );
  const taskId = taskRows[0].id;

  const { rows: stepInRows } = await pool.query(
    `insert into step (task_id, seq, instruction, proof_type, clock_action) values ($1, 1, 'Clock in', 'location', 'in') returning id`,
    [taskId]
  );
  const { rows: stepOutRows } = await pool.query(
    `insert into step (task_id, seq, instruction, proof_type, clock_action) values ($1, 2, 'Clock out', 'location', 'out') returning id`,
    [taskId]
  );

  const today = new Date().toISOString().slice(0, 10);
  const { rows: runRows } = await pool.query(
    `insert into run (task_id, staff_id, run_date, current_seq, status, started_at) values ($1, $2, $3, 2, 'complete', now()) returning id`,
    [taskId, staffId, today]
  );
  const runId = runRows[0].id;

  // Clock-in at 09:15 (shift_start is 08:00) -- deliberately late, so the
  // "late" derivation in queryAttendanceRows has something real to catch.
  const clockInAt = new Date();
  clockInAt.setHours(9, 15, 0, 0);
  await pool.query(
    `insert into entry (run_id, step_id, staff_id, answer, lat, lng, applied_proof_type, created_at) values ($1, $2, $3, 'done', 1, 1, 'location', $4)`,
    [runId, stepInRows[0].id, staffId, clockInAt.toISOString()]
  );
  await pool.query(
    `insert into entry (run_id, step_id, staff_id, answer, lat, lng, applied_proof_type) values ($1, $2, $3, 'done', 1, 1, 'location')`,
    [runId, stepOutRows[0].id, staffId]
  );

  await check('queryTodayRows returns the run with the right task/staff/status', async () => {
    const rows = await queryTodayRows();
    if (rows.length !== 1) throw new Error(`expected 1 row, got ${rows.length}`);
    if (rows[0].task_name !== 'Opening' || rows[0].staff_name !== 'Blessing' || rows[0].status !== 'complete') {
      throw new Error(`unexpected row: ${JSON.stringify(rows[0])}`);
    }
  });

  await check('formatTodayRows puts the generated-warning on row 1 and the header on row 2', async () => {
    const formatted = formatTodayRows(await queryTodayRows());
    if (formatted[0][0] !== 'Generated automatically -- edits here are not saved.') throw new Error(`row 1 wrong: ${JSON.stringify(formatted[0])}`);
    if (formatted[1].join(',') !== 'Task,Staff,Status,Current step,Started at') throw new Error(`row 2 (header) wrong: ${JSON.stringify(formatted[1])}`);
    if (formatted[2][0] !== 'Opening' || formatted[2][1] !== 'Blessing') throw new Error(`data row wrong: ${JSON.stringify(formatted[2])}`);
  });

  await check('queryAttendanceRows finds the clock-in/out pair and correctly marks it late (09:15 > shift_start 08:00)', async () => {
    const rows = await queryAttendanceRows({ days: 30 });
    if (rows.length !== 1) throw new Error(`expected 1 attendance row, got ${rows.length}`);
    if (!rows[0].clock_in_at || !rows[0].clock_out_at) throw new Error(`expected both clock_in_at and clock_out_at set: ${JSON.stringify(rows[0])}`);
    if (rows[0].late !== true) throw new Error(`expected late=true for a 09:15 clock-in against an 08:00 shift, got ${rows[0].late}`);
  });

  await check('formatAttendanceRows renders "Yes" for a late row', async () => {
    const formatted = formatAttendanceRows(await queryAttendanceRows({ days: 30 }));
    const dataRow = formatted[2];
    if (dataRow[4] !== 'Yes') throw new Error(`expected the Late column to say "Yes", got ${JSON.stringify(dataRow)}`);
  });

  await check('queryHistoryRows / formatHistoryRows include this run within the 90-day window', async () => {
    const rows = await queryHistoryRows({ days: 90 });
    if (rows.length !== 1) throw new Error(`expected 1 history row, got ${rows.length}`);
    const formatted = formatHistoryRows(rows);
    if (formatted[2].join(',') !== `${today},Opening,Blessing,complete`) throw new Error(`unexpected formatted history row: ${JSON.stringify(formatted[2])}`);
  });

  await check('queryHistoryRows excludes a run older than the window', async () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 100);
    await pool.query(`insert into run (task_id, staff_id, run_date, status) values ($1, $2, $3, 'complete')`, [taskId, staffId, oldDate.toISOString().slice(0, 10)]);
    const rows = await queryHistoryRows({ days: 90 });
    if (rows.length !== 1) throw new Error(`expected the 100-day-old run to be excluded from a 90-day window, got ${rows.length} rows`);
  });

  console.log(`\n${passed} checks passed.`);
  await pool.end();
}

main().catch((err) => {
  console.error('SANDBOX TEST FAILED:', err);
  process.exit(1);
});
