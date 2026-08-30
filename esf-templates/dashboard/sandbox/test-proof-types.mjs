#!/usr/bin/env node
// Regression suite for the remaining proof types not covered by
// test-engine.mjs's fixtures (tap/number/location/problem-report are
// covered there) -- choice, text, code, api, countersign -- plus
// step_override, including that its reason is actually shown to the staff
// member (build schema v2.0 section 3.7). Run with:
//   ESF_TEST_PGLITE=1 ESF_SANDBOX=1 node sandbox/test-proof-types.mjs

import http from 'node:http';
import { pool } from '../lib/db.js';
import { handleStaffReply, openRunAndPrompt } from '../engine/run-engine.js';

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

async function seedTask(name, role) {
  const { rows } = await pool.query(
    `insert into task (name, role, days, available_from, due_by) values ($1, $2, 'MON,TUE,WED,THU,FRI,SAT,SUN', '00:00', '23:59') returning *`,
    [name, role]
  );
  return rows[0];
}

async function seedStep(taskId, { seq, instruction, proofType, proofConfig = {}, onProblem = 'continue' }) {
  await pool.query(
    `insert into step (task_id, seq, instruction, proof_type, proof_config, on_problem) values ($1, $2, $3, $4, $5, $6)`,
    [taskId, seq, instruction, proofType, JSON.stringify(proofConfig), onProblem]
  );
}

async function primeWakeIfNeeded(taskId, staffId, staff) {
  const { rows } = await pool.query(`select wake_sent_at from run where task_id = $1 and staff_id = $2`, [taskId, staffId]);
  if (rows[0]?.wake_sent_at) await handleStaffReply({ staff, input: { type: 'text', text: 'hi' } });
}

async function main() {
  console.log('=== proof-type + step_override tests ===');
  await pool.query(`insert into business (name) values ('Sunrise Salon')`);

  console.log('\n--- choice ---');
  {
    const staff = await seedStaff('2348040000001', 'Kemi', 'stylist');
    const task = await seedTask('Client service', 'stylist');
    await seedStep(task.id, { seq: 1, instruction: 'Room state', proofType: 'choice', proofConfig: { options: ['Full', 'Half', 'Empty'] } });
    await openRunAndPrompt(task, staff);
    await primeWakeIfNeeded(task.id, staff.id, staff);

    await check('an out-of-list reply re-asks', async () => {
      const { reply } = await handleStaffReply({ staff, input: { type: 'text', text: 'Neither' } });
      if (!/please reply with one of/i.test(reply)) throw new Error(`expected a re-ask, got "${reply}"`);
    });

    await check('replying with the 1-based number selects that option and completes the task', async () => {
      const { reply } = await handleStaffReply({ staff, input: { type: 'text', text: '2' } });
      if (!/complete/i.test(reply)) throw new Error(`expected completion, got "${reply}"`);
      const { rows } = await pool.query(`select value from entry where staff_id = $1`, [staff.id]);
      if (rows[0].value !== 'Half') throw new Error(`expected value "Half" (option 2), got ${JSON.stringify(rows[0])}`);
    });
  }

  console.log('\n--- text ---');
  {
    const staff = await seedStaff('2348040000002', 'Tolu', 'stylist');
    const task = await seedTask('Notes', 'stylist');
    await seedStep(task.id, { seq: 1, instruction: 'Describe the service', proofType: 'text', proofConfig: { min_length: 10 } });
    await openRunAndPrompt(task, staff);
    await primeWakeIfNeeded(task.id, staff.id, staff);

    await check('too-short text re-asks and records nothing', async () => {
      const { reply } = await handleStaffReply({ staff, input: { type: 'text', text: 'short' } });
      if (!/at least 10 characters/i.test(reply)) throw new Error(`expected a min-length re-ask, got "${reply}"`);
    });

    await check('long-enough text completes the task', async () => {
      const { reply } = await handleStaffReply({ staff, input: { type: 'text', text: 'Full silk press with a deep condition treatment' } });
      if (!/complete/i.test(reply)) throw new Error(`expected completion, got "${reply}"`);
    });
  }

  console.log('\n--- code ---');
  {
    const staff = await seedStaff('2348040000003', 'Ada', 'stylist');
    const task = await seedTask('Check-in', 'stylist');
    await seedStep(task.id, { seq: 1, instruction: 'Client code', proofType: 'code', proofConfig: { source: 'otp' } });
    await openRunAndPrompt(task, staff);
    await primeWakeIfNeeded(task.id, staff.id, staff);

    await check('any non-empty code is accepted and recorded verbatim', async () => {
      const { reply } = await handleStaffReply({ staff, input: { type: 'text', text: '4471' } });
      if (!/complete/i.test(reply)) throw new Error(`expected completion, got "${reply}"`);
      const { rows } = await pool.query(`select value from entry where staff_id = $1`, [staff.id]);
      if (rows[0].value !== '4471') throw new Error(`expected the code recorded verbatim, got ${JSON.stringify(rows[0])}`);
    });
  }

  console.log('\n--- api ---');
  {
    // A real local HTTP server standing in for a payment gateway's verify
    // endpoint -- exercises validateProof's actual fetch + success_path/
    // success_value matching + {{value}}/{{secret.*}} interpolation, not a
    // mocked fetch. /verify/GOOD -> {status:"success"}, anything else ->
    // {status:"failed"}.
    const server = http.createServer((req, res) => {
      const ref = req.url.split('/').pop();
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== 'Bearer test-secret-key') {
        res.writeHead(401);
        return res.end(JSON.stringify({ error: 'bad auth' }));
      }
      res.writeHead(200);
      res.end(JSON.stringify({ status: ref === 'GOOD' ? 'success' : 'failed' }));
    });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    process.env.MOCK_GATEWAY_KEY = 'test-secret-key';

    const staff = await seedStaff('2348040000004', 'Sola', 'stylist');
    const task = await seedTask('Payment (reject on fail)', 'stylist');
    await seedStep(task.id, {
      seq: 1,
      instruction: 'Payment reference',
      proofType: 'api',
      proofConfig: {
        url: `http://127.0.0.1:${port}/verify/{{value}}`,
        headers: { Authorization: 'Bearer {{secret.MOCK_GATEWAY_KEY}}' },
        success_path: 'status',
        success_value: 'success',
        on_fail: 'reject',
      },
    });
    await openRunAndPrompt(task, staff);
    await primeWakeIfNeeded(task.id, staff.id, staff);

    await check('on_fail=reject: a bad reference re-asks and records nothing', async () => {
      const { reply } = await handleStaffReply({ staff, input: { type: 'text', text: 'BAD-REF' } });
      if (!/could not be verified/i.test(reply)) throw new Error(`expected a re-ask, got "${reply}"`);
      const { rows } = await pool.query(`select count(*)::int as n from entry where staff_id = $1`, [staff.id]);
      if (rows[0].n !== 0) throw new Error(`expected zero entries after a rejected api check, got ${rows[0].n}`);
    });

    await check('a real (auth-header-interpolated) verified reference completes the task', async () => {
      const { reply } = await handleStaffReply({ staff, input: { type: 'text', text: 'GOOD' } });
      if (!/complete/i.test(reply)) throw new Error(`expected completion, got "${reply}"`);
    });

    // Second task, on_fail=flag -- verifies the "closes but marked
    // unverified, run keeps going" behaviour is actually different from
    // reject, not just a copy-pasted code path.
    const staff2 = await seedStaff('2348040000005', 'Bimbo', 'stylist');
    const task2 = await seedTask('Payment (flag on fail)', 'stylist');
    await seedStep(task2.id, {
      seq: 1,
      instruction: 'Payment reference',
      proofType: 'api',
      proofConfig: {
        url: `http://127.0.0.1:${port}/verify/{{value}}`,
        headers: { Authorization: 'Bearer {{secret.MOCK_GATEWAY_KEY}}' },
        success_path: 'status',
        success_value: 'success',
        on_fail: 'flag',
      },
    });
    await openRunAndPrompt(task2, staff2);
    await primeWakeIfNeeded(task2.id, staff2.id, staff2);

    await check('on_fail=flag: a bad reference still completes the task, entry marked unverified', async () => {
      const { reply } = await handleStaffReply({ staff: staff2, input: { type: 'text', text: 'BAD-REF' } });
      if (!/complete/i.test(reply)) throw new Error(`expected completion even on a failed check (on_fail=flag), got "${reply}"`);
      const { rows } = await pool.query(`select answer, note from entry where staff_id = $1`, [staff2.id]);
      if (rows[0].answer !== 'problem' || !/unverified/i.test(rows[0].note)) throw new Error(`expected an unverified problem entry, got ${JSON.stringify(rows[0])}`);
    });

    server.close();
  }

  console.log('\n--- photo (including min > 1 accumulation) ---');
  {
    const staff = await seedStaff('2348040000008', 'Ngozi', 'sales');
    const task = await seedTask('Restock', 'sales');
    await seedStep(task.id, { seq: 1, instruction: 'Photo of the shelf', proofType: 'photo', proofConfig: { min: 1 } });
    await seedStep(task.id, { seq: 2, instruction: 'Photos of the store room', proofType: 'photo', proofConfig: { min: 3 } });
    await openRunAndPrompt(task, staff);
    await primeWakeIfNeeded(task.id, staff.id, staff);

    await check('min: 1 (the default case) advances on the first photo', async () => {
      const { reply } = await handleStaffReply({ staff, input: { type: 'image', mediaDataUrl: 'data:image/jpeg;base64,aaa' } });
      if (!/store room/i.test(reply)) throw new Error(`expected step 2's instruction, got "${reply}"`);
    });

    await check('min: 3 does not advance after the first photo, and reports progress', async () => {
      const { reply } = await handleStaffReply({ staff, input: { type: 'image', mediaDataUrl: 'data:image/jpeg;base64,bbb' } });
      if (!/1 of 3/.test(reply)) throw new Error(`expected a "1 of 3" progress message, got "${reply}"`);
      const { rows } = await pool.query(`select current_seq from run where task_id = $1 and staff_id = $2`, [task.id, staff.id]);
      if (rows[0].current_seq !== 2) throw new Error(`expected current_seq to still be 2 (not advanced), got ${rows[0].current_seq}`);
    });

    await check('does not advance after the second photo either', async () => {
      const { reply } = await handleStaffReply({ staff, input: { type: 'image', mediaDataUrl: 'data:image/jpeg;base64,ccc' } });
      if (!/2 of 3/.test(reply)) throw new Error(`expected a "2 of 3" progress message, got "${reply}"`);
    });

    await check('advances (task completes) once the third photo arrives, and all three were recorded as separate entries', async () => {
      const { reply } = await handleStaffReply({ staff, input: { type: 'image', mediaDataUrl: 'data:image/jpeg;base64,ddd' } });
      if (!/complete/i.test(reply)) throw new Error(`expected completion, got "${reply}"`);
      const { rows } = await pool.query(`select count(*)::int as n from entry where run_id = (select id from run where task_id = $1 and staff_id = $2) and answer = 'done'`, [task.id, staff.id]);
      if (rows[0].n !== 4) throw new Error(`expected 4 total done entries (1 for step 1 + 3 for step 2), got ${rows[0].n}`);
    });
  }

  console.log('\n--- countersign: real cross-staff routing ---');
  {
    const stylist = await seedStaff('2348040000006', 'Bola', 'stylist');
    const receptionist = await seedStaff('2348040000009', 'Funke', 'receptionist');
    const task = await seedTask('Sign-off', 'stylist');
    await seedStep(task.id, { seq: 1, instruction: 'Client confirmed satisfied', proofType: 'countersign', proofConfig: { role: 'receptionist' } });

    await check('opening the run routes straight to the confirmer, not the run owner -- pending_countersign_staff_id is set', async () => {
      await openRunAndPrompt(task, stylist);
      const { rows } = await pool.query(`select pending_countersign_staff_id, wake_sent_at from run where task_id = $1 and staff_id = $2`, [task.id, stylist.id]);
      if (rows[0].pending_countersign_staff_id !== receptionist.id) throw new Error(`expected pending_countersign_staff_id=${receptionist.id}, got ${JSON.stringify(rows[0])}`);
      if (rows[0].wake_sent_at) throw new Error('countersign routing should bypass the stylist\'s own wake-template check entirely');
    });

    await check('the stylist herself has nothing to answer -- she has no open, non-pending task to reply to', async () => {
      const { reply } = await handleStaffReply({ staff: stylist, input: { type: 'text', text: 'hello?' } });
      if (!/no task is due/i.test(reply)) throw new Error(`expected "no task due", got "${reply}"`);
    });

    await check('the receptionist\'s reply is recognised as a pending countersign and gets a short ack, not the completion message', async () => {
      const { reply } = await handleStaffReply({ staff: receptionist, input: { type: 'text', text: 'Yes, all good' } });
      if (!/recorded/i.test(reply)) throw new Error(`expected a short ack ("recorded"), got "${reply}"`);
      if (/complete/i.test(reply)) throw new Error('the completion message belongs to the stylist, not the confirmer\'s own reply');
    });

    await check('the entry is recorded against the STYLIST (whose task it is), noting who actually confirmed it', async () => {
      const { rows: entryRows } = await pool.query(
        `select staff_id, value, note from entry where run_id = (select id from run where task_id = $1 and staff_id = $2)`,
        [task.id, stylist.id]
      );
      if (entryRows[0].staff_id !== stylist.id) throw new Error(`expected the entry attributed to the stylist ${stylist.id}, got ${entryRows[0].staff_id}`);
      if (!/Confirmed by Funke/.test(entryRows[0].note)) throw new Error(`expected the note to name who confirmed, got "${entryRows[0].note}"`);
    });

    await check('the run completed (single-step task) and pending_countersign_staff_id was cleared', async () => {
      const { rows } = await pool.query(`select status, pending_countersign_staff_id from run where task_id = $1 and staff_id = $2`, [task.id, stylist.id]);
      if (rows[0].status !== 'complete') throw new Error(`expected run status complete, got ${rows[0].status}`);
      if (rows[0].pending_countersign_staff_id !== null) throw new Error('expected pending_countersign_staff_id cleared after confirmation');
    });
  }

  console.log('\n--- countersign: fallback when nobody else holds the role ---');
  {
    // A role unique to this fixture -- 'receptionist' is already held by
    // Funke from the fixture above, which would make this accidentally NOT
    // a "nobody else holds the role" case (caught by this exact confusion
    // the first time this ran).
    const staff = await seedStaff('2348040000010', 'Tolu', 'lone-front-desk');
    const task = await seedTask('Sign-off solo', 'lone-front-desk');
    await seedStep(task.id, { seq: 1, instruction: 'Client confirmed satisfied', proofType: 'countersign', proofConfig: { role: 'lone-front-desk' } });
    await openRunAndPrompt(task, staff);
    await primeWakeIfNeeded(task.id, staff.id, staff);

    await check('with nobody else holding the role, it degrades to self-report rather than stalling forever', async () => {
      const { reply } = await handleStaffReply({ staff, input: { type: 'text', text: 'Confirmed' } });
      if (!/complete/i.test(reply)) throw new Error(`expected completion, got "${reply}"`);
      const { rows } = await pool.query(`select note from entry where staff_id = $1`, [staff.id]);
      if (!/no active .* staff member exists/i.test(rows[0].note)) throw new Error(`expected the fallback reason on the record, got ${JSON.stringify(rows[0])}`);
    });
  }

  console.log('\n--- step_override ---');
  {
    const staff = await seedStaff('2348040000007', 'Chioma', 'sales');
    const task = await seedTask('Opening', 'sales');
    const { rows: stepRows } = await pool.query(
      `insert into step (task_id, seq, instruction, proof_type, proof_config) values ($1, 1, 'Photo of the shelf', 'photo', '{"min":1}'::jsonb) returning id`,
      [task.id]
    );
    const stepId = stepRows[0].id;
    await pool.query(
      `insert into step_override (step_id, staff_id, proof_type, proof_config, reason) values ($1, $2, 'tap', '{}'::jsonb, 'New camera is broken this week -- just confirm by text.')`,
      [stepId, staff.id]
    );
    await openRunAndPrompt(task, staff);

    await check('the override reason is shown to the staff member in the prompt, not applied silently', async () => {
      // A brand-new staff member has no prior message, so this is always a
      // cold start -- openRunAndPrompt sent a template, not the real
      // instruction (same as every other fixture's first interaction, see
      // test-engine.mjs). This reply is the wake-flush, which IS where the
      // real instruction (and the override note) actually gets sent.
      const { rows } = await pool.query(`select wake_sent_at from run where task_id = $1 and staff_id = $2`, [task.id, staff.id]);
      if (!rows[0]?.wake_sent_at) throw new Error('expected a cold-start wake template for a brand-new staff member -- test setup assumption broke');
      const { reply } = await handleStaffReply({ staff, input: { type: 'text', text: 'hi' } });
      if (!/camera is broken/i.test(reply)) throw new Error(`expected the override reason in the prompt, got "${reply}"`);
    });

    await check('replying with a plain tap (not a photo) satisfies the step, because the override -- not the step default -- is what is enforced', async () => {
      const { reply } = await handleStaffReply({ staff, input: { type: 'text', text: 'done' } });
      if (!/complete/i.test(reply)) throw new Error(`expected completion via the override's tap proof, got "${reply}"`);
      const { rows } = await pool.query(`select applied_proof_type from entry where staff_id = $1`, [staff.id]);
      if (rows[0].applied_proof_type !== 'tap') throw new Error(`expected applied_proof_type "tap" (from the override), got ${rows[0].applied_proof_type}`);
    });
  }

  console.log(`\n${passed} checks passed.`);
  await pool.end();
}

main().catch((err) => {
  console.error('SANDBOX TEST FAILED:', err);
  process.exit(1);
});
