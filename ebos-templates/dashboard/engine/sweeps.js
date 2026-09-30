// Every periodic background job flow.js's own server.js schedules on an
// interval, split out 2026-09-26 as the first step of breaking up flow.js's
// 6800+ lines into focused, independently-debuggable pieces (Chidera: "if
// maybe a bot takes a wrong order I know it's from ordering section and it
// doesn't affect the remaining code"). Each sweep here is a cheap, self-
// contained periodic check -- cheap when nothing's waiting, genuinely inert
// for a business that's never hit the condition it watches for. Still
// re-exported from flow.js so no existing import site (server.js, tests)
// had to change.
//
// recoverPendingMessages deliberately stays in flow.js, not here -- it's
// tangled with the in-memory debounce/typing-indicator machinery
// (scheduleDebouncedProcessing, pendingTimers) that's core message-routing
// infrastructure, not an independent periodic check like everything below.
import { pool } from '../lib/db.js';
import { checkOperatingHours } from './hours.js';
import { sendPaymentInstructions, sendPaymentReminder, sendChatRedirectPing, reply } from './flow.js';

// An order a customer never confirmed or actively walked away from just
// ages out on its own -- there's no customer-facing "cancel" anymore, so
// without this an abandoned order would sit open forever, exactly the
// zombie-order confusion a real customer hit live (an old, long-abandoned
// order from a previous day resurfaced once a newer one was closed out
// from under it). Silent on purpose -- a day-old, never-confirmed order
// closing quietly is normal, not something worth messaging a customer
// about out of nowhere. Reuses the existing 'cancelled' terminal state
// rather than adding a new one -- everywhere that already excludes
// cancelled orders (getOpenOrder, the panel's order list, etc.) handles
// this correctly with no other change needed.
// Chidera, real live report: "that dynamic monify account is showing me
// as invalid and unavailable" -- confirmed live: the checkout session
// Monnify sent back had genuinely expired, a real time limit on their own
// end. Follow-up: "i cant text you, it should be auto regenerated" --
// also confirmed live that Monnify's own "Try again" button on an expired
// session doesn't actually work either, it just loops back to the same
// dead transaction. The only real fix is OUR OWN system issuing a
// genuinely new one, proactively, before the customer would ever see
// "expired" at all.
// monnify_account_expires_at naturally self-limits how often any one
// order re-matches here: sendPaymentInstructions regenerates a fresh
// ~25-minute link (monnify-api.js's callMonnifyCheckoutLink) every time
// it runs, which pushes this same order's own expires_at back out past
// the lead window immediately -- so a customer who's still mid-checkout
// never sees "expired," and one who's genuinely gone quiet just keeps
// getting a fresh link roughly every 20 minutes until closeStaleOrders'
// own 24h sweep below eventually cancels the order outright.
const MONNIFY_LINK_REFRESH_LEAD_MINUTES = 5;
export async function refreshExpiringPaymentLinks() {
  const { rows: orders } = await pool.query(
    `select * from "order"
     where engine_state = 'confirm_payment'
       and payment_status not in ('confirmed', 'accepted')
       and monnify_account_expires_at is not null
       and monnify_account_expires_at < now() + make_interval(mins => $1)`,
    [MONNIFY_LINK_REFRESH_LEAD_MINUTES]
  );
  for (const order of orders) {
    try {
      const { rows: custRows } = await pool.query('select * from customers where id = $1', [order.customer_id]);
      const customer = custRows[0];
      if (customer) await sendPaymentInstructions(customer, order);
    } catch (err) {
      console.error(`Failed to refresh expiring Monnify link for order ${order.id}:`, err.message);
    }
  }
  if (orders.length) console.log(`Refreshed ${orders.length} expiring Monnify payment link(s).`);
}

const STALE_ORDER_HOURS = 24;
export async function closeStaleOrders() {
  const { rowCount } = await pool.query(
    `update "order" set status = 'cancelled', engine_state = 'cancelled'
     where engine_state not in ('completed', 'cancelled') and updated_at < now() - make_interval(hours => $1)`,
    [STALE_ORDER_HOURS]
  );
  if (rowCount) console.log(`Closed ${rowCount} order(s) abandoned for over ${STALE_ORDER_HOURS}h.`);
}

// Phase 2 of the web-chat feature: on plain WhatsApp, a customer left
// sitting at confirm_payment naturally re-engages by texting something
// (even just "okay"), which is what actually triggers flow.js's own
// handleWaitingOnPayment -- pure silence gets pure silence forever, nobody's
// ever proactively re-pinged. That's the one real gap the web-chat page
// makes worse, not better: a customer who taps "Ready to pay?", opens the
// pay page, then just closes the tab without ever typing anything back has
// no way to trigger a reminder at all. This is the proactive counterpart --
// PAYMENT_NUDGE_MINUTES of real silence (order.updated_at, same staleness
// signal closeStaleOrders already uses) triggers exactly ONE real WhatsApp/
// Instagram nudge, reusing sendPaymentReminder's own payment_reminder_sent_at
// guard so this and a customer's own later message can never double-send.
// Skips anyone whose web_chat_active_at is still fresh -- they're looking
// at the "Ready to pay?" bubble right now, a real WhatsApp ping on top of
// that would be the exact unwanted extra message this whole feature exists
// to avoid, not a safety net. dinein is deliberately excluded (order.channel
// in ('whatsapp','instagram') only) -- a table still physically at the
// restaurant isn't "abandoned" the same way, and dine-in's own payment flow
// is staff-mediated, not this reminder's concern.
const PAYMENT_NUDGE_MINUTES = 20;
const WEB_CHAT_ACTIVE_WINDOW_MINUTES = 30;

export async function sweepAbandonedWebChatOrders() {
  const { rows: candidates } = await pool.query(
    `select o.* from "order" o
     join customers c on c.id = o.customer_id
     where o.engine_state = 'confirm_payment'
       and o.payment_status = 'pending'
       and o.payment_reminder_sent_at is null
       and o.channel in ('whatsapp', 'instagram')
       and o.updated_at < now() - make_interval(mins => $1)
       and (c.web_chat_active_at is null or c.web_chat_active_at < now() - make_interval(mins => $2))`,
    [PAYMENT_NUDGE_MINUTES, WEB_CHAT_ACTIVE_WINDOW_MINUTES]
  );
  for (const order of candidates) {
    const { rows: customerRows } = await pool.query('select * from customers where id = $1', [order.customer_id]);
    const customer = customerRows[0];
    if (!customer) continue;
    try {
      await sendPaymentReminder(customer, order);
    } catch (err) {
      console.error(`Abandonment nudge failed for order ${order.id}:`, err);
    }
  }
  if (candidates.length) console.log(`Sent ${candidates.length} abandonment nudge(s).`);
}

// Chidera, 2026-09-25: "when a customer text and abandon a menu maybe they
// text bare chat and they dont open web menu or they open webmenu but dont
// say anything after see menu, retext them... 10 mins after abandonment."
// A DIFFERENT, earlier gap than sweepAbandonedWebChatOrders above -- that
// one only ever fires once a real order already exists and reached
// confirm_payment. This covers everything BEFORE that: a customer who got
// the greeting/first-choice/dinein bubble (or opened the web menu itself,
// which touches web_chat_active_at but never last_message_at on its own)
// and then just went quiet, possibly with no order row at all yet.
// last_message_at (touched by logMessage on both inbound and outbound)
// is the real "last activity on this thread" clock -- opening the web
// menu without saying/tapping anything after never advances it, so
// staying on "See menu" with no follow-up correctly counts as abandonment
// too, not just silence after a bare text.
// Deliberately reuses sendChatRedirectPing/chat_redirect_sent_at (the same
// "tap here to text" mechanism flow.js's own bare-WhatsApp redirect already
// uses) rather than a second, parallel ping system -- same underlying
// situation (customer isn't using the web chat right now), just a
// different trigger (a silence timer instead of a fresh bare text).
// Its own guard is written directly here rather than via needsChatRedirect
// -- that helper's 30-minute "actively on page" window would silently
// delay this to ~30 minutes instead of the requested 10 for anyone in the
// 10-30 minute band, since a page LOAD alone (no message) touches
// web_chat_active_at without ever advancing last_message_at.
const ORDER_ABANDONMENT_NUDGE_MINUTES = 10;

export async function sweepAbandonedChatCustomers() {
  const { rows: candidates } = await pool.query(
    `select c.* from customers c
     where c.last_message_at is not null
       and c.last_message_at < now() - make_interval(mins => $1)
       and c.channel in ('whatsapp', 'instagram')
       and (c.web_chat_active_at is null or c.web_chat_active_at < now() - make_interval(mins => $1))
       -- Chidera, 2026-09-25, real live incident: two customers whose
       -- 24h WhatsApp session window was closed got the same nudge
       -- resent every ~2 minutes, chat_redirect_count climbing forever.
       -- Root cause: logMessage touches last_message_at for EVERY
       -- message, including the system's OWN outbound sends -- when a
       -- send failed and engine/flow.js's retryFailedSendAsTemplate
       -- retried it (webhook-whatsapp.js's status handler, error 131047),
       -- THAT retry's own logMessage call pushed last_message_at past
       -- chat_redirect_sent_at, which this guard misread as "the
       -- customer engaged again" -- rearming itself using a signal the
       -- system's own retry had just touched, not anything the customer
       -- did. web_chat_active_at is the only signal here that's NEVER
       -- touched by an outbound send (only a genuine page visit) --
       -- needsChatRedirect's own, already-correct guard only ever used
       -- this one signal too, never last_message_at.
       and (c.chat_redirect_sent_at is null or c.web_chat_active_at > c.chat_redirect_sent_at)
       and not exists (
         select 1 from "order" o where o.customer_id = c.id and o.engine_state in ('confirm_payment', 'fulfilment', 'completed')
       )
       and not exists (
         select 1 from table_session ts where ts.closed_at is null
           and (ts.customer_id = c.id or exists (select 1 from table_session_guest g where g.session_id = ts.id and g.customer_id = c.id))
       )`,
    [ORDER_ABANDONMENT_NUDGE_MINUTES]
  );
  for (const customer of candidates) {
    try {
      await sendChatRedirectPing(
        customer,
        "Hey, we noticed you didn't go on with your order. Tap below to continue with your order.",
        { trigger: 'order_abandonment_nudge' }
      );
    } catch (err) {
      console.error(`Order abandonment nudge failed for customer ${customer.id}:`, err);
    }
  }
  if (candidates.length) console.log(`Sent ${candidates.length} order abandonment nudge(s).`);
}

// Run on an interval from server.js, same "cheap when nothing's waiting,
// genuinely inert for a business that's never set opening_hours" shape as
// every other sweep in this file. Per branch (not globally) since two
// branches can keep different hours -- only a branch that's actually open
// right now, with rows actually waiting, does any work.
export async function sweepOpeningNotifications() {
  const { rows: branches } = await pool.query(
    `select distinct b.id, b.opening_hours from branch b
     join hours_notify_request r on r.branch_id = b.id and r.notified_at is null
     where b.opening_hours is not null`
  );
  for (const branch of branches) {
    const { open } = checkOperatingHours(branch.opening_hours);
    if (!open) continue;
    const { rows: pending } = await pool.query(`select * from hours_notify_request where branch_id = $1 and notified_at is null`, [branch.id]);
    for (const request of pending) {
      const { rows: customerRows } = await pool.query('select * from customers where id = $1', [request.customer_id]);
      const customer = customerRows[0];
      await pool.query('update hours_notify_request set notified_at = now() where id = $1', [request.id]);
      if (!customer) continue;
      try {
        await reply(customer, `We're open now! Reply to place an order.`, 'opening_notify');
      } catch (err) {
        console.error(`Failed to send opening notification to customer ${customer.id}:`, err);
      }
    }
  }
}
