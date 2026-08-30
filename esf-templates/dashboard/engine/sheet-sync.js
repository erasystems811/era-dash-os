// Builds the three read-only tabs (build schema v2.0 section 9: today,
// attendance, history) and pushes them to this business's own Google Sheet
// on a schedule. Query + pure-format are kept separate on purpose: the
// format functions take plain row arrays and are unit-tested directly
// (sandbox/test-sheet-sync.mjs) with no database or Google API involved --
// only queryTodayRows/queryAttendanceRows/queryHistoryRows and the actual
// Google calls in syncBusinessSheet need a real Postgres/Sheets connection.

import { pool } from '../lib/db.js';
import { getAccessToken } from '../lib/google-auth.js';
import { writeTab } from '../lib/google-sheets.js';

const GENERATED_WARNING = ['Generated automatically -- edits here are not saved.'];

export function formatTodayRows(rows) {
  const header = ['Task', 'Staff', 'Status', 'Current step', 'Started at'];
  const body = rows.map((r) => [r.task_name, r.staff_name, r.status, String(r.current_seq), r.started_at ? new Date(r.started_at).toISOString() : '']);
  return [GENERATED_WARNING, header, ...body];
}

export function formatAttendanceRows(rows) {
  const header = ['Date', 'Staff', 'Clocked in', 'Clocked out', 'Late'];
  const body = rows.map((r) => [
    r.run_date,
    r.staff_name,
    r.clock_in_at ? new Date(r.clock_in_at).toISOString() : '',
    r.clock_out_at ? new Date(r.clock_out_at).toISOString() : '',
    r.late ? 'Yes' : 'No',
  ]);
  return [GENERATED_WARNING, header, ...body];
}

export function formatHistoryRows(rows) {
  const header = ['Date', 'Task', 'Staff', 'Status'];
  const body = rows.map((r) => [r.run_date, r.task_name, r.staff_name, r.status]);
  return [GENERATED_WARNING, header, ...body];
}

export async function queryTodayRows() {
  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `select run.status, run.current_seq, run.started_at, task.name as task_name, staff.name as staff_name
     from run join task on task.id = run.task_id join staff on staff.id = run.staff_id
     where run.run_date = $1
     order by task.seq, staff.name`,
    [today]
  );
  return rows;
}

// Clock-in/out comes from entry rows whose step had a clock_action, joined
// back through run -- there is no separate attendance table (build schema
// v2.0 section 4 rule 11: show hours, never a second source of truth for
// them). "Late" compares the clock-in entry's timestamp against the
// staff member's shift_start, same threshold the doc's own worked examples
// use informally.
export async function queryAttendanceRows({ days = 30 } = {}) {
  const { rows } = await pool.query(
    // run_date cast to text in SQL, not left for JS to format -- the pg
    // driver (and PGlite, same behaviour) parses a `date` column into a
    // local-timezone JS Date object, not a plain string; formatting that in
    // JS silently produced a full ISO timestamp (with a timezone-shifted
    // date) instead of the plain YYYY-MM-DD the sheet needs. Caught by
    // test-sheet-sync.mjs.
    `select to_char(run.run_date, 'YYYY-MM-DD') as run_date, staff.name as staff_name, staff.shift_start,
            min(case when step.clock_action = 'in' then entry.created_at end) as clock_in_at,
            max(case when step.clock_action = 'out' then entry.created_at end) as clock_out_at
     from entry
     join step on step.id = entry.step_id
     join run on run.id = entry.run_id
     join staff on staff.id = entry.staff_id
     where step.clock_action != 'none' and run.run_date >= current_date - $1::int
     group by run.run_date, staff.name, staff.shift_start
     order by run.run_date desc, staff.name`,
    [days]
  );
  return rows.map((r) => ({
    ...r,
    late: Boolean(r.clock_in_at && r.shift_start && new Date(r.clock_in_at).toTimeString().slice(0, 8) > r.shift_start),
  }));
}

// Last 90 days per build schema v2.0 section 9 rule 5 -- full history stays
// in Postgres, this is a bounded window only.
export async function queryHistoryRows({ days = 90 } = {}) {
  const { rows } = await pool.query(
    // Same to_char cast as queryAttendanceRows above, same reason.
    `select to_char(run.run_date, 'YYYY-MM-DD') as run_date, run.status, task.name as task_name, staff.name as staff_name
     from run join task on task.id = run.task_id join staff on staff.id = run.staff_id
     where run.run_date >= current_date - $1::int
     order by run.run_date desc, task.seq, staff.name`,
    [days]
  );
  return rows;
}

export async function syncBusinessSheet() {
  const { rows: linkRows } = await pool.query(`select spreadsheet_id from sheet_link limit 1`);
  const spreadsheetId = linkRows[0]?.spreadsheet_id;
  if (!spreadsheetId) return { synced: false, reason: 'no sheet_link.spreadsheet_id -- Sheet was not provisioned for this business yet' };

  const serviceAccountJsonRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJsonRaw) return { synced: false, reason: 'GOOGLE_SERVICE_ACCOUNT_JSON not set on this deployment' };
  const serviceAccountJson = JSON.parse(serviceAccountJsonRaw);

  const accessToken = await getAccessToken(serviceAccountJson, 'https://www.googleapis.com/auth/spreadsheets');
  await writeTab(accessToken, spreadsheetId, 'Today', formatTodayRows(await queryTodayRows()));
  await writeTab(accessToken, spreadsheetId, 'Attendance', formatAttendanceRows(await queryAttendanceRows()));
  await writeTab(accessToken, spreadsheetId, 'History', formatHistoryRows(await queryHistoryRows()));
  await pool.query(`update sheet_link set last_synced_at = now()`);
  return { synced: true };
}
