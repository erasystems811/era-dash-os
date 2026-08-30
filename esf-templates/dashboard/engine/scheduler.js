// The jobs the engine depends on to function at all (build schema v2.0
// section 2.4): opening a run and prompting step 1 once a task becomes due,
// sweeping for tasks that went unfinished past due_by, syncing the Google
// Sheet, and sending the daily summary. Run as plain setInterval polling
// inside this process -- not n8n workflows -- because no proven
// n8n-workflow-import convention exists anywhere in this repo yet to build
// that path on (see section 2.4's own note); this matches how EBOS's own
// background work runs today (a plain function called from server.js, not
// a separate orchestrator).
//
// TODO: cross-staff countersign routing is still not wired in (see
// proof-types.js's own TODO) -- everything else in build schema v2.0's
// section 12 build order through stage 10 is now implemented here.

import { pool } from '../lib/db.js';
import { openRunAndPrompt, todayCode } from './run-engine.js';
import { dispatchAlert } from './alerts.js';
import { syncBusinessSheet } from './sheet-sync.js';

// Who a task applies to -- staff_id (one specific person) wins over role
// (a group) if both happen to be set; the single source of truth for this
// lives here, not duplicated across openDueRuns/sweepMissingTasks.
async function staffForTask(task) {
  if (task.staff_id) {
    const { rows } = await pool.query(`select * from staff where id = $1 and active`, [task.staff_id]);
    return rows;
  }
  const { rows } = await pool.query(`select * from staff where active and ($1::text is null or role = $1)`, [task.role || null]);
  return rows;
}

function timeStringNow() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`;
  // TODO: uses the server's local clock, not business.timezone -- fine
  // while every deployment runs in Africa/Lagos (engine rule 9's actual
  // display requirement), a real gap once a client outside that timezone
  // exists. Flagged in build schema v2.0 section 14.
}

export async function openDueRuns() {
  const today = todayCode();
  const nowTime = timeStringNow();
  const { rows: tasks } = await pool.query(
    `select * from task where active and position($1 in days) > 0 and available_from <= $2`,
    [today, nowTime]
  );
  for (const task of tasks) {
    const staffList = await staffForTask(task);
    for (const staff of staffList) {
      try {
        await openRunAndPrompt(task, staff);
      } catch (err) {
        console.error(`openDueRuns failed for task=${task.id} staff=${staff.id}:`, err);
      }
    }
  }
}

export async function sweepMissingTasks() {
  const today = todayCode();
  const todayIso = new Date().toISOString().slice(0, 10);
  const nowTime = timeStringNow();
  const { rows: tasks } = await pool.query(
    `select * from task where active and position($1 in days) > 0 and due_by <= $2`,
    [today, nowTime]
  );
  for (const task of tasks) {
    const staffList = await staffForTask(task);
    for (const staff of staffList) {
      const { rows: runs } = await pool.query(
        `select * from run where task_id = $1 and staff_id = $2 and run_date = $3`,
        [task.id, staff.id, todayIso]
      );
      const run = runs[0];
      const business = await pool.query(`select name from business limit 1`);
      const detail = `${business.rows[0]?.name || 'A business'}: "${task.name}" is overdue for ${staff.name}${run ? '' : ' (never started)'}.`;

      if (!run) {
        await dispatchAlert({ event: 'missing', message: detail, context: `${task.id}:${staff.id}` });
        continue;
      }
      if (run.status === 'open') {
        await pool.query(`update run set status = 'missed' where id = $1`, [run.id]);
        await dispatchAlert({ event: 'missing', message: detail, context: `${task.id}:${staff.id}` });
      }
      // 'complete' and 'blocked' runs are left alone -- complete needs no
      // alert, and 'blocked' already alerted immediately when it happened
      // (run-engine.js's handleProblem), not here on a 30-minute delay.
    }
  }
}

// "At close" (build schema v2.0 section 9 rule 3) isn't a stored field --
// no business.close_time column exists in this schema -- so "close" is
// derived as the latest due_by among today's active tasks. Fires once,
// after every task for the day should already be resolved one way or
// another, and dedups through the same alert_log mechanism as every other
// alert (event='daily_summary', context='' -- once per business per day,
// not once per task).
export async function sendDailySummary() {
  const today = todayCode();
  const todayIso = new Date().toISOString().slice(0, 10);
  const nowTime = timeStringNow();

  const { rows: dueByRows } = await pool.query(
    `select max(due_by) as latest_due_by from task where active and position($1 in days) > 0`,
    [today]
  );
  const latestDueBy = dueByRows[0]?.latest_due_by;
  if (!latestDueBy || nowTime < latestDueBy) return; // not "close" yet

  const { rows: counts } = await pool.query(
    `select status, count(*)::int as n from run where run_date = $1 group by status`,
    [todayIso]
  );
  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c.n]));
  const business = await pool.query(`select name from business limit 1`);
  const message = `${business.rows[0]?.name || 'Daily summary'}: ${byStatus.complete || 0} complete, ${byStatus.missed || 0} missed, ${byStatus.blocked || 0} still blocked, ${byStatus.open || 0} still open.`;

  await dispatchAlert({ event: 'daily_summary', message, context: '' });
}

export function startScheduler() {
  const openInterval = setInterval(() => openDueRuns().catch((err) => console.error('openDueRuns failed:', err)), 5 * 60 * 1000);
  const sweepInterval = setInterval(() => sweepMissingTasks().catch((err) => console.error('sweepMissingTasks failed:', err)), 30 * 60 * 1000);
  const sheetInterval = setInterval(() => syncBusinessSheet().catch((err) => console.error('syncBusinessSheet failed:', err)), 15 * 60 * 1000);
  const summaryInterval = setInterval(() => sendDailySummary().catch((err) => console.error('sendDailySummary failed:', err)), 15 * 60 * 1000);
  // Run once at startup too, so a freshly deployed client doesn't wait a
  // full interval for its first tick.
  openDueRuns().catch((err) => console.error('openDueRuns (startup) failed:', err));
  return () => {
    clearInterval(openInterval);
    clearInterval(sweepInterval);
    clearInterval(sheetInterval);
    clearInterval(summaryInterval);
  };
}
