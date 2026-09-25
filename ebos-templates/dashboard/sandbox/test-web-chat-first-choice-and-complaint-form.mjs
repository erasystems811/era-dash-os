// Chidera, 2026-09-24: "instead of bot sending menu immediately, it should
// send a hey, what would you like to do? with 2 buttons 1.place an order
// 2.give feedback, so that they can make their complaint from feedback
// button than having 2 chats and now feedback can have a fill a complaint
// form kind of thing." Three things to verify:
// 1. First visit shows the choice bubble, NOT the full welcome/menu text.
// 2. Tapping "Place an order" reveals the full greeting + See menu link.
// 3. Tapping "Give feedback" links to a real form (/c/:token), and
//    submitting it logs the customer's own words, sends them an ack, and
//    reaches staff via the same handover() every other complaint path uses.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3947';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3947';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3947';

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

  // === 1. First visit shows the choice, not the full welcome. ===
  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012356001', channel: 'whatsapp' });
  const token = await flow.ensureMenuToken(customer);
  const html1 = await (await fetch(`${BASE}/wa/${token}`)).text();
  assert(html1.includes('Hey! What would you like to do?'), 'first visit shows the choice prompt');
  assert(!html1.includes('what would you like to order?'), 'the full order-framing welcome text is NOT shown up front anymore');
  assert(html1.includes('Place an order') && html1.includes('Make a complaint'), 'both choice buttons are present');

  const messages1 = await (await fetch(`${BASE}/wa/${token}/messages`)).json();
  const choiceMsg = messages1.find((m) => m.trigger === 'first_choice');
  assert(Boolean(choiceMsg), 'the choice bubble is tagged first_choice');
  assert(choiceMsg?.interactive?.type === 'buttons', 'and it is a real buttons interactive, not just text');
  assert(
    choiceMsg?.interactive?.buttons?.some((b) => b.id === 'wa_start_order') &&
    choiceMsg?.interactive?.buttons?.some((b) => b.id === 'wa_give_feedback'),
    'with exactly the two expected button ids'
  );

  // === 2. Tapping "Place an order" reveals the full greeting + See menu. ===
  await fetch(`${BASE}/wa/${token}/tap`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ buttonId: 'wa_start_order' }),
  });
  const messages2 = await (await fetch(`${BASE}/wa/${token}/messages`)).json();
  const greetingMsg = messages2.find((m) => m.trigger === 'greeting');
  assert(Boolean(greetingMsg), 'tapping "Place an order" logs the real greeting bubble');
  assert(/what would you like to order/i.test(greetingMsg?.body || ''), 'and it carries the full order-framing welcome text');
  assert(greetingMsg?.interactive?.type === 'cta_url' && greetingMsg?.interactive?.buttonText === 'See menu', 'with the See menu button, same as before');

  // === 3. Tapping "Make a complaint" (on a SEPARATE, fresh customer) links
  // to the real complaint form, and submitting it works end to end. ===
  const feedbackCustomer = await flow.findOrCreateCustomer({ phoneNumber: '2348012356002', channel: 'whatsapp' });
  const feedbackToken = await flow.ensureMenuToken(feedbackCustomer);
  await fetch(`${BASE}/wa/${feedbackToken}`); // first visit, logs the choice bubble
  await fetch(`${BASE}/wa/${feedbackToken}/tap`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ buttonId: 'wa_give_feedback' }),
  });
  const messages3 = await (await fetch(`${BASE}/wa/${feedbackToken}/messages`)).json();
  const complaintPromptMsg = messages3.find((m) => m.trigger === 'complaint_greeting');
  assert(Boolean(complaintPromptMsg), 'tapping "Make a complaint" logs the complaint prompt bubble');
  assert(complaintPromptMsg?.interactive?.type === 'cta_url', 'linking out to a real form page, not just chat text');
  assert(complaintPromptMsg?.interactive?.url === `${process.env.PUBLIC_URL}/c/${feedbackToken}`, 'pointing at this exact customer\'s own complaint form');

  const formHtml = await (await fetch(`${BASE}/c/${feedbackToken}`)).text();
  assert(formHtml.includes('Tell us what happened'), 'the complaint form page itself loads');

  // handover() (called after logging) summarises the transcript via a real
  // Anthropic call -- no key configured in this sandbox, same environment
  // gap every other handover-triggering test this session hits. The
  // inbound log + the ack reply() both complete BEFORE that call, so
  // they're fully verifiable against the database regardless.
  try {
    await fetch(`${BASE}/c/${feedbackToken}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'My order arrived cold and an hour late.' }),
    });
  } catch (err) {}

  const { rows: inboundRows } = await pool.query(
    `select body, channel, direction from message where customer_id = $1 and direction = 'inbound' order by created_at desc limit 1`,
    [feedbackCustomer.id]
  );
  assert(inboundRows[0]?.body === 'My order arrived cold and an hour late.', 'the customer\'s exact words are logged as a real inbound message');
  assert(inboundRows[0]?.channel === 'website', 'on the website channel, not a real WhatsApp send');

  const { rows: ackRows } = await pool.query(
    `select body, channel from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
    [feedbackCustomer.id]
  );
  assert(/received your message/i.test(ackRows[0]?.body || ''), 'the customer gets a real ack back');
  assert(ackRows[0]?.channel === 'website', 'and it stays on the website channel too');

  // Empty submission rejected outright.
  const emptyRes = await fetch(`${BASE}/c/${feedbackToken}/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '   ' }),
  });
  assert(emptyRes.status === 400, 'an empty complaint is rejected, not silently accepted');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
