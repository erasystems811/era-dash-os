// Chidera, 2026-09-22: "meta will start charging 14 naira per message on
// october first... i need the whole flow duplicated in a site... they were
// still texting a bot but instead theyll do it on the site." Verifies the
// real, end-to-end claim: after ONE real WhatsApp message (a link), the
// rest of an order -- menu hand-off, upsell, order-confirm, fulfilment,
// payment instructions, payment-confirmed -- happens as bubbles on
// /wa/:token at zero WhatsApp cost, and only ONE more real WhatsApp
// message ("ready for pickup") ever goes out.
//
// Note on scope: this engine's free-text turns (classifyIntent,
// extractOrderModifications, item extraction) call the real Anthropic API
// with no sandbox stub -- true of every channel already, not something
// this feature changed. Steps that would need a live API key are exercised
// by calling their flow.js functions directly (the actual new website
// branches this feature added) rather than typing text through the full
// AI-mediated dispatch pipeline; steps that are genuinely AI-free (a
// button tap with a dedicated handler, an upsell list tap, payment
// confirmation, the ready-for-pickup ping) are driven through the real
// HTTP routes, same as every other order-flow sandbox test in this repo.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3942';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3942';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3942';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function latestOutbound(pool, customerId, channel) {
  const { rows } = await pool.query(
    `select body, trigger, interactive from message where customer_id = $1 and direction = 'outbound' and channel = $2 order by created_at desc limit 1`,
    [customerId, channel]
  );
  return rows[0] || null;
}

async function countOutbound(pool, customerId, channel) {
  const { rows } = await pool.query(
    `select count(*) as n from message where customer_id = $1 and direction = 'outbound' and channel = $2`,
    [customerId, channel]
  );
  return Number(rows[0].n);
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  // === 1. The ONE real WhatsApp message -- a plain "hi" (deterministic, no AI call for a pure greeting) ===
  const phoneNumber = '2348011119999';
  await flow.handleInboundMessage({ phoneNumber, text: 'hi', channel: 'whatsapp', messageId: 'wa-m1' });
  await wait(flow.DEBOUNCE_MS + 1000);

  const customer = await flow.findOrCreateCustomer({ phoneNumber, channel: 'whatsapp' });
  assert(await countOutbound(pool, customer.id, 'whatsapp') === 1, 'exactly one real WhatsApp message sent for the first contact');
  const greetingMsg = await latestOutbound(pool, customer.id, 'whatsapp');
  assert(/tap below to get started/i.test(greetingMsg.body), 'the real WhatsApp message is the short greeting + CTA');
  assert(!/what would you like to order/i.test(greetingMsg.body), 'the FULL welcome text is NOT in the real WhatsApp message (moved to the chat page)');

  // === 2. GET /wa/:token -- Chidera, 2026-09-24: the first bubble is now a
  // deterministic choice ("Place an order" / "Give feedback"), not the
  // full welcome text up front. Tapping "Place an order" is what reveals
  // the FULL welcome + a "See menu" link out to /m/:token. ===
  const { rows: custRows } = await pool.query('select menu_token from customers where id = $1', [customer.id]);
  const token = custRows[0].menu_token;
  assert(Boolean(token), 'the real WhatsApp CTA already generated this customer a menu_token');

  const pageRes = await fetch(`${BASE}/wa/${token}`);
  assert(pageRes.status === 200, 'the chat page itself loads');
  const choiceBubble = await latestOutbound(pool, customer.id, 'website');
  assert(choiceBubble.trigger === 'first_choice', 'the first bubble is the deterministic order-vs-feedback choice, not the full welcome');

  await fetch(`${BASE}/wa/${token}/tap`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ buttonId: 'wa_start_order' }),
  });
  const firstBubble = await latestOutbound(pool, customer.id, 'website');
  assert(/what would you like to order/i.test(firstBubble.body), 'tapping "Place an order" reveals the FULL welcome text');
  assert(firstBubble.interactive?.type === 'cta_url' && /\/m\//.test(firstBubble.interactive.url), 'and it carries a real "See menu" link out to the existing shop page');

  // routes/web-chat.js flips this in memory (never the real DB row) before
  // calling into any flow.js function -- steps below call several of
  // those functions directly (see the file-header note on why), so this
  // mirrors that same flip by hand.
  customer.channel = 'website';

  // === 3. Build up an order (direct DB, same as every other payment-focused sandbox test in this repo -- classifyIntent's own free-text extraction needs a real Anthropic key this environment doesn't have, and isn't what this feature changed) ===
  const { rows: prodRows } = await pool.query(`select id, price from product where name = 'Jollof Rice and Chicken'`);
  const jollof = prodRows[0];
  const { rows: drinkRows } = await pool.query(
    `insert into product (name, description, price, availability_type, category) values ('Chapman', 'House cocktail, no alcohol', 1500, 'stock', 'Drinks') returning id, name, price`
  );
  const drink = drinkRows[0];
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state)
     values ($1, 'REF-WEBCHAT', 'pickup', $2, 'new', 'pending', 'collect_info') returning *`,
    [customer.id, jollof.price]
  );
  const order = orderRows[0];
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [order.id, jollof.id, jollof.price]);

  // === 4. Upsell list bubble + a real tap on it -- AI-free (a tap resolves a real row id, no classification) ===
  await pool.query(`update "order" set pending_upsell_category = 'drink' where id = $1`, [order.id]);
  await flow.sendUpsellList(customer, { key: 'drink', label: 'a drink', options: [drink] }, '');
  const upsellMsg = await latestOutbound(pool, customer.id, 'website');
  assert(upsellMsg.interactive?.type === 'list' && upsellMsg.interactive.rows.some((r) => r.id === `upsell::${drink.id}`), 'the upsell offer is a real tappable list bubble on the chat page');

  const tapRes = await fetch(`${BASE}/wa/${token}/tap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rowId: `upsell::${drink.id}` }) });
  assert(tapRes.status === 200, 'the upsell tap is accepted');
  const { rows: itemsAfterUpsell } = await pool.query(`select p.name from order_item oi join product p on p.id = oi.product_id where oi.order_id = $1`, [order.id]);
  assert(itemsAfterUpsell.some((i) => i.name === 'Chapman'), 'tapping the upsell row for real added the drink to the real order -- not just a UI effect');

  // === 5. Order-confirm buttons + a real tap on "No, change it" -- has its own dedicated handler, also AI-free ===
  await pool.query(`update "order" set engine_state = 'confirm_order', pending_upsell_category = null where id = $1`, [order.id]);
  await flow.sendConfirmButtons(customer, 'To confirm:\n1x Jollof Rice and Chicken\n1x Chapman\nTotal: NGN 6000', 'order_confirm_asked');
  const confirmMsg = await latestOutbound(pool, customer.id, 'website');
  assert(confirmMsg.interactive?.type === 'buttons' && confirmMsg.interactive.buttons.some((b) => b.id === 'order_confirm_yes') && confirmMsg.interactive.buttons.some((b) => b.id === 'order_confirm_no'), 'the real order-confirm Yes/No buttons render as a website bubble, not real WhatsApp buttons');

  const noTapRes = await fetch(`${BASE}/wa/${token}/tap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ buttonId: 'order_confirm_no' }) });
  assert(noTapRes.status === 200, 'the "No, change it" tap is accepted');
  const noTapMsg = await latestOutbound(pool, customer.id, 'website');
  assert(noTapMsg.interactive?.type === 'cta_url', '"No, change it" hands off to the shop page to actually change the order, as a bubble, not a real send');

  // === 6. Fulfilment buttons + payment instructions -- the new website branches this feature actually added ===
  await pool.query(`update "order" set fulfilment_type = 'pickup' where id = $1`, [order.id]);
  await flow.sendFieldPrompt(customer, 'fulfilment_type', 'Would you like delivery or pickup?', 'field_prompt');
  const fulfilmentMsg = await latestOutbound(pool, customer.id, 'website');
  assert(fulfilmentMsg.interactive?.type === 'buttons' && fulfilmentMsg.interactive.buttons.some((b) => b.id === 'fulfilment_pickup'), 'delivery/pickup renders as tappable website buttons, same shape as the real WhatsApp ones');

  await pool.query(`update "order" set engine_state = 'confirm_payment' where id = $1`, [order.id]);
  await flow.sendPaymentInstructions(customer, order);
  const { rows: paymentMsgs } = await pool.query(
    `select body, trigger, interactive from message where customer_id = $1 and direction = 'outbound' and channel = 'website' order by created_at desc limit 2`,
    [customer.id]
  );
  const invoiceMsg = paymentMsgs.find((m) => m.trigger === 'invoice_pdf' && m.interactive?.type === 'document');
  assert(invoiceMsg, 'the invoice is a document-link bubble, not a real WhatsApp document send');
  // Found live, 2026-09-23: this bubble's url used to point at the /pdf
  // route (Gotenberg-backed, internal-docker-only, never reachable from a
  // customer's own browser) while marking itself "sent" without ever
  // actually rendering anything -- the button looked right and failed the
  // moment a customer tapped it. A shape-only assertion above wouldn't have
  // caught that; this fetches the real link the button points to.
  const invoiceLinkRes = await fetch(invoiceMsg.interactive.url);
  assert(invoiceLinkRes.status === 200, `the invoice link the customer would actually tap must resolve (got ${invoiceLinkRes.status} for ${invoiceMsg.interactive.url})`);
  assert(!/\/pdf$/.test(invoiceMsg.interactive.url), 'website invoice bubble must link to the plain HTML invoice page, not the Gotenberg-only /pdf route');
  assert(paymentMsgs.some((m) => /GTBank/i.test(m.body)), 'payment instructions (bank details -- this sandbox has no Paystack/POS configured) land as a website bubble');
  assert(await countOutbound(pool, customer.id, 'whatsapp') === 1, 'still exactly one real WhatsApp message all the way through payment instructions');

  // === 7. Payment confirmed (e.g. Paystack's webhook calling completePayment with no live customer object) -- lands as a bubble, not a real send ===
  await pool.query('update customers set web_chat_active_at = now() where id = $1', [customer.id]);
  await flow.completePayment(order.id);
  const afterPayment = await latestOutbound(pool, customer.id, 'website');
  assert(/receipt|payment received/i.test(afterPayment.body), 'completePayment lands as a website bubble for a customer whose most recent turn was on the chat page');
  assert(await countOutbound(pool, customer.id, 'whatsapp') === 1, 'payment confirmation added ZERO real WhatsApp messages');

  const { rows: finalOrder } = await pool.query(`select * from "order" where id = $1`, [order.id]);
  assert(finalOrder[0].status === 'preparation' && finalOrder[0].engine_state === 'fulfilment', 'the real order state advanced exactly as the WhatsApp path would (status/engine_state), not just a chat-visible effect');

  // === 8. The one intentional real second WhatsApp message -- "ready for pickup" ===
  await flow.notifyReadyForPickup(order.id);
  assert(await countOutbound(pool, customer.id, 'whatsapp') === 2, 'notifyReadyForPickup is the one deliberate second real WhatsApp send');
  const readyMsg = await latestOutbound(pool, customer.id, 'whatsapp');
  assert(/ready for pickup/i.test(readyMsg.body), 'and it says what it should');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
