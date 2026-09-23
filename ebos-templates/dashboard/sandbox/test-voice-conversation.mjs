#!/usr/bin/env node
// Voice ordering add-on's own regression fixture, same standing-rule
// pattern as sandbox/test-conversation.mjs (every fixed bug/load-bearing
// feature becomes a permanent test here).
//
// Honest scope note: this environment has no ANTHROPIC_API_KEY, so nothing
// that calls Claude (classifyIntent, extractOrderItems, the confirm-order
// yes/no extraction, etc.) can run here -- same constraint the Delivery
// add-on's own sandbox testing hit. Those code paths are completely
// UNCHANGED by this add-on (see engine/flow.js's handleVoiceTurn comment:
// it calls straight into the exact same handlePendingBatch/dispatch
// WhatsApp already uses), so they're not what voice needs to prove.
// What voice actually adds -- customer creation on the 'voice' channel,
// reply buffering instead of a network push, call_turn/voice_call
// bookkeeping, and the deterministic half of customer recognition (A6) --
// is fully exercisable without Claude, via classifyPureAck's deterministic
// ack/thanks path (no AI call). The mandatory order read-back (A5) is
// verified by inspection instead (engine/flow.js's handleCollectInfo has
// exactly one path to confirm_order, and it always sends the "To confirm:
// ..., total NGN ..." line first) -- flagged here rather than silently
// assumed, since it could not be exercised live in this sandbox.
//
// Set EBOS_TEST_PGLITE=1 to run against a real, throwaway, in-process
// Postgres (schema.sql applied automatically, seeds a sample restaurant).
import { pool } from '../lib/db.js';
import { startVoiceCall, handleCallerUtterance } from '../engine/voice.js';
import { checkOperatingHours } from '../engine/voice-hours.js';
import { seedSampleRestaurant } from './seed-sample-restaurant.mjs';

async function enableHandoverAlerts() {
  await pool.query(`update business set handover_number = '2348090000000'`);
}

let passed = 0;

async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok: ${name}`);
}

async function resetCustomer(phone) {
  const { rows } = await pool.query('select id from customers where phone_number = $1', [phone]);
  const id = rows[0]?.id;
  if (!id) return;
  await pool.query('delete from call_turn where call_id in (select id from voice_call where customer_id = $1)', [id]);
  await pool.query('delete from voice_call where customer_id = $1', [id]);
  await pool.query('delete from message where customer_id = $1', [id]);
  await pool.query('delete from customers where id = $1', [id]);
}

async function customerFor(phone) {
  const { rows } = await pool.query(`select * from customers where phone_number = $1 and channel = 'voice'`, [phone]);
  return rows[0];
}

async function main() {
  await seedSampleRestaurant();
  // Real deployments get this row the moment ERA flips the toggle (routes/
  // api.js's POST /voice-config) -- inserted directly here since this
  // script exercises the engine layer straight, not that HTTP route.
  await pool.query(
    `insert into voice_config (business_id, enabled) values ((select id from business limit 1), true) on conflict (business_id) do nothing`
  );

  console.log('=== Fixture 1: first-ever call, deterministic "thanks" turn ===');
  const phone1 = '2348040000001';
  await resetCustomer(phone1);
  const call1 = await startVoiceCall({ callerNumber: phone1 });
  const reply1 = await handleCallerUtterance(call1, 'thanks');

  await check('reply text is the deterministic thanks-ack, not empty/crashed', async () => {
    if (reply1 !== "You're welcome!") throw new Error(`expected "You're welcome!", got ${JSON.stringify(reply1)}`);
  });
  await check('a customer row was created on the voice channel, keyed by caller number', async () => {
    const customer = await customerFor(phone1);
    if (!customer) throw new Error('no customer row created');
    if (customer.phone_number !== phone1) throw new Error('phone_number mismatch');
  });
  await check('voice_call.customer_id got filled in after the first turn', async () => {
    const { rows } = await pool.query('select customer_id from voice_call where id = $1', [call1.id]);
    if (!rows[0]?.customer_id) throw new Error('customer_id still null after first turn');
  });
  await check('customers.last_voice_call_at was stamped on the first turn', async () => {
    const customer = await customerFor(phone1);
    if (!customer.last_voice_call_at) throw new Error('last_voice_call_at not set');
  });
  await check('no "welcome back" greeting on a genuinely first-ever call', async () => {
    if (reply1.startsWith('Welcome back')) throw new Error('greeted a first-time caller as if they were returning');
  });
  await check('both turns landed in call_turn, in order, with the right speakers', async () => {
    const { rows } = await pool.query('select speaker, transcript, seq from call_turn where call_id = $1 order by seq', [call1.id]);
    if (rows.length !== 2) throw new Error(`expected 2 call_turn rows, got ${rows.length}`);
    if (rows[0].speaker !== 'caller' || rows[0].transcript !== 'thanks') throw new Error(`bad caller turn: ${JSON.stringify(rows[0])}`);
    if (rows[1].speaker !== 'system' || rows[1].transcript !== "You're welcome!") throw new Error(`bad system turn: ${JSON.stringify(rows[1])}`);
  });

  console.log('\n=== Fixture 2: a plain ack ("ok") gets no reply at all, and that must not crash the call ===');
  const reply2 = await handleCallerUtterance(call1, 'ok');
  await check('empty reply text, no exception', async () => {
    if (reply2 !== '') throw new Error(`expected an empty reply for a pure ack, got ${JSON.stringify(reply2)}`);
  });
  await check('the ack turn was still logged even though there was nothing to say back', async () => {
    const { rows } = await pool.query(`select speaker, transcript from call_turn where call_id = $1 and transcript = 'ok'`, [call1.id]);
    if (!rows.length) throw new Error('ack turn was not logged to call_turn');
  });

  console.log('\n=== Fixture 3: a SECOND call from the same caller is greeted by name ===');
  await pool.query(`update customers set preferred_name = 'Chidera' where phone_number = $1 and channel = 'voice'`, [phone1]);
  const call2 = await startVoiceCall({ callerNumber: phone1 });
  const reply3 = await handleCallerUtterance(call2, 'thanks');
  await check('returning caller with a known name is greeted deterministically', async () => {
    if (reply3 !== "Welcome back, Chidera! You're welcome!") throw new Error(`expected a welcome-back prefix, got ${JSON.stringify(reply3)}`);
  });
  await check('the greeting itself was logged to message (voice channel), not just call_turn', async () => {
    const customer = await customerFor(phone1);
    const { rows } = await pool.query(
      `select body from message where customer_id = $1 and trigger = 'voice_welcome_back'`,
      [customer.id]
    );
    if (!rows.length) throw new Error('welcome-back greeting was not logged to message');
  });

  console.log('\n=== Fixture 4: a DIFFERENT, brand-new caller is never greeted by name ===');
  const phone2 = '2348040000002';
  await resetCustomer(phone2);
  const call3 = await startVoiceCall({ callerNumber: phone2 });
  const reply4 = await handleCallerUtterance(call3, 'thanks');
  await check('a genuinely new caller number gets the plain reply, no greeting', async () => {
    if (reply4 !== "You're welcome!") throw new Error(`expected no greeting for a new caller, got ${JSON.stringify(reply4)}`);
  });

  console.log('\n=== Fixture 5: two consecutive low-confidence turns hand over (A8 trigger 3) ===');
  await enableHandoverAlerts();
  const phone3 = '2348040000003';
  await resetCustomer(phone3);
  const call4 = await startVoiceCall({ callerNumber: phone3 });
  // First low-confidence turn: nothing special happens yet -- only the
  // SECOND consecutive one should trip the trigger. Deliberately a
  // deterministic ack/thanks phrase here (not real garbled speech) purely
  // so THIS turn doesn't need a reachable Claude API (no key in this
  // sandbox) -- it still exercises the real thing being tested, whether one
  // low-confidence turn alone escalates (it must not).
  await handleCallerUtterance(call4, 'thanks', 0.3);
  await check('a single low-confidence turn does not escalate yet', async () => {
    const { rows } = await pool.query(`select status from callback_task where call_id = $1`, [call4.id]);
    if (rows.length) throw new Error('escalated after only one low-confidence turn');
  });
  const r2 = await handleCallerUtterance(call4, 'more static mumble', 0.2);
  await check('a second consecutive low-confidence turn escalates', async () => {
    if (!r2.toLowerCase().includes('call') && !r2.toLowerCase().includes('someone')) {
      throw new Error(`expected a handover-style reply, got ${JSON.stringify(r2)}`);
    }
  });
  await check('a callback_task was created, with a real (fallback) context summary', async () => {
    const { rows } = await pool.query(`select * from callback_task where call_id = $1`, [call4.id]);
    if (rows.length !== 1) throw new Error(`expected exactly 1 callback_task, got ${rows.length}`);
    if (rows[0].reason !== 'Two consecutive low-confidence recognition turns') throw new Error(`unexpected reason: ${rows[0].reason}`);
    if (!rows[0].context_summary) throw new Error('context_summary is empty -- the no-API-key fallback should still fill it from the raw transcript');
    if (rows[0].status !== 'open') throw new Error(`expected status 'open', got ${rows[0].status}`);
  });
  await check('customers.handled_by flipped to staff for this caller', async () => {
    const customer = await customerFor(phone3);
    if (customer.handled_by !== 'staff') throw new Error(`expected handled_by = staff, got ${customer.handled_by}`);
  });

  console.log('\n=== Fixture 6: the callback surfaces in Needs Attention as its own kind, not a duplicate conversation row ===');
  await check('needs-attention query returns exactly one row for this caller, kind=callback', async () => {
    const { rows } = await pool.query(
      `select 'conversation' as kind, c.id, c.channel, c.handover_reason as reason, null::uuid as callback_task_id
       from customers c where c.handled_by = 'staff' and c.channel != 'voice'
       union all
       select 'callback' as kind, c.id, c.channel, ct.reason, ct.id as callback_task_id
       from callback_task ct join customers c on c.id = ct.customer_id where ct.status = 'open'`,
    );
    const caller3 = await customerFor(phone3);
    const forThisCaller = rows.filter((r) => r.id === caller3.id);
    if (forThisCaller.length !== 1) throw new Error(`expected exactly 1 needs-attention row, got ${forThisCaller.length}: ${JSON.stringify(forThisCaller)}`);
    if (forThisCaller[0].kind !== 'callback') throw new Error(`expected kind 'callback', got ${forThisCaller[0].kind}`);
  });

  console.log('\n=== Fixture 7: claim/resolve lifecycle on the callback_task ===');
  const { rows: taskRows } = await pool.query(`select id from callback_task where call_id = $1`, [call4.id]);
  const taskId = taskRows[0].id;
  await check('resolving an open callback works and sets resolved_at', async () => {
    const { rows: staffRows } = await pool.query(`select id from staff limit 1`);
    await pool.query(`update callback_task set status = 'in_progress', claimed_by = $1 where id = $2`, [staffRows[0].id, taskId]);
    const { rows } = await pool.query(`update callback_task set status = 'done', resolved_at = now() where id = $1 and status in ('open','in_progress') returning *`, [taskId]);
    if (!rows[0] || !rows[0].resolved_at) throw new Error('resolve did not set resolved_at');
  });
  await check('resolving it again is correctly a no-op (already resolved)', async () => {
    const { rows } = await pool.query(`update callback_task set status = 'done', resolved_at = now() where id = $1 and status in ('open','in_progress') returning *`, [taskId]);
    if (rows.length) throw new Error('re-resolved an already-resolved task -- should have matched zero rows');
  });

  console.log('\n=== Fixture 8: operating-hours logic (pure function, no DB) ===');
  await check('no hours configured means always open', async () => {
    if (!checkOperatingHours(null).open) throw new Error('expected always-open with no config');
  });
  await check('a plain daytime window correctly reports closed at 2am', async () => {
    const result = checkOperatingHours({ open: '09:00', close: '22:00' }, new Date('2026-01-01T01:00:00Z')); // 2am Lagos (UTC+1)
    if (result.open) throw new Error('expected closed at 2am for a 9am-10pm window');
    if (result.opensAt !== '9am') throw new Error(`expected opensAt '9am', got ${result.opensAt}`);
  });
  await check('the same window correctly reports open at noon', async () => {
    const result = checkOperatingHours({ open: '09:00', close: '22:00' }, new Date('2026-01-01T11:00:00Z')); // noon Lagos
    if (!result.open) throw new Error('expected open at noon for a 9am-10pm window');
  });
  await check('an overnight window (open 18:00, close 02:00) wraps past midnight correctly', async () => {
    const midnight = checkOperatingHours({ open: '18:00', close: '02:00' }, new Date('2026-01-01T23:30:00Z')); // 12:30am Lagos
    if (!midnight.open) throw new Error('expected open at 12:30am for an 18:00-02:00 overnight window');
    const midday = checkOperatingHours({ open: '18:00', close: '02:00' }, new Date('2026-01-01T11:00:00Z')); // noon Lagos
    if (midday.open) throw new Error('expected closed at noon for an 18:00-02:00 overnight window');
  });

  console.log('\n=== Fixture 9: a call while closed gets a callback, not fed to the order engine ===');
  // open === close is an always-closed window, chosen deliberately so this
  // test is correct no matter what real time it actually runs at.
  await pool.query(`update voice_config set operating_hours = '{"open":"00:00","close":"00:00"}'::jsonb`);
  const phone4 = '2348040000004';
  await resetCustomer(phone4);
  const call5 = await startVoiceCall({ callerNumber: phone4 });
  // Deliberately a real order-shaped sentence, not an ack -- if this somehow
  // reached the shared engine while "closed", it would need Claude and this
  // sandbox has none, so a wrongly-not-closed path here fails loudly.
  const reply5 = await handleCallerUtterance(call5, 'I would like to order jollof rice');
  await check('caller is told we are closed, no crash, no AI needed', async () => {
    if (!reply5.toLowerCase().includes("we're closed") && !reply5.toLowerCase().includes('closed right now')) {
      throw new Error(`expected a closed-hours reply, got ${JSON.stringify(reply5)}`);
    }
  });
  await check('a callback_task was created for the closed-hours call', async () => {
    const { rows } = await pool.query(`select * from callback_task where call_id = $1 and reason = 'Called outside operating hours'`, [call5.id]);
    if (rows.length !== 1) throw new Error(`expected exactly 1 callback_task, got ${rows.length}`);
  });
  await check('the caller is NOT marked handled_by staff -- a later in-hours call must still get the bot', async () => {
    const customer = await customerFor(phone4);
    if (customer.handled_by !== 'bot') throw new Error(`expected handled_by = bot, got ${customer.handled_by}`);
  });
  await handleCallerUtterance(call5, 'hello, still there?');
  await check('a second turn on the same closed call does not create a SECOND callback_task', async () => {
    const { rows } = await pool.query(`select * from callback_task where call_id = $1 and reason = 'Called outside operating hours'`, [call5.id]);
    if (rows.length !== 1) throw new Error(`expected still exactly 1 callback_task after a second turn, got ${rows.length}`);
  });
  await pool.query(`update voice_config set operating_hours = null`); // reset for any fixture that runs after this one

  console.log('\n=== Fixture 10: recording consent is stated once, on the first turn only ===');
  await pool.query(`update voice_config set recording_enabled = true`);
  const phone5 = '2348040000005';
  await resetCustomer(phone5);
  const call6 = await startVoiceCall({ callerNumber: phone5 });
  const reply6a = await handleCallerUtterance(call6, 'thanks');
  await check('first turn states the call may be recorded', async () => {
    if (!reply6a.toLowerCase().includes('may be recorded')) throw new Error(`expected a recording notice, got ${JSON.stringify(reply6a)}`);
  });
  const reply6b = await handleCallerUtterance(call6, 'thanks');
  await check('second turn of the SAME call does not repeat the recording notice', async () => {
    if (reply6b.toLowerCase().includes('may be recorded')) throw new Error(`recording notice repeated on a later turn: ${JSON.stringify(reply6b)}`);
  });
  await pool.query(`update voice_config set recording_enabled = false`);

  console.log('\n=== Fixture 11: dashboard queries (routes/voice.js) against real data ===');
  // PGlite is in-process/per-process, so this can't be a live HTTP round
  // trip against a separately-started server the way Stage 1/3's checks
  // were -- these are the exact same queries those routes run, against the
  // exact real data the fixtures above already created. Auth gating on
  // these routes is the same requireStaffApi/scopeToBranch middleware
  // already proven in Stage 1/3, not re-tested here.
  await check('/calls-shaped query returns real rows with customer names joined', async () => {
    const { rows } = await pool.query(
      `select vc.id, vc.caller_number, c.name as customer_name, vc.outcome
       from voice_call vc left join customers c on c.id = vc.customer_id
       where vc.caller_number = $1 order by vc.started_at desc`,
      [phone1]
    );
    if (!rows.length) throw new Error('expected at least one call for phone1');
  });
  await check('/calls/:id-shaped query returns turns in order', async () => {
    const { rows } = await pool.query(`select seq, speaker, transcript from call_turn where call_id = $1 order by seq`, [call1.id]);
    if (rows.length < 2) throw new Error(`expected at least 2 turns, got ${rows.length}`);
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].seq <= rows[i - 1].seq) throw new Error('turns are not strictly increasing by seq');
    }
  });
  await check('/usage-shaped query returns real, non-negative numbers', async () => {
    const { rows } = await pool.query(
      `select count(*) filter (where started_at >= date_trunc('month', now())) as calls_this_month,
              coalesce(sum(duration_seconds) filter (where started_at >= date_trunc('month', now())), 0) as seconds_this_month
       from voice_call`
    );
    const callsThisMonth = Number(rows[0].calls_this_month);
    if (callsThisMonth < 6) throw new Error(`expected at least 6 calls counted this month (from earlier fixtures), got ${callsThisMonth}`);
  });

  console.log(`\n${passed} checks passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
