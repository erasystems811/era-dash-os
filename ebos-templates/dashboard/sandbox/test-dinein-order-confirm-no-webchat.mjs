// Chidera, 2026-09-25, real report: "wheni tapped no change it right now
// it sent me a mere text link not the actual menu in a dine in flow, the
// main menu leaked into bare chat" and then "why is no change it sending
// me 2 response too." Root cause, confirmed by reading: sendWebMenuLink's
// dine-in branch only special-cased Instagram before falling through to a
// real sendWhatsAppCtaUrl send -- a website-channel dine-in customer got
// BOTH a genuine WhatsApp push (the "mere text link... leaked into bare
// chat") AND a second, separate website bubble from the logMessage marker
// row right after it (the "2 responses"). handleOrderConfirmNoTap had its
// own hand-rolled duplicate of the exact same bug, now removed in favor of
// just calling the (now fixed) sendWebMenuLink. This test drives the real
// POST /wa/:token/tap route (routes/web-chat.js), same as a real "No,
// change it" tap on the dine-in web chat.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3964';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3964';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3964';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function countOutbound(pool, customerId, channel) {
  const { rows } = await pool.query(
    `select count(*)::int as n from message where customer_id = $1 and direction = 'outbound' and channel = $2`,
    [customerId, channel]
  );
  return rows[0].n;
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  const { rows: bizRows } = await pool.query(`select id from business limit 1`);
  await pool.query(
    `insert into dinein_config (business_id, enabled) values ($1, true)
     on conflict (business_id) do update set enabled = true`,
    [bizRows[0].id]
  );
  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length
    ? existingBranch[0].id
    : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;
  const { rows: tableRows } = await pool.query(
    `insert into restaurant_table (branch_id, label, qr_token) values ($1, '12', 'qrnochange12') returning id`,
    [branchId]
  );
  const table = tableRows[0];
  const { rows: prodRows } = await pool.query(
    `insert into product (name, description, price, category, branch_id) values ('Jollof Rice', 'smoky', 3500, 'MAINS', $1) returning id`,
    [branchId]
  );
  const productId = prodRows[0].id;

  // Real table scan -- one real WhatsApp message, same as every other
  // first contact.
  await flow.handleInboundMessage({ phoneNumber: '2348013370012', text: 'Menu Table 12', channel: 'whatsapp', messageId: 'nc1', branchId });
  await wait(flow.DEBOUNCE_MS + 1000);
  const { rows: custRows } = await pool.query(`select * from customers where phone_number = $1`, ['2348013370012']);
  const customer = custRows[0];
  const token = customer.menu_token;
  assert(await countOutbound(pool, customer.id, 'whatsapp') === 1, 'the table scan produced exactly one real WhatsApp message');

  // Load the dine-in web chat, then submit an order through the real
  // /t/:qrToken/review route so a genuine dine-in order (channel='dinein')
  // exists tied to this same customer.
  await fetch(`${BASE}/wa/${token}`);
  await fetch(`${BASE}/t/qrnochange12/review?g=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ productId, quantity: 1 }] }),
  });
  const { rows: orderRows } = await pool.query(`select * from "order" where table_id = $1 order by created_at desc limit 1`, [table.id]);
  const order = orderRows[0];
  assert(order.channel === 'dinein', 'a real dine-in order now exists for this customer');

  const whatsappBefore = await countOutbound(pool, customer.id, 'whatsapp');
  const websiteBefore = await countOutbound(pool, customer.id, 'website');

  // === THE ACTUAL BUG: tap "No, change it" on the dine-in web chat. ===
  const tapRes = await fetch(`${BASE}/wa/${token}/tap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ buttonId: 'order_confirm_no' }),
  });
  assert(tapRes.status === 200, 'the "No, change it" tap is accepted');

  assert(await countOutbound(pool, customer.id, 'whatsapp') === whatsappBefore, 'no real WhatsApp message was sent -- the leak is fixed');
  const websiteAfter = await countOutbound(pool, customer.id, 'website');
  assert(websiteAfter === websiteBefore + 1, `exactly one new website bubble was produced, not two (before=${websiteBefore}, after=${websiteAfter})`);

  const { rows: bubbleRows } = await pool.query(
    `select body, trigger, interactive from message where customer_id = $1 and direction = 'outbound' and channel = 'website' order by created_at desc limit 1`,
    [customer.id]
  );
  const bubble = bubbleRows[0];
  assert(/No problem/.test(bubble.body), 'the bubble carries the real "No, change it" message text');
  assert(bubble.interactive?.type === 'cta_url' && bubble.interactive.url.includes('/t/qrnochange12'), 'and its button links to the table\'s own dine-in menu page, not a bare text link');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
