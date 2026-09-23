// Chidera, 2026-09-23: "make the dashboard pwa so staff can get push
// notification or something... i need to reduce billable text all round to
// highest 1-5." Staff alerts (handover, order-ready, POS claims, etc.) now
// try a free push notification first (engine/push-notify.js's pushToStaff,
// wired through flow.js's new notifyStaff), falling back to the real
// WhatsApp send unchanged for anyone who hasn't set up push.
//
// This sandbox has no real VAPID keys or a live push endpoint to actually
// deliver to (same reasoning rider push was never sandbox-tested either --
// see engine/push-notify.js's own comment on VAPID being ERA-wide, not a
// per-business config this harness stands up). What's actually worth
// proving, and IS provable here: the fallback path is airtight -- every
// staff alert this feature touched must still reach staff for real when
// push genuinely isn't available, exactly as before this change, zero
// regression.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function main() {
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');
  const push = await import('../engine/push-notify.js');
  const { seedSampleRestaurant } = await import('./seed-sample-restaurant.mjs');

  // Same helper the full-server sandbox tests use -- a bare business row
  // fails business.type's not-null constraint on its own.
  await seedSampleRestaurant();

  const { rows: staffRows } = await pool.query(
    `insert into staff (name, phone_number, handover_alerts, order_alerts, role, branch_id)
     values ('Owner', '2348099991111', true, true, 'owner', null) returning *`
  );
  const staff = staffRows[0];

  assert(staff.push_subscription === null, 'a fresh staff row starts with no push subscription -- migration column present, defaults null');

  // === Without VAPID configured (this sandbox's default state, matching
  // every live business until Ops sets it up) -- pushToStaff must be a
  // safe no-op, never throw, never silently swallow the real alert. ===
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  const pushedNoVapid = await push.pushToStaff(staff.id, { title: 'Test', body: 'Test body' });
  assert(pushedNoVapid === false, 'pushToStaff safely returns false with no VAPID keys configured, never throws');

  // Even with a saved subscription, no VAPID configured still means no push --
  // proves the ensureConfigured() gate, not just "no subscription", is what's
  // actually being checked.
  await pool.query(`update staff set push_subscription = $1 where id = $2`, [
    JSON.stringify({ endpoint: 'https://example.invalid/fake', keys: { p256dh: 'x', auth: 'y' } }),
    staff.id,
  ]);
  const pushedWithSubNoVapid = await push.pushToStaff(staff.id, { title: 'Test', body: 'Test body' });
  assert(pushedWithSubNoVapid === false, 'a saved subscription alone is not enough -- still no push without VAPID keys, correctly falls back');

  // === notifyStaff (flow.js) -- the actual wiring every alert call site
  // (handover, completePayment, notifyCustomerClaimedPosPayment, etc.) now
  // goes through -- must still reach staff for real when push isn't
  // available. Called directly rather than through handover() itself,
  // which also summarises the conversation via a real Anthropic call with
  // no sandbox stub (same scope note every other web-chat sandbox test
  // makes) -- irrelevant to what this feature actually changed.
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); originalLog(...args); };
  await flow.notifyStaff({ staffId: staff.id, phoneNumber: staff.phone_number, title: 'Handover', body: 'Real body text' });
  console.log = originalLog;

  const realAlertWentOut = logs.some((l) => l.includes(staff.phone_number) && l.includes('Real body text'));
  assert(realAlertWentOut, 'notifyStaff still reaches staff over real WhatsApp with the real alert text -- push being unavailable never silently drops it');

  // === Chidera, 2026-09-23 (same day): "merge handover message to be 1
  // the full message and the dashboard button on the same message" -- a
  // link used to mean a SECOND separate real WhatsApp send (the button,
  // with a generic "Tap below to open this." line); now it's one combined
  // CTA-URL message whose own body IS the full alert. ===
  const staff2Rows = await pool.query(
    `insert into staff (name, phone_number, handover_alerts, order_alerts, role, branch_id)
     values ('Manager', '2348099992222', true, true, 'manager', null) returning *`
  );
  const staff2 = staff2Rows.rows[0];
  const logs2 = [];
  const originalLog2 = console.log;
  console.log = (...args) => { logs2.push(args.join(' ')); originalLog2(...args); };
  await flow.notifyStaff({
    staffId: staff2.id,
    phoneNumber: staff2.phone_number,
    title: 'Handover',
    body: 'A real handover alert with real details',
    linkUrl: 'http://localhost:9999/conversations/abc',
    linkButtonText: 'Open Conversation',
  });
  console.log = originalLog2;

  const relevantLogs = logs2.filter((l) => l.includes(staff2.phone_number));
  assert(relevantLogs.length === 1, `exactly ONE real WhatsApp send for an alert with a link, not two (got ${relevantLogs.length})`);
  assert(relevantLogs[0]?.includes('A real handover alert with real details'), 'that one message carries the FULL real alert text');
  assert(relevantLogs[0]?.includes('Open Conversation') && relevantLogs[0]?.includes('conversations/abc'), 'and the same message also carries the real tappable button, not a second one');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
