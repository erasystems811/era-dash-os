// Chidera, 2026-09-23: "i need customer complaint and all those in the site
// as well... a site they are given where they can chat there too, to lay
// their complaints... i have to reduce billable text all round to highest
// 1-5." Before this, a customer with no active order who asked for a
// person or whose message classified as a complaint got a full handover()
// immediately -- staff alerted with nothing but "customer asked for a
// person", no actual complaint yet, and a real WhatsApp send spent doing
// it. Now they get ONE short link to the SAME /wa/:token chat page the
// ordering flow already uses (no new page/template), where they can
// actually type out what happened for free; that free-text turn re-runs
// the real classifyIntent path and fires the genuine handover from there,
// with their real words.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3935';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3935';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3935';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  await pool.query(`insert into staff (name, phone_number, handover_alerts, order_alerts, role) values ('Owner', '2348099990004', true, true, 'owner')`);

  // === sendComplaintLink -- ONE real message, a link, no handover() (and
  // so no staff alert) fired yet -- the customer hasn't said what's wrong.
  const complainant = await flow.findOrCreateCustomer({ phoneNumber: '2348012345001', channel: 'whatsapp' });
  await flow.sendComplaintLink(complainant);

  const { rows: sentMsgs } = await pool.query(
    `select body, trigger, channel from message where customer_id = $1 and direction = 'outbound' order by created_at`,
    [complainant.id]
  );
  assert(sentMsgs.length === 1, 'exactly one message sent -- a link, not a full handover conversation yet');
  assert(sentMsgs[0].channel === 'whatsapp', 'the redirect link itself is still one real WhatsApp send (the unavoidable first-contact message)');
  assert(sentMsgs[0].trigger === 'complaint_redirect', 'tagged as the complaint redirect, not a generic reply');
  assert(/tell us what happened/i.test(sentMsgs[0].body), 'asks them to tell us what happened, not a bare link with no context');

  const { rows: customerAfter } = await pool.query(`select handled_by from customers where id = $1`, [complainant.id]);
  assert(customerAfter[0].handled_by !== 'staff', 'not yet marked as a staff handover -- that only happens once they actually say what\'s wrong');

  // === The link itself: ?ctx=complaint changes the FIRST bubble a brand-new
  // visit sees, since a returning-order customer's link never carries it.
  const token = await flow.ensureMenuToken(complainant);
  const pageRes = await fetch(`${BASE}/wa/${token}?ctx=complaint`);
  assert(pageRes.status === 200, 'the chat page loads via the complaint link');
  const html = await pageRes.text();
  assert(/Sorry to hear that/i.test(html), 'first bubble acknowledges the complaint, not "what would you like to order?"');
  assert(!/what would you like to order/i.test(html), 'the normal ordering greeting is NOT shown on a complaint-context first visit');

  // === A DIFFERENT, brand-new customer visiting the plain /wa/:token link
  // (no ?ctx=complaint -- the normal ordering entry point) still gets the
  // ordinary greeting, unaffected. ===
  const orderer = await flow.findOrCreateCustomer({ phoneNumber: '2348012345002', channel: 'whatsapp' });
  const ordererToken = await flow.ensureMenuToken(orderer);
  const orderPageHtml = await (await fetch(`${BASE}/wa/${ordererToken}`)).text();
  assert(/what would you like to order/i.test(orderPageHtml), 'the normal ordering flow\'s greeting is completely unchanged');

  // === Once they actually type the real complaint (simulated directly via
  // handover(), the exact function that free-text turn would reach through
  // classifyIntent) -- the customer's own ack lands as a website bubble,
  // not a second real WhatsApp send. handover() marks the handover and
  // sends this ack BEFORE it ever summarises the transcript via a real
  // Anthropic call (askText, no sandbox stub, same "zero-AI test path"
  // scope every other sandbox test in this repo already carves out --
  // see test-postpayment-fulfilment-switch.mjs's identical try/catch) --
  // both are provable here; the actual staff alert (which needs that
  // summary first) genuinely can't fire without a real API key, so it's
  // not asserted here -- already proven staff-reachable by
  // test-staff-push-notify.mjs's own notifyStaff checks.
  try {
    await flow.handover({ ...complainant, channel: 'website' }, 'Customer message classified as a complaint');
  } catch (err) {
    if (!/Anthropic API|x-api-key/i.test(err.message)) throw err;
  }

  const { rows: afterHandoverMsgs } = await pool.query(
    `select channel, trigger from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
    [complainant.id]
  );
  assert(afterHandoverMsgs[0]?.channel === 'website', 'the real complaint\'s ack lands as a free website bubble once they\'re on the chat page');

  const { rows: finalCustomer } = await pool.query(`select handled_by, handover_reason from customers where id = $1`, [complainant.id]);
  assert(finalCustomer[0].handled_by === 'staff', 'now correctly marked as a real staff handover, with the real complaint reason');
  assert(finalCustomer[0].handover_reason === 'Customer message classified as a complaint', 'the real complaint reason, not the earlier placeholder redirect');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
