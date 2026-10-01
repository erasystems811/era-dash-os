// The dine-in add-on (EBOS-Addon-Schema-Dine-In.md) -- split out of
// flow.js 2026-10-01 as the third phase of breaking up that file's 6800+
// lines into focused pieces (see sweeps.js and voice-turn.js for the
// first two). Everything here is table-session/QR-scan/POS-payment
// specific; flow.js re-exports every name below so no existing import
// site (routes/dinein.js, routes/dinein-menu.js, routes/web-chat.js,
// engine/webhook-moniepoint.js, this file's own test coverage) had to
// change. handleDineinScan is imported back into flow.js since
// handlePendingBatch's own dispatch calls it directly.
import { randomBytes } from 'node:crypto';
import { pool } from '../lib/db.js';
import { getWhatsAppCredentials } from './branch-channel.js';
import { sendWhatsAppCtaUrl } from './whatsapp-send.js';
import {
  newReference,
  findSpecialsCategory,
  sendStartOrderLink,
  reply,
  findOrCreateCustomer,
  logMessage,
  ensureMenuToken,
  recipientFor,
  orderAlertRecipients,
  notifyStaff,
  summariseOrder,
  needsChatRedirect,
  sendChatRedirectPing,
  completePayment,
  sendFeedbackRequest,
} from './flow.js';

// Dine-in add-on (EBOS-Addon-Schema-Dine-In.md), Stage 2. A guest's QR scan
// always sends exactly "Menu Table {label}(send this to proceed)"
// (routes/dinein.js's qrDataUrlFor) -- deterministic, no AI call. Returns
// true when this handled the message (a real scan, or the answer to "which table"),
// false to let normal routing continue untouched. Off entirely when the
// add-on isn't enabled -- one cheap query, then nothing else runs.
async function getDineinConfig() {
  const { rows } = await pool.query('select * from dinein_config limit 1');
  return rows[0] || null;
}

// Joint dine-in, Stage 1 (fancy-whistling-pearl.md): records itself the
// first time each guest actually interacts with the table -- a scan, or
// the shared web page loading for them -- rather than a roster anyone has
// to explicitly join. Exported for routes/dinein-menu.js (the shared page
// itself) as well as this file's own scan handling below.
export async function upsertTableGuest(sessionId, customerId) {
  await pool.query(
    `insert into table_session_guest (session_id, customer_id) values ($1, $2) on conflict (session_id, customer_id) do nothing`,
    [sessionId, customerId]
  );
}

// The ONE shared order for a table's current sitting, regardless of which
// guest is asking -- replaces the old getOpenOrder(customerId) on the
// dine-in web routes, which always resolved back to whoever's customer
// row the caller happened to pass in, not "the table's order." Order
// ownership (order.customer_id) still stays the session's own original
// scanner -- every existing single-customer assumption elsewhere (
// receipts, feedback requests, the fulfilment status line) keeps working
// unchanged; only line-level attribution is per-guest (order_item.
// added_by_customer_id, set by the caller after this returns).
// status not in ('completed', 'cancelled'), not status = 'new' -- Stage 2
// (fancy-whistling-pearl.md): "they can also add to the order already
// served and the waiter will get add on order notification... the bill
// can pile up as conclusive," Chidera's own words for the joint dine-in
// concept. A table reopening the web menu after being served (or even
// after confirming, before serving) adds onto the SAME still-open bill,
// not a second separate kitchen ticket -- matches the broader definition
// getOpenOrder already uses for the chat-typed add path (engine_state not
// in completed/cancelled), which is how applyOrderModifications' own
// served_at reset could already reach a served order even before this
// existed; this brings the web path in line with it, not a new rule.
export async function getOrCreateTableOrder(session, table, customer) {
  await upsertTableGuest(session.id, customer.id);
  const { rows } = await pool.query(
    `select * from "order" where session_id = $1 and status not in ('completed', 'cancelled') order by created_at desc limit 1`,
    [session.id]
  );
  if (rows[0]) return rows[0];
  const ref = newReference('ORD');
  const { rows: created } = await pool.query(
    `insert into "order" (customer_id, reference, branch_id, channel, table_id, session_id, fulfilment_type, payment_mode, engine_state, status)
     values ($1, $2, $3, 'dinein', $4, $5, 'table', 'at_table', 'collect_info', 'new') returning *`,
    [session.customer_id, ref, table.branch_id, table.id, session.id]
  );
  return created[0];
}

// Chidera, 2026-09-24: "now we need dine in to go through web chat too."
// Content only (no send) -- routes/web-chat.js's own dine-in branch builds
// the actual bubble (menu link, specials line), same split
// buildGreetingContent/sendOrderGreeting already use for the online flow.
// joiningActiveTable -- Chidera, joint dine-in concept: "is it possible
// that when a persons scans a qr for a table let everyone on that table be
// able to join in and see each other". A guest joining a table that
// already has another guest's order open gets told there's something to
// join, not the same first-timer "what would you like to do".
export async function buildDineinGreetingContent(customer, session, { joiningActiveTable = false } = {}) {
  const { rows: bizRows } = await pool.query('select name from business limit 1');
  const biz = bizRows[0];
  const body = joiningActiveTable
    ? `Welcome to ${biz?.name || 'us'}! Table ${session.table_label} has an active order -- add to it, or see what's already been ordered.`
    : `Welcome to ${biz?.name || 'us'}! You're at Table ${session.table_label}. What would you like to do?`;
  // Chidera, 2026-09-20, real report: "there is no special currently on
  // menu so why is today specials button still showing" -- only surfaced
  // when a real special actually exists right now, same as the general
  // greeting's own logic already does.
  const specialsCategory = await findSpecialsCategory(customer.branch_id);
  return { body, specialsCategory };
}

export async function handleDineinScan(customer, text) {
  const dinein = await getDineinConfig();
  if (!dinein?.enabled) return false;

  const scanMatch = /^menu\s+table\s+(.+)$/i.exec(text.trim());
  let label = scanMatch?.[1]?.trim();
  // Chidera, 2026-09-25: "menu table 1(send this to proceed)" -- the QR's
  // own prefilled text (routes/dinein.js's qrDataUrlFor) now carries this
  // parenthetical so it's obvious a tap on Send is still needed. Stripped
  // back off here, generically (any trailing "(...)"), so the real table
  // label match below still sees a bare "1", same as before this change.
  if (label) label = label.replace(/\s*\([^)]*\)\s*$/, '').trim();

  if (!label) {
    // Not a fresh scan -- only worth a second look if the LAST thing the
    // bot said was "which table are you at" (spec 2.2: ask once, then
    // carry on). Anything else falls through to normal routing untouched.
    const { rows } = await pool.query(
      `select 1 from message where customer_id = $1 and trigger = 'dinein_ask_table' and created_at > now() - interval '10 minutes'
       order by created_at desc limit 1`,
      [customer.id]
    );
    if (!rows.length) return false;
    label = text.trim();
  }

  // trim(label) -- routes/dinein.js's POST /tables now trims on save, but
  // this stays defensive against any table saved before that fix (found
  // live, 2026-09-11: "it sint recognizinf the table" -- two of era-demo's
  // own tables had a stray leading space in their stored label, which
  // \s+ above strips out of the scanned text but never out of the stored
  // value, so an exact match against the untrimmed label failed forever).
  //
  // $1::uuid is null or branch_id = $1 -- Chidera, 2026-09-20, real
  // report: "why does it still ask me what table am i on" even scanning a
  // real, correctly-labelled QR. Root cause, confirmed against era-demo's
  // real data: this was a strict branch_id = $1 match, and
  // customer.branch_id is null for era-demo's real customers (no
  // branch_channel mapping to resolve one from -- the exact same class of
  // bug already fixed today in menuForBranch/resolveMenu). NULL never
  // equals anything in SQL, so this could never find ANY table for those
  // customers, no matter how correct their scan was -- every real "Menu
  // Table 1" landed here and fell straight to "Please, what table are you
  // at?" This was never a QR-stability problem; the qr_token (and the
  // label it encodes) were already fixed and correct the whole time.
  const { rows: tableRows } = await pool.query(
    `select * from restaurant_table where ($1::uuid is null or branch_id = $1) and lower(trim(label)) = lower($2) and status = 'active'`,
    [customer.branch_id, label]
  );
  const table = tableRows[0];
  if (!table) {
    await reply(customer, 'Please, what table are you at?', 'dinein_ask_table');
    return true;
  }

  // Most recent open session for this table, or a fresh one -- per spec
  // 6.4, a second party on the same table later is a new session, but
  // this guest re-scanning (or WhatsApp redelivering) mid-meal must not
  // open a duplicate (table_session_one_open_idx enforces this at the DB
  // level too, this is just avoiding hitting that constraint at all).
  const { rows: sessionRows } = await pool.query(`select * from table_session where table_id = $1 and closed_at is null`, [table.id]);
  let session = sessionRows[0];
  if (!session) {
    const { rows: created } = await pool.query(
      `insert into table_session (table_id, branch_id, customer_id) values ($1, $2, $3) returning *`,
      [table.id, table.branch_id, customer.id]
    );
    session = created[0];
  }
  // A second (or third...) guest scanning the same table's own code, not
  // the original opener, still needs table_session_guest -- joint dine-in,
  // Stage 1 -- so currentDineinSession/the shared chat page recognize them
  // from here on, same as the original scanner already could via
  // session.customer_id. routes/web-chat.js's own first-load render
  // re-derives "joining an active table" vs "the original scanner" the
  // same way (session.customer_id !== customer.id) when it renders the
  // actual welcome bubble -- no need to compute or pass it through here.
  await upsertTableGuest(session.id, customer.id);

  // Chidera, 2026-09-24: "now we need dine in to go through web chat too
  // ... study how it works and the best way it can go through web chat and
  // bare chat to reduce my cost." Used to be its own 2-step real send
  // (sendDineinWelcome's buttons message, THEN handleDineinButtonTap's
  // separate menu-link message once tapped) -- now the exact same single
  // real message every other first contact gets (sendStartOrderLink). The
  // real dine-in welcome (table label, "join an active order" wording,
  // the actual menu link) becomes the free first bubble on /wa/:token
  // instead (routes/web-chat.js's own dine-in branch).
  // Chidera, 2026-09-25 (live report): "i just realized in dine in that
  // served you can pay now is inside web and they may not see it" --
  // rescanning the QR is this guest's only way back once they've closed
  // the web chat tab; if their own real "ready to pay" bubble
  // (notifyGuestsReadyToPay) is already sitting there, the one real
  // WhatsApp message this scan produces should say so, not the generic
  // "get started" line a first-timer with nothing to pay yet still gets.
  const { rows: readyToPayRows } = await pool.query(
    `select 1 from "order" where session_id = $1 and served_at is not null and status not in ('completed', 'cancelled') limit 1`,
    [session.id]
  );
  await sendStartOrderLink(customer, { dineinTableLabel: table.label, dineinQrToken: table.qr_token, readyToPay: readyToPayRows.length > 0 });
  return true;
}

// The 3 welcome-card buttons (see sendDineinWelcome) -- resolved by the
// customer's own most recent open table_session, not re-parsed from
// anything in the tap itself (a button tap carries no table info of its
// own, unlike the scan message).
//
// Also matches via table_session_guest, not just ts.customer_id -- Stage 1
// of the joint dine-in plan (fancy-whistling-pearl.md): a second guest at
// the same table never opens the session, they join one already open, so
// ts.customer_id alone (only ever the FIRST scanner) left every other
// guest's own button taps with "please scan your table's QR code to get
// started" even though they very much had.
// Chidera, 2026-09-24: "now we need dine in to go through web chat too."
// Exported for routes/web-chat.js's own first-load render -- same reason
// getOpenOrder/buildGreetingContent are exported, so it can tell a dine-in
// guest's first visit apart from a normal online one without a second,
// parallel way of answering "is this customer at a table right now".
export async function currentDineinSession(customer) {
  const { rows } = await pool.query(
    `select ts.*, rt.label as table_label, rt.qr_token
     from table_session ts join restaurant_table rt on rt.id = ts.table_id
     where ts.closed_at is null
       and (ts.customer_id = $1 or exists (select 1 from table_session_guest g where g.session_id = ts.id and g.customer_id = $1))
     order by ts.opened_at desc limit 1`,
    [customer.id]
  );
  return rows[0] || null;
}

export async function handleDineinButtonTap({ phoneNumber, channelId, buttonId, channel = 'whatsapp', branchId }) {
  const customer = await findOrCreateCustomer({ phoneNumber, channelId, channel, branchId });
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'inbound', channel, sender: 'customer', body: `[tapped: ${buttonId}]` , processed: true });

  const session = await currentDineinSession(customer);
  if (!session) {
    await reply(customer, 'Please scan your table\'s QR code to get started.', 'dinein_no_session');
    return;
  }

  // 'dinein_specials' opens the same live menu page, pre-scrolled to the
  // specials category (?cat=, same mechanism as the general greeting's
  // "Special offers" button) when the catalogue actually has one -- no
  // longer identical to 'dinein_menu' now that specials are a real,
  // findable category (findSpecialsCategory) rather than an unmodeled
  // concept.
  if (!process.env.PUBLIC_URL) {
    await reply(customer, 'Sorry, the menu link is not set up right now -- please ask a waiter.', 'dinein_menu_unavailable');
    return;
  }
  const specialsCategory = buttonId === 'dinein_specials' ? await findSpecialsCategory(customer.branch_id) : null;
  // g=<menu_token> -- joint dine-in, Stage 1: every guest at the table
  // gets the SAME qrToken (it identifies the table, not them), so this is
  // the only thing that lets the shared page tell which guest is actually
  // looking at it right now -- reuses the existing per-customer menu_token
  // (ensureMenuToken) rather than inventing a second kind of token.
  const guestToken = await ensureMenuToken(customer);
  const params = new URLSearchParams();
  if (specialsCategory) params.set('cat', specialsCategory);
  params.set('g', guestToken);
  const url = `${process.env.PUBLIC_URL}/t/${session.qr_token}?${params.toString()}`;
  const bodyText = buttonId === 'dinein_specials' ? `Here's today's specials for Table ${session.table_label}.` : `Here's our menu for Table ${session.table_label}.`;
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  await sendWhatsAppCtaUrl(recipientFor(customer), bodyText, buttonId === 'dinein_specials' ? 'See specials' : 'View menu', url, credentials);
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel, sender: 'bot', body: `[menu link sent: ${url}]`, trigger: 'dinein_menu_sent' });
}

// Whether every order in a table_session is settled -- the single source
// of truth for "can this table close", shared between the manual
// Close-table button (routes/dinein.js) and closeTableSessionIfSettled's
// automatic trigger below (both the manual "Mark paid" path in
// routes/api.js and, joint dine-in Stage 3, a POS transaction
// auto-confirming an order_payment).
async function sessionIsSettled(sessionId) {
  const { rows } = await pool.query(
    `select count(*) from "order" where session_id = $1 and status not in ('completed', 'cancelled')`,
    [sessionId]
  );
  return Number(rows[0].count) === 0;
}

// Closes an open table_session if -- and only if -- every order in it is
// settled; a no-op (returns null) otherwise. closedBy distinguishes who
// actually closed it ('staff' for the manual button, 'auto' for an
// automatic trigger -- either the last order being marked paid, or Stage
// 3's own POS auto-confirm) -- both valid per schema.sql's check
// constraint on table_session.closed_by. Moved here from routes/dinein.js
// (Stage 3) so engine/webhook-moniepoint.js -- which has no HTTP request/
// staff session of its own to route through -- can call it directly,
// same layer completePayment/completeTopupPayment already live in.
export async function closeTableSessionIfSettled(sessionId, { closedBy, staffId = null } = {}) {
  if (!(await sessionIsSettled(sessionId))) return null;
  const { rows } = await pool.query(
    `update table_session set closed_at = now(), closed_by = $1, closed_by_staff = $2
     where id = $3 and closed_at is null returning *`,
    [closedBy, staffId, sessionId]
  );
  return rows[0] || null;
}

// Joint dine-in, Stage 3: "they can choose pay together or split payment
// so each pay their own but its like a table open order, and they can
// pick whose bill too can be joint." guestIds is who this particular
// group is paying for (always includes the tapping guest themselves,
// validated by the caller against table_session_guest same as every
// other guest-claim in this file) -- covers_item_ids is every order_item
// any of those guests added. null (not an array) specifically means
// "every guest who has anything on the order is included," matching
// schema.sql's own "null = whole order" convention, so a single
// confirmed payment with covers_item_ids null is recognized as full
// settlement without needing every item id spelled out.
//
// Reuses an existing PENDING payment for the exact same guest set instead
// of creating a new one each time the pay page reloads -- a guest
// refreshing (or two guests on the same phone somehow both landing here)
// must not spawn duplicate POS amounts waiting to be matched.
export async function createOrderPayment(order, guestIds, actingCustomerId) {
  const { rows: allItems } = await pool.query('select id, product_id, quantity, price, added_by_customer_id from order_item where order_id = $1', [order.id]);
  const { rows: allGuestRows } = await pool.query(
    `select customer_id from table_session_guest where session_id = $1
     union select customer_id from table_session where id = $1`,
    [order.session_id]
  );
  const allGuestIds = allGuestRows.map((g) => g.customer_id);
  const wholeOrder = allGuestIds.length > 0 && allGuestIds.every((id) => guestIds.includes(id));

  const coveredItems = wholeOrder ? allItems : allItems.filter((i) => guestIds.includes(i.added_by_customer_id));
  const amount = coveredItems.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0);
  const coversItemIds = wholeOrder ? null : coveredItems.map((i) => i.id);

  // Same-shape existing pending payment -- exact same coverage, still
  // pending -- gets reused rather than duplicated. Array comparison via a
  // sorted-JSON string is enough here (small arrays, no real risk of a
  // false match) -- null vs null (whole order) also matches correctly
  // since both stringify the same way.
  const key = JSON.stringify((coversItemIds || []).slice().sort());
  const { rows: pendingRows } = await pool.query(`select * from order_payment where order_id = $1 and status = 'pending'`, [order.id]);
  const existing = pendingRows.find((p) => {
    const pKey = JSON.stringify((p.covers_item_ids || []).slice().sort());
    return (p.covers_item_ids === null) === (coversItemIds === null) && pKey === key;
  });
  if (existing) return existing;

  // Our own bookkeeping id, never sent to Moniepoint (schema.sql's own
  // comment on this table) -- confirmation is matched by amount/time
  // against real pos_transaction rows, not by reference.
  const reference = `${order.reference}-P${randomBytes(3).toString('hex').toUpperCase()}`;
  const { rows: created } = await pool.query(
    `insert into order_payment (order_id, provider, reference, amount, covers_item_ids, paid_by_customer_id)
     values ($1, 'pos', $2, $3, $4, $5) returning *`,
    [order.id, reference, amount, coversItemIds, actingCustomerId]
  );
  return created[0];
}

// Confirms one order_payment (POS auto-match below, or a future staff
// tie-break resolution) -- then checks whether the ORDER itself is now
// fully covered by every confirmed payment together (a single whole-order
// one, or the union of split/joint groups covering every real item),
// completing it exactly the same way the manual "Mark paid" dashboard
// button already does (routes/api.js's POST /orders/:id/status) so
// nothing downstream (feedback, table auto-close) has to know which path
// got it there. Partial settlement -- some groups paid, one hasn't --
// leaves the order open, still visibly "awaiting payment" for the rest.
export async function confirmOrderPayment(orderPaymentId) {
  const { rows } = await pool.query(
    `update order_payment set status = 'confirmed', confirmed_at = now() where id = $1 and status = 'pending' returning *`,
    [orderPaymentId]
  );
  const payment = rows[0];
  if (!payment) return null;

  const { rows: allItems } = await pool.query('select id from order_item where order_id = $1', [payment.order_id]);
  const { rows: confirmedPayments } = await pool.query(
    `select covers_item_ids from order_payment where order_id = $1 and status = 'confirmed'`,
    [payment.order_id]
  );
  const wholeOrderPaid = confirmedPayments.some((p) => p.covers_item_ids === null);
  const covered = new Set();
  for (const p of confirmedPayments) for (const id of p.covers_item_ids || []) covered.add(id);
  const fullyCovered = wholeOrderPaid || (allItems.length > 0 && allItems.every((i) => covered.has(i.id)));
  if (!fullyCovered) return payment;

  // Chidera, 2026-09-20: "i need pos to work now for both online and in
  // house" -- dine-in payment closes the order straight to 'completed'
  // (the table's already eaten; paying is the LAST step). An online order
  // paying via POS is the OPPOSITE order -- payment is what kicks off
  // preparation, not what ends the order -- same distinction
  // completePayment (Paystack/proof-image confirm) already draws. Reusing
  // that exact function here instead of duplicating its
  // transitionOrder/createDelivery/staff-alert logic.
  const { rows: preRows } = await pool.query('select * from "order" where id = $1', [payment.order_id]);
  const preOrder = preRows[0];
  if (preOrder?.channel === 'dinein') {
    const { rows: orderRows } = await pool.query(
      `update "order" set status = 'completed', engine_state = 'completed', completed_at = now() where id = $1 returning *`,
      [payment.order_id]
    );
    const order = orderRows[0];
    if (order) {
      sendFeedbackRequest(order.id).catch((err) => console.error('sendFeedbackRequest failed:', err.message));
      if (order.session_id) {
        closeTableSessionIfSettled(order.session_id, { closedBy: 'auto' }).catch((err) => console.error('closeTableSessionIfSettled failed:', err.message));
      }
    }
  } else if (preOrder) {
    await completePayment(preOrder.id);
  }
  return payment;
}

// Joint dine-in, Stage 3: "if there is an exact amount sent at same time
// then staff should be asked which table" -- Chidera's own call, confirmed
// as the right approach. Called right after engine/webhook-moniepoint.js
// inserts a new pos_transaction -- matches it against every PENDING
// order_payment with the same amount inside a short recent window (a few
// minutes: long enough for someone to actually walk up and tap the
// terminal after requesting payment, short enough that two genuinely
// unrelated transactions at the same amount rarely land in it together).
// Zero matches -- nothing to reconcile automatically, the transaction
// stays logged as-is (a non-order sale, or paid a way not expected here).
// Exactly one -- auto-confirm it, no staff involved, which is the entire
// point (closes the staff-fraud gap this whole plan started from). Two
// or more -- a genuine tie, never guessed at with real money: staff gets
// asked which one instead.
export async function matchPosTransactionToPayment(transaction) {
  const { rows: candidates } = await pool.query(
    `select op.*, o.table_id, o.reference as order_reference, rt.label as table_label
     from order_payment op
       join "order" o on o.id = op.order_id
       left join restaurant_table rt on rt.id = o.table_id
     where op.status = 'pending' and op.amount = $1
       and op.created_at > now() - interval '15 minutes'`,
    [transaction.amount]
  );
  if (candidates.length === 1) {
    await confirmOrderPayment(candidates[0].id);
    return;
  }
  if (candidates.length > 1) {
    const orderRecipients = await orderAlertRecipients();
    if (orderRecipients.length) {
      // No " -- " / standalone dash -- bot-engine/send.js's sanitizeText
      // rejects that as banned formatting (found live, via this exact
      // alert, not assumed). Line breaks + "label: value" instead, same
      // convention every other structured staff alert in this file uses.
      // table_label is null for an online order (no table_id) -- 2026-09-20,
      // "i need pos to work now for both online and in house" -- labelled
      // by its own order reference instead, same as every other place in
      // this file already falls back when a dine-in-only field is absent.
      const list = candidates.map((c) => (c.table_label ? `Table ${c.table_label}: NGN ${c.amount}` : `Order ${c.order_reference}: NGN ${c.amount}`)).join('\n');
      const alertText = `A POS payment of NGN ${transaction.amount} matched more than one order waiting to pay:\n${list}\n\nNot auto-confirmed, to avoid crediting the wrong one. Please confirm the right one from the dashboard.`;
      for (const { phoneNumber: to, staffId } of orderRecipients) await notifyStaff({ staffId, phoneNumber: to, title: 'POS payment tie', body: alertText });
    }
  }
}

// Joint dine-in, Stage 2: "food comes first before payment unlike normal
// ordering... they can pay when ever they are ready." Called from
// routes/dinein.js's POST /orders/:id/served the moment staff taps
// "Served" -- every guest who's actually been part of this table's
// sitting (table_session_guest, plus the original scanner as a defensive
// fallback) gets their OWN "Ready to pay" link, same ?g=<menu_token>
// per-guest identity mechanism as every other dine-in link (see
// handleDineinButtonTap above). Stage 3 builds out the real split/joint
// payment page this links to.
export async function notifyGuestsReadyToPay(order) {
  if (!process.env.PUBLIC_URL || order.channel !== 'dinein' || !order.table_id || !order.session_id) return;
  const { rows: tableRows } = await pool.query('select label, qr_token, branch_id from restaurant_table where id = $1', [order.table_id]);
  const table = tableRows[0];
  if (!table) return;
  // Chidera, 2026-09-25 (live report): "the whole ready to pay should come
  // on bare chat once only for people who actually placed an order not
  // just everyone on the table" -- real gap: every guest who'd EVER
  // scanned or joined this table's session got notified, even one who
  // never actually added a single item (came along, never ordered). Only
  // customers who genuinely have their own order_item lines on THIS order
  // get a "ready to pay" bubble/ping -- there's nothing for anyone else
  // here to pay for.
  const { rows: guests } = await pool.query(
    `select distinct c.* from customers c
       join order_item oi on oi.added_by_customer_id = c.id
     where oi.order_id = $1`,
    [order.id]
  );
  if (!guests.length) return;
  const { total } = await summariseOrder(order);
  for (const guest of guests) {
    try {
      const token = await ensureMenuToken(guest);
      const url = `${process.env.PUBLIC_URL}/t/${table.qr_token}/pay?g=${token}`;
      // Chidera, 2026-09-25: "in dine in where bot sends the pay now, let
      // them add a menu button since it was suggested that they can still
      // order more so 2 buttons in that text" -- same /t/:qrToken shop
      // page every other dine-in menu link already points at
      // (sendDineinGreeting's own menuUrl, same shape).
      const menuUrl = `${process.env.PUBLIC_URL}/t/${table.qr_token}?g=${token}`;
      // Chidera, 2026-09-24: "now we need dine in to go through web chat
      // too... reduce my cost." Used to be a real send to every single
      // guest at the table, every time -- the real "ready to pay" content
      // (and its own real button, same "Ready to pay? Click here" wording)
      // now lands as a free website bubble per guest; a real WhatsApp send
      // only happens for the short redirect ping, and only once per guest
      // until each one has genuinely come back to the chat since the last
      // one.
      // Chidera, 2026-09-25, real report: "why is one number having 2
      // seperate table 1 conversation? ... one number has two chat space,
      // that doesnt delete their previous conversation." Root cause,
      // confirmed against era-demo's real data: this logMessage never set
      // tableSessionId at all (guest.id, not customer.id -- the earlier
      // bulk pass that threaded tableSessionId through every OTHER direct
      // logMessage call site matched the literal string "customerId:
      // customer.id," and silently missed this one, the only call site in
      // the whole file using `guest`). The bubble landed with
      // table_session_id null -- the generic online thread -- instead of
      // this table's own separate one, which is exactly what looked like a
      // second, stray "Table 1" conversation bleeding into the wrong
      // thread. order.session_id IS the real table_session id (the guard
      // above already requires it).
      // Chidera, 2026-09-25: "when you receive your order and you are
      // ready to pay just come back here and tap this button to pay with
      // the pay now button, then also let them know you can still add to
      // your order before making final payment."
      await logMessage({
        customerId: guest.id,
        tableSessionId: order.session_id,
        direction: 'outbound',
        channel: 'website',
        sender: 'bot',
        body: `Your order has been served! When you're ready to pay, come back here and tap the button below to pay. You can still add to your order before making your final payment.`,
        trigger: 'dinein_ready_to_pay',
        interactive: { type: 'cta_url', buttonText: 'Pay now', url, secondaryUrl: menuUrl, secondaryLabel: 'Menu' },
      });
      if (await needsChatRedirect(guest)) {
        await sendChatRedirectPing(guest, `Your table is ready to pay.`, { trigger: 'dinein_ready_to_pay_ping' });
      }
    } catch (err) {
      // Best-effort, per guest -- one guest's send failing (a stale
      // number, WhatsApp's 24h window) must never stop the others from
      // getting told the table's ready.
      console.error(`Failed to notify guest ${guest.id} the table is ready to pay:`, err.message);
    }
  }
}

// Joint dine-in, Stage 2: "even if staff marks served and it goes to the
// next pipeline and they still add it should go back to first pipeline"
// (the original chat-only version of this rule, flow.js's own
// applyOrderModifications) also alerts staff -- "Table X added more after
// being served" -- reusing orderAlertRecipients/sendStaffAlert exactly as
// completePayment's own ready-to-prepare ping already does, not new
// plumbing. Exported and shared between applyOrderModifications (typed-
// chat adds) and routes/dinein-menu.js's web review route (which
// replaces the whole basket rather than diffing adds/removes, so it
// can't reuse applyOrderModifications itself) -- one place decides what
// "served, then added to" means and what it does about it.
export async function resetServedForAddOn(order) {
  if (!(order.channel === 'dinein' && order.served_at)) return false;
  await pool.query(`update "order" set served_at = null where id = $1`, [order.id]);
  order.served_at = null;
  const orderRecipients = await orderAlertRecipients();
  if (orderRecipients.length && order.table_id) {
    const { rows: tableRows } = await pool.query('select label from restaurant_table where id = $1', [order.table_id]);
    // Chidera, 2026-09-25: "let the add on only state the add on items not
    // all the items" -- was summariseOrder's full itemLines (the WHOLE
    // running bill). order_item has no stable row identity across a
    // resubmit (the web review route deletes and reinserts every line
    // each time -- see served_item_snapshot's own schema comment), so a
    // timestamp-based diff can't tell new from old here. Reuses the exact
    // same {product_id: quantity} snapshot + diff routes/dinein.js's own
    // itemsWithServedDiff already computes for the InHouse kanban card's
    // "NEW" badge -- one source of truth for what "just added on" means,
    // correct regardless of whether the add-on came from the web menu or
    // typed chat.
    const { rows: currentItems } = await pool.query(
      `select p.name, p.id as product_id, oi.quantity, oi.price,
         coalesce(
           (select string_agg(oa.answer, ', ' order by oa.created_at)
            from order_item_answer oa where oa.order_item_id = oi.id),
           ''
         ) as answer_summary
       from order_item oi join product p on p.id = oi.product_id where oi.order_id = $1`,
      [order.id]
    );
    const snapshot = order.served_item_snapshot || {};
    const itemLines = currentItems
      .map((r) => ({ ...r, newQty: Math.max(0, r.quantity - Number(snapshot[r.product_id] || 0)) }))
      .filter((r) => r.newQty > 0)
      .map((r) => `${r.newQty}x ${r.name}${r.answer_summary ? ` (${r.answer_summary})` : ''}: NGN ${r.price}`);
    if (itemLines.length) {
      const alertText = `Table ${tableRows[0]?.label || '?'} added more after being served:\n${itemLines.join('\n')}`;
      for (const { phoneNumber: to, staffId } of orderRecipients) {
        await notifyStaff({ staffId, phoneNumber: to, title: 'Added after serving', body: alertText });
      }
    }
  }
  return true;
}
