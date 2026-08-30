#!/usr/bin/env node
// Regression suite for the real engine (../engine/run-engine.js,
// proof-types.js, alerts.js) -- no WhatsApp, no real server. Standing bot
// rule: every fixed bug becomes a permanent fixture here (see
// bot-conversation-rules.md / FIX-PROTOCOL.md at the repo root).
//
// Run with:
//   ESF_TEST_PGLITE=1 ESF_SANDBOX=1 node sandbox/test-engine.mjs
// PGlite gives a real, throwaway, in-process Postgres (schema.sql applied
// automatically, see lib/db.js); ESF_SANDBOX makes whatsapp-send.js print
// instead of calling Meta.

import { pool } from '../lib/db.js';
import { handleStaffReply, openRunAndPrompt } from '../engine/run-engine.js';

let passed = 0;

async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok: ${name}`);
}

async function seedBusiness() {
  await pool.query(
    `insert into business (name, lat, lng, radius_m, owner_phone) values ('Grace Stores', 9.0579, 7.4951, 200, '2348000000000')`
  );
}

async function seedStaff(phone, name, role) {
  const { rows } = await pool.query(`insert into staff (phone, name, role) values ($1, $2, $3) returning *`, [phone, name, role]);
  return rows[0];
}

async function seedTask({ name, role, days, availableFrom, dueBy }) {
  const { rows } = await pool.query(
    `insert into task (name, role, days, available_from, due_by) values ($1, $2, $3, $4, $5) returning *`,
    [name, role, days, availableFrom, dueBy]
  );
  return rows[0];
}

async function seedStep(taskId, { seq, instruction, proofType, proofConfig = {}, onProblem = 'continue', optional = false }) {
  await pool.query(
    `insert into step (task_id, seq, instruction, proof_type, proof_config, on_problem, optional) values ($1, $2, $3, $4, $5, $6, $7)`,
    [taskId, seq, instruction, proofType, JSON.stringify(proofConfig), onProblem, optional]
  );
}

// A staff member with no prior message history is, by definition, outside
// WhatsApp's 24h customer-service window the first time the bot ever
// messages her -- openRunAndPrompt sends an approved template instead of
// the real instruction (bot-engine/wake-template.js), and her first reply
// to THAT is consumed as "the window is open again", not as an answer
// (run-engine.js's wake_sent_at branch). Real staff hit this on every
// brand-new run the same way; this fixture-only helper stands in for that
// first, content-free reply so the rest of each fixture can test the real
// step content that comes after it.
async function primeWakeIfNeeded(taskId, staffId, staff) {
  const { rows } = await pool.query(`select wake_sent_at from run where task_id = $1 and staff_id = $2`, [taskId, staffId]);
  if (rows[0]?.wake_sent_at) await handleStaffReply({ staff, input: { type: 'text', text: 'hi' } });
}

async function main() {
  console.log('=== ESF engine sandbox tests ===');
  await seedBusiness();

  console.log('\n--- Fixture 1: single tap step, straight completion ---');
  {
    const staff = await seedStaff('2348010000001', 'Blessing', 'sales');
    const task = await seedTask({ name: 'Quick Open', role: 'sales', days: 'MON,TUE,WED,THU,FRI,SAT,SUN', availableFrom: '00:00', dueBy: '23:59' });
    await seedStep(task.id, { seq: 1, instruction: 'Shop opened', proofType: 'tap' });

    await check('a cold run sends a WhatsApp template first, not the real instruction', async () => {
      const run = await openRunAndPrompt(task, staff);
      if (!run || run.status !== 'open') throw new Error(`expected an open run, got ${JSON.stringify(run)}`);
      if (!run.wake_sent_at) throw new Error('expected wake_sent_at to be set for a staff member with no prior message history');
    });

    await check('her first reply flushes the wake and gets the real step 1 instruction, not treated as an answer', async () => {
      const { reply } = await handleStaffReply({ staff, input: { type: 'text', text: 'hi' } });
      if (!/shop opened/i.test(reply)) throw new Error(`expected step 1's instruction, got "${reply}"`);
      const { rows } = await pool.query(`select count(*)::int as n from entry`);
      if (rows[0].n !== 0) throw new Error(`the wake-flush reply must not be recorded as an entry`);
    });

    await check('replying DONE now completes the (single-step) run', async () => {
      const { reply } = await handleStaffReply({ staff, input: { type: 'text', text: 'done' } });
      if (!/complete/i.test(reply)) throw new Error(`expected a completion reply, got "${reply}"`);
      const { rows } = await pool.query(`select status from run where task_id = $1 and staff_id = $2`, [task.id, staff.id]);
      if (rows[0].status !== 'complete') throw new Error(`expected run status complete, got ${rows[0].status}`);
    });
  }

  console.log('\n--- Fixture 2: number step, sequence enforcement, bad input reprompts without recording ---');
  {
    const staff = await seedStaff('2348010000002', 'Ngozi', 'sales');
    const task = await seedTask({ name: 'Closing', role: 'sales', days: 'MON,TUE,WED,THU,FRI,SAT,SUN', availableFrom: '00:00', dueBy: '23:59' });
    await seedStep(task.id, { seq: 1, instruction: 'Cash counted', proofType: 'number', proofConfig: { min: 0, max: 5_000_000 } });
    await seedStep(task.id, { seq: 2, instruction: 'Photo of the shelf', proofType: 'photo' });
    await openRunAndPrompt(task, staff);
    await primeWakeIfNeeded(task.id, staff.id, staff);

    await check('non-numeric reply re-asks and records nothing', async () => {
      const { reply } = await handleStaffReply({ staff, input: { type: 'text', text: 'not a number' } });
      if (!/not a valid number/i.test(reply)) throw new Error(`expected a re-ask, got "${reply}"`);
      const { rows } = await pool.query(`select count(*)::int as n from entry where staff_id = $1`, [staff.id]);
      if (rows[0].n !== 0) throw new Error(`expected zero entries for this staff member, got ${rows[0].n}`);
    });

    await check('valid number advances to step 2, not skipping ahead', async () => {
      const { reply } = await handleStaffReply({ staff, input: { type: 'text', text: '15000' } });
      if (!/photo of the shelf/i.test(reply)) throw new Error(`expected step 2's instruction, got "${reply}"`);
      const { rows } = await pool.query(`select current_seq from run where task_id = $1 and staff_id = $2`, [task.id, staff.id]);
      if (rows[0].current_seq !== 2) throw new Error(`expected current_seq 2, got ${rows[0].current_seq}`);
    });

    await check('step 2 cannot be skipped by answering step 1 twice -- only the current step is ever evaluated', async () => {
      const { rows: before } = await pool.query(`select current_seq from run where task_id = $1 and staff_id = $2`, [task.id, staff.id]);
      await handleStaffReply({ staff, input: { type: 'text', text: '9999' } }); // would be a valid number, but step 2 is a photo now
      const { rows: after } = await pool.query(`select current_seq from run where task_id = $1 and staff_id = $2`, [task.id, staff.id]);
      if (before[0].current_seq !== after[0].current_seq) throw new Error('current_seq moved on invalid input for the CURRENT step');
    });
  }

  console.log('\n--- Fixture 3: location proof, out-of-radius is a structural "problem" ---');
  {
    const staff = await seedStaff('2348010000003', 'Emeka', 'store');
    const task = await seedTask({ name: 'Clock In', role: 'store', days: 'MON,TUE,WED,THU,FRI,SAT,SUN', availableFrom: '00:00', dueBy: '23:59' });
    await seedStep(task.id, { seq: 1, instruction: 'Share your location', proofType: 'location', proofConfig: { radius_m: 200 }, onProblem: 'block' });
    await openRunAndPrompt(task, staff);
    await primeWakeIfNeeded(task.id, staff.id, staff);

    await check('a pin far from the business blocks the run and logs one alert', async () => {
      const { reply } = await handleStaffReply({ staff, input: { type: 'location', lat: 6.5244, lng: 3.3792 } }); // Lagos, far from Grace Stores' Abuja coordinates
      if (!/paused/i.test(reply)) throw new Error(`expected a blocked/paused reply, got "${reply}"`);
      const { rows } = await pool.query(`select status from run where task_id = $1 and staff_id = $2`, [task.id, staff.id]);
      if (rows[0].status !== 'blocked') throw new Error(`expected run status blocked, got ${rows[0].status}`);
      const { rows: alerts } = await pool.query(`select count(*)::int as n from alert_log where event = 'blocked'`);
      if (alerts[0].n !== 1) throw new Error(`expected exactly one blocked alert logged, got ${alerts[0].n}`);
    });
  }

  console.log('\n--- Fixture 4: generic "problem" self-report works on any step, dedup fires once ---');
  {
    const staff = await seedStaff('2348010000004', 'Aisha', 'cashier');
    const task = await seedTask({ name: 'Cash-up', role: 'cashier', days: 'MON,TUE,WED,THU,FRI,SAT,SUN', availableFrom: '00:00', dueBy: '23:59' });
    await seedStep(task.id, { seq: 1, instruction: 'Till count', proofType: 'number', onProblem: 'alert' });
    await openRunAndPrompt(task, staff);
    await primeWakeIfNeeded(task.id, staff.id, staff);

    await check('typing "problem: ..." records a problem entry and advances (alert, not block)', async () => {
      const { reply } = await handleStaffReply({ staff, input: { type: 'text', text: 'problem: till is 2000 short' } });
      if (/paused/i.test(reply)) throw new Error('on_problem=alert must not block the run');
      const { rows } = await pool.query(`select answer, note from entry where step_id = (select id from step where task_id = $1)`, [task.id]);
      if (rows[0].answer !== 'problem' || !/2000 short/.test(rows[0].note)) throw new Error(`unexpected entry: ${JSON.stringify(rows[0])}`);
    });

    await check('dispatchAlert dedup: only one "problem" alert row for this task+staff today', async () => {
      const { rows } = await pool.query(`select count(*)::int as n from alert_log where event = 'problem'`);
      if (rows[0].n !== 1) throw new Error(`expected exactly one problem alert logged, got ${rows[0].n}`);
    });
  }

  console.log(`\n${passed} checks passed.`);
  await pool.end();
}

main().catch((err) => {
  console.error('SANDBOX TEST FAILED:', err);
  process.exit(1);
});
