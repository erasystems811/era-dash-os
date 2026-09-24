// Dine-in add-on, Stage 4-5: the guest-facing menu page
// (EBOS-Addon-Schema-Dine-In.md section 4) and the order review/confirm
// that sends it into the existing order engine (section 5). Public, no
// login (the qr_token is the identity) -- mounted at /t in server.js,
// same as routes/documents.js and routes/tracking.js.
import express from 'express';
import { pool } from '../lib/db.js';
import { renderMenuPage, renderPayPage } from '../engine/menu-page-template.js';
import { createOrderPayment, ensureDynamicPosAccount, ensureMenuToken, finishItemsCollection, getOrCreateTableOrder, notifyCustomerClaimedPosPayment, restartItemsCollection, summariseOrder, upsertTableGuest } from '../engine/flow.js';
import { getPaymentConfig, initializeOrderPaymentPaystackTransaction } from '../engine/payment.js';
import { getSharingMode } from '../engine/fields.js';
import { getWhatsAppCredentials } from '../engine/branch-channel.js';
import { getWaDisplayNumber } from '../engine/whatsapp-send.js';

export const router = express.Router();

// Same pattern as routes/menu-page.js's own isViaWebChat -- a dine-in
// guest's /review submission reaches finishItemsCollection/reply() with
// customer.channel still whatever's stored (almost always 'whatsapp'),
// which would silently send every item-question/upsell/confirm message as
// a real, billable WhatsApp send. Flipping it in-memory here, right before
// those calls, is what actually makes "dine in through web chat" true for
// the messages that make up the bulk of an order's real cost.
const WEB_CHAT_ACTIVE_WINDOW_MS = 30 * 60 * 1000;
function isViaWebChat(customer) {
  return Boolean(customer.web_chat_active_at) && new Date(customer.web_chat_active_at) > new Date(Date.now() - WEB_CHAT_ACTIVE_WINDOW_MS);
}

async function resolveTable(qrToken) {
  const { rows } = await pool.query(
    `select rt.*, b.name as branch_name, biz.name as business_name,
       md5(biz.cover_photo_data_url) as cover_photo_version
     from restaurant_table rt join branch b on b.id = rt.branch_id, business biz
     where rt.qr_token = $1 and rt.status = 'active'`,
    [qrToken]
  );
  return rows[0] || null;
}

// cover_photo_version (an md5 of the actual data: URI, computed in
// Postgres so the full thing never has to load into Node just for this)
// instead of a bare boolean -- Chidera 2026-09-11: "when i changed cover
// photo why didnt it reflect?" /photo/cover is the same URL every time, so
// a browser (or WhatsApp's own media cache, which can hold on to a header
// image far longer than a browser would) kept serving the OLD photo it
// had already cached under that URL -- changing the photo never changed
// the URL pointing at it. Appending this hash as ?v= (menu-page-
// template.js, businessCoverPhotoUrl below) makes a new photo a
// genuinely different URL, so it can't collide with a stale cache entry
// for the old one. Shared with routes/menu-page.js, which has no table
// row to piggyback this onto the way resolveTable above does.
// Chidera, 2026-09-16: "my pomodoro doesnt have that cover photo on
// hearder with business name" -- the actual root cause: business name and
// cover photo are BUSINESS-level facts (business is a hard singleton, see
// schema.sql's business_singleton_idx), they never depended on branch at
// all. The old query joined through `branch` anyway (`from branch b,
// business biz where b.id = $1`) with no real relationship between the two
// tables -- worked by accident whenever a customer happened to have a real
// branch_id, but pomodoro (like most single-location businesses -- branch
// rows are largely unused outside real multi-branch setups, see
// hazy-hugging-seahorse.md) has ZERO rows in `branch` and a null
// customer.branch_id, so `where b.id = $1` matched nothing, this returned
// {}, and the page silently fell back to its plain no-photo header with no
// business name -- not a missing photo, a query that could never find one.
export async function resolveMenuBranding() {
  const { rows } = await pool.query(
    `select name as business_name, md5(cover_photo_data_url) as cover_photo_version from business limit 1`
  );
  return rows[0] || {};
}

// The real number a wa.me link needs -- NOT business.phone_number (a free-
// text contact field in Settings, not necessarily ever connected to
// WhatsApp: era-demo's is a placeholder, and a wa.me link built from it
// produced "this number isn't on WhatsApp, Invite / Cancel" every time.
// Chidera 2026-09-10. Resolved from Meta's own record of what's actually
// connected to this branch's phone_number_id (falls back to the single
// shared env-var pair when no branch_channel row exists, same as every
// other credentials lookup in this codebase).
export async function resolveWaNumber(branchId) {
  const credentials = await getWhatsAppCredentials(branchId);
  return getWaDisplayNumber(credentials);
}

// Chidera, 2026-09-21, real live report: "after i closed web from
// instagram it took me on whatsapp not back to ig where i placed the
// order" -- ig.me/m/<handle> is Instagram's own equivalent of wa.me,
// needs the business's own @handle (branch.instagram_handle, a plain
// Settings field -- no Meta credential resolution needed the way WA's
// number does, this one's never wrong the way business.phone_number was).
// Falls back to any branch's handle when this one hasn't set its own,
// same "one shared value covers every branch until a real one exists"
// pattern the WhatsApp number lookup already follows via getWhatsAppCredentials.
// Added to this branch 2026-09-23 -- this branch was cut before it landed
// on main, and routes/menu-page.js's own web-chat work already imports it;
// missing here meant a real crash-loop on deploy (era-demo, live).
export async function resolveInstagramHandle(branchId) {
  const { rows } = await pool.query(
    `select instagram_handle from branch
     where instagram_handle is not null and instagram_handle != ''
     order by (id = $1) desc
     limit 1`,
    [branchId]
  );
  return rows[0]?.instagram_handle || null;
}

async function openSessionFor(table) {
  const { rows } = await pool.query(`select * from table_session where table_id = $1 and closed_at is null`, [table.id]);
  return rows[0] || null;
}

// Joint dine-in, Stage 1: every guest at a table shares the exact same
// qrToken (it identifies the TABLE, not them), so it alone can never say
// which guest is actually looking at the page right now -- ?g= (each
// guest's own customers.menu_token, embedded per-recipient when flow.js
// sends their own copy of the menu link) is what does. Falls back to the
// session's original scanner when ?g= is missing or stale -- an old
// bookmarked link, or the very first GET before any button tap has ever
// handed this guest their own ?g= link -- same customer this page always
// resolved to before this existed, not a new failure mode.
async function resolveActingCustomer(session, req) {
  const g = typeof req.query.g === 'string' ? req.query.g : null;
  if (g) {
    const { rows } = await pool.query('select * from customers where menu_token = $1', [g]);
    if (rows[0]) return rows[0];
  }
  if (!session?.customer_id) return null;
  const { rows } = await pool.query('select * from customers where id = $1', [session.customer_id]);
  return rows[0] || null;
}

// Own query, not fields.js's resolveMenu -- that one is shaped for AI
// prompt context (no images, no availability detail) and reused all over
// the order-taking engine; bloating it with base64 photos for every call
// site would be a real cost/latency regression there. This page needs the
// opposite: every real detail, for a human looking at pictures. Exported --
// routes/menu-page.js (the non-table, regular-ordering version of this
// same page) uses the exact same query.
export async function menuForBranch(branchId) {
  // position preserves the real menu's own layout (see routes/api.js's
  // /catalogue and engine/fields.js's resolveMenu, both fixed the same
  // way, 2026-09-16) -- this is a third, separate query that had the same
  // alphabetical-fallback bug: Chidera, testing pomodoro's real web menu,
  // "why is drinks frist on the website tabs" -- category name order
  // wouldn't put Drinks first anywhere but alphabetically.
  // questions: Chidera, 2026-09-17: "what if the whole order is taken on
  // the site" -- the web menu page needs to ask the same per-item
  // customization question (penne or spaghetti, room temp or cold) it
  // used to only ask afterward in chat, right when an item's added to the
  // basket. Same product_question rows the bot's own askNextItemQuestion
  // already reads, just surfaced here too now.
  //
  // Chidera, 2026-09-20: "why is my era demo web menu only showing today
  // specials" -- root cause was this query filtering by branch
  // unconditionally, unlike fields.js's resolveMenu (the AI ordering
  // engine's own menu read), which already treats sharing_mode='merged'
  // as "branch is a no-op, show everything." era-demo's own branch_id
  // handed in here was null for some customers (no branch_channel row to
  // resolve one from), and `branch_id = null` never matches its own
  // products in SQL -- so those customers saw only the one product with
  // no branch_id at all. Mirroring resolveMenu's own merged-mode
  // short-circuit fixes this at the root instead of just patching around
  // one specific null-branchId shape of it.
  const base = `select p.id, p.name, p.description, p.price, p.category, p.image_data_url, p.availability,
       coalesce(
         (select json_agg(json_build_object('id', pq.id, 'question', pq.question, 'options', pq.options) order by pq.position, pq.created_at)
          from product_question pq where pq.product_id = p.id),
         '[]'
       ) as questions
     from product p
     where p.import_status is distinct from 'new'`;
  const order = `order by p.position asc nulls last, p.category nulls last, p.name`;
  const sharingMode = branchId ? await getSharingMode() : 'merged';
  if (sharingMode === 'merged') {
    const { rows } = await pool.query(`${base} ${order}`);
    return rows;
  }
  const { rows } = await pool.query(`${base} and (p.branch_id = $1 or p.branch_id is null) ${order}`, [branchId]);
  return rows;
}

// Polled every 15s by the shared page itself (menu-page-template.js) so
// other guests' additions show up without anyone manually reloading --
// joint dine-in, Stage 1. Same pendingOrder shape as the initial page
// render below, just fetched again -- no separate live-update mechanism,
// matching the codebase's own existing 15s-poll pattern (InHouse.jsx/
// Delivery.jsx) rather than adding new infra for this one page.
router.get('/:qrToken/menu.json', async (req, res) => {
  const table = await resolveTable(req.params.qrToken);
  if (!table) return res.status(404).json({ error: 'Table not found.' });
  const session = await openSessionFor(table);
  const actingCustomer = session ? await resolveActingCustomer(session, req) : null;
  const [products, pendingOrder] = await Promise.all([
    menuForBranch(table.branch_id),
    pendingOrderPayload(session, table, actingCustomer?.id || null),
  ]);
  res.json({
    table: { label: table.label, branch_name: table.branch_name, business_name: table.business_name },
    products,
    pendingOrder,
  });
});

router.post('/:qrToken/review', async (req, res) => {
  const table = await resolveTable(req.params.qrToken);
  if (!table) return res.status(404).json({ error: 'Table not found.' });
  const session = await openSessionFor(table);
  if (!session || !session.customer_id) {
    // No consent-establishing scan on record for this table right now --
    // spec 2.1: WhatsApp requires the guest to have messaged first. Rare
    // in practice (this page is only ever opened FROM that chat), but a
    // stale bookmark or a shared link could hit this.
    return res.status(409).json({ error: 'Please message us on WhatsApp first by scanning the table QR code again.' });
  }
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Your basket is empty.' });

  // The guest actually submitting THIS round, not necessarily the table's
  // original scanner -- joint dine-in, Stage 1. Item lines below get
  // attributed to them individually (added_by_customer_id); the order
  // itself stays owned by session.customer_id either way (getOrCreateTableOrder).
  const customer = await resolveActingCustomer(session, req);
  if (!customer) return res.status(404).json({ error: 'Customer not found.' });

  const products = await menuForBranch(table.branch_id);
  const byId = new Map(products.map((p) => [p.id, p]));
  // Which added_by_customer_id claims are even real -- never trust the
  // client's own claim here either, same reasoning as price/availability/
  // answers just below. Everyone who's ever scanned or opened this table
  // (session.customer_id plus every table_session_guest), so a line
  // genuinely added earlier by a different guest keeps their name on
  // re-submit instead of every full-basket replace silently reattributing
  // the whole table to whoever happens to tap Confirm.
  const { rows: guestRows } = await pool.query(
    `select customer_id from table_session_guest where session_id = $1
     union select $2`,
    [session.id, session.customer_id]
  );
  const validGuestIds = new Set(guestRows.map((g) => g.customer_id));
  const resolved = [];
  for (const item of items) {
    const p = byId.get(item.productId);
    if (!p || !p.availability) continue; // never trust the client's own price/availability claim
    const qty = Number(item.quantity) > 0 ? Number(item.quantity) : 1;
    // Never trust the client's own answers object either -- only keep an
    // answer for a question that genuinely belongs to this product, same
    // "never trust the client's own claim" reasoning as price/availability
    // just above. A question id the client made up (or one belonging to a
    // different product) is silently dropped, not persisted.
    const validQuestionIds = new Set((p.questions || []).map((q) => q.id));
    const answers = {};
    if (item.answers && typeof item.answers === 'object') {
      for (const qid of Object.keys(item.answers)) {
        if (validQuestionIds.has(qid) && String(item.answers[qid] || '').trim()) {
          answers[qid] = String(item.answers[qid]).trim();
        }
      }
    }
    const addedBy = validGuestIds.has(item.addedBy) ? item.addedBy : customer.id;
    resolved.push({ productId: p.id, name: p.name, price: p.price, quantity: qty, answers, addedBy });
  }
  if (!resolved.length) return res.status(400).json({ error: "Sorry, nothing in your basket is available right now." });

  // The ONE shared order for this table's current sitting -- joint dine-in,
  // Stage 1. Still deciding on THIS round (hasn't said yes yet, status
  // stays 'new' the whole time -- see finishItemsCollection's own effect on
  // engine_state below) -- replace items with the full new basket instead
  // of creating a second, duplicate order and abandoning the first. Found
  // live, 2026-09-11, Chidera: "dine in didnt reserve my orders fo when i
  // tapped change it" -- every re-submit from "No, change it"
  // (handleOrderConfirmNoTap's own menu link) silently orphaned the
  // original order and created a fresh one, which is what actually made it
  // look like the order had vanished.
  //
  // Whole-basket replace still means clearing every existing line, not
  // just this guest's own -- every guest's page always submits the FULL
  // current basket (this guest's own edits merged onto whatever was last
  // synced from the others, see menu-page-template.js's poll merge), so
  // re-inserting all of `resolved` below is re-inserting everyone's items,
  // not dropping anyone else's.
  const order = await getOrCreateTableOrder(session, table, customer);
  // Captured before anything below touches the order -- Chidera,
  // 2026-09-20: "when they add on send them the yes to confirm button and
  // place the ordr." A repeat round (this order already went through its
  // own yes once before) still gets a real confirm gate, just scoped to
  // what's new (deltaLines below) -- only a genuinely FIRST-ever
  // submission gets the full first-time walk.
  const wasAlreadyConfirmed = Boolean(order.confirmed_at);
  // Net-added, not just "resubmitted" -- joint dine-in, Stage 2: a guest
  // reopening this page to only REMOVE something, or resubmitting with
  // nothing actually changed, shouldn't ping staff or bump the order back
  // to "Serving" -- only a genuine addition means "the kitchen has more to
  // do," same distinction applyOrderModifications' own mods.adds already
  // makes for the typed-chat path.
  const { rows: beforeItems } = await pool.query('select product_id, quantity from order_item where order_id = $1', [order.id]);
  const beforeQty = new Map();
  for (const row of beforeItems) beforeQty.set(row.product_id, (beforeQty.get(row.product_id) || 0) + row.quantity);
  const netAdded = resolved.some((item) => item.quantity > (beforeQty.get(item.productId) || 0));
  // Pure addition only, same reasoning as handleOrderModification's own
  // "adds only, no removes/sets" gate -- a resubmit that ALSO took
  // something off deserves the fuller read-back below, not a quick
  // "added on" note that would silently skip over what was removed.
  const afterQty = new Map();
  for (const item of resolved) afterQty.set(item.productId, (afterQty.get(item.productId) || 0) + item.quantity);
  const anyRemoved = [...beforeQty.entries()].some(([productId, qty]) => (afterQty.get(productId) || 0) < qty);

  // Chidera, 2026-09-20, real report: "i went to type cold for water it is
  // refusing to click the place order button" -- reproduced live: an item
  // added with a question still outstanding (an upsell, say) leaves
  // order.pending_question_order_item_id pointing at that row. Answering
  // it through THIS page's own question sheet is purely client-side
  // (menu-page-template.js's qSheetAdd never calls the server at all), so
  // that column was still set the moment "Place order" submitted the
  // whole basket here -- the delete below then hit its own real foreign
  // key (order_pending_question_order_item_id_fkey) on every row, no
  // exception handling on this route at all, so the request just hung
  // with no response ever sent, reading as a dead button rather than a
  // clean error. Every item is about to be replaced anyway, so any
  // pending-question pointer is stale regardless of which row it named --
  // same reasoning as clearPendingQuestionIfOnItem's own single-item case
  // (flow.js), just unconditional here since the whole basket is turning
  // over.
  await pool.query('update "order" set pending_question_order_item_id = null, pending_question_id = null where id = $1', [order.id]);
  await pool.query('delete from order_item where order_id = $1', [order.id]);
  for (const item of resolved) {
    const { rows: itemRows } = await pool.query(
      'insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, $3, $4, $5) returning id',
      [order.id, item.productId, item.quantity, item.price, item.addedBy || customer.id]
    );
    for (const questionId of Object.keys(item.answers || {})) {
      await pool.query(
        'insert into order_item_answer (order_item_id, question_id, answer) values ($1, $2, $3)',
        [itemRows[0].id, questionId, item.answers[questionId]]
      );
    }
  }
  const total = resolved.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0);
  await pool.query('update "order" set total = $1 where id = $2', [total, order.id]);

  // Chidera, 2026-09-20, real report: "after requesting payment and its
  // pending i added another water, when i tapped request payment amount
  // it kept showing me old stale amount instead of the new total or my
  // outstanding." A PENDING order_payment's amount is frozen at whatever
  // the order totalled the moment it was requested -- once the items
  // genuinely change (add or remove), that amount no longer means
  // anything real, and letting it keep sitting there risks a real POS
  // transaction matching against a stale figure (an undercount, "excess
  // payout" the other way). Confirmed payments are real money already
  // received and are never touched here -- only pending ones, which
  // never represented an actual charge in the first place.
  if (netAdded || anyRemoved) {
    await pool.query(`delete from order_payment where order_id = $1 and status = 'pending'`, [order.id]);
  }

  // Chidera, 2026-09-20: "when the customer add something in dine in
  // after theyve been served the first one, dont send the whole menu to
  // the customer again, just send the add on to the staff and just top
  // up... when they add on send them the yes to confirm button." A table
  // that's already eating doesn't need to re-run the whole item-question/
  // upsell/confirm-order cycle and see their ENTIRE running bill read
  // back just because they want another drink -- but they still get the
  // same real yes/no confirm gate every round does, just scoped to what's
  // new. The staff "added more" alert (resetServedForAddOn) now fires on
  // the actual yes tap (handleConfirmOrder), not here -- same two-step
  // "shown, then confirmed" shape the very first round already has.
  const isRepeatAddOn = wasAlreadyConfirmed && netAdded && !anyRemoved;
  if (isRepeatAddOn) {
    await pool.query(`update "order" set confirmed_at = null where id = $1`, [order.id]);
    order.confirmed_at = null;
    const deltaLines = resolved
      .map((item) => ({ ...item, addedQty: item.quantity - (beforeQty.get(item.productId) || 0) }))
      .filter((item) => item.addedQty > 0)
      .map((item) => `${item.addedQty}x ${item.name}`);
    await restartItemsCollection(order);
    if (isViaWebChat(customer)) {
      customer.channel = 'website';
      await pool.query('update customers set web_chat_active_at = now() where id = $1', [customer.id]);
    }
    await finishItemsCollection(customer, order, '', { deltaLines });
    res.json({ ok: true });
    return;
  }

  // Joint dine-in, Stage 2: this order may already be well past
  // collect_info (confirmed, before being served) -- finishItemsCollection
  // below assumes it's walking a still-undecided order forward and can't
  // do that from most further-along states. See restartItemsCollection's
  // own comment for why this is a deliberate reset, not a bug being
  // papered over.
  await restartItemsCollection(order);

  // In-memory only -- see isViaWebChat's own comment above. Without this,
  // every one of the item-question/upsell/confirm messages this produces
  // below would go out as a real WhatsApp send instead of a free bubble.
  if (isViaWebChat(customer)) {
    customer.channel = 'website';
    await pool.query('update customers set web_chat_active_at = now() where id = $1', [customer.id]);
  }

  // The read-back happens in the chat, not on this page (spec 5.1/5.2) --
  // this page's own job is done once the order + items exist; dispatch()
  // picks the rest up the next time this customer's order is touched.
  // Reuses the exact same item-question/upsell/confirm pipeline the normal
  // ordering flow already uses (handleWebMenuOrder's own tail) instead of
  // building its own confirm message here -- Chidera 2026-09-11: "the in
  // house should as well ask specific questions like peppered or not and
  // upsell." A dine-in order's very first message IS whichever of those
  // this produces, sent directly here rather than waiting for dispatch()
  // (which only reacts to an inbound customer message, and there isn't one
  // right now).
  await finishItemsCollection(customer, order, '');

  res.json({ ok: true });
});

// Only while the current round is still being decided (status stays 'new'
// through item questions, upsell, and confirm_order -- see the /review
// route above). Chidera 2026-09-11: "dine in didnt reserve my orders fo
// when i tapped change it" -- this used to be hardcoded null
// unconditionally, so even a round still being decided vanished from the
// basket the moment the menu reopened (handleOrderConfirmNoTap's "No,
// change it" link, or just scanning again before saying yes).
//
// status not in (completed, cancelled), not status = 'new' -- Stage 2
// (fancy-whistling-pearl.md): once joint dine-in lets a table keep adding
// after being served ("the bill can pile up as conclusive"), reopening
// the menu post-confirm/post-serve needs to show that SAME still-open
// order's basket too, same broadened definition getOrCreateTableOrder
// itself now uses -- not just the pre-confirm 'new' case this originally
// only had to handle.
//
// session-scoped, not customer-scoped -- joint dine-in, Stage 1: the ONE
// shared order for the table's current sitting, same as everywhere else
// this file resolves it (getOrCreateTableOrder). `actingCustomerId` is only
// used to label each line "You" vs the other guest's own name.
async function pendingOrderPayload(session, table, actingCustomerId) {
  if (!session) return null;
  const { rows: orderRows } = await pool.query(
    `select * from "order" where session_id = $1 and status not in ('completed', 'cancelled') order by created_at desc limit 1`,
    [session.id]
  );
  const order = orderRows[0];
  if (!order || order.table_id !== table.id) return null;
  // answers -- Chidera, 2026-09-17: so a reopened table link's basket
  // rebuilds the exact same distinct lines it left with (menu-page-
  // template.js's own PENDING_ORDER pre-load), not one merged line that's
  // lost which answer belonged to which unit. coalesce to '{}', not NULL,
  // same reasoning as routes/menu-page.js's own pendingOrderPayload.
  //
  // addedByName/addedByCustomerId -- Chidera's joint dine-in concept:
  // "let everyone on that table be able to join in and see each other" --
  // coalesce(name, preferred_name) same as anywhere else a customer's own
  // display name is shown. Chidera, 2026-09-20: "classified by the names
  // of people on the table and what they picked or their number when
  // they dont put a name" -- name is dashboard-editable only, preferred_
  // name is voice-only, neither is ever written by any WhatsApp/web
  // ordering code, so a nameless guest is genuinely the common case here,
  // not a fallback for rare data -- their own phone number identifies
  // them at the table just as well as "a guest" never did.
  const { rows: items } = await pool.query(
    `select oi.id, oi.product_id, oi.quantity, p.name, oi.added_by_customer_id,
       coalesce(c.name, c.preferred_name) as added_by_name, c.phone_number as added_by_phone,
       coalesce(
         (select json_object_agg(oa.question_id, oa.answer) from order_item_answer oa where oa.order_item_id = oi.id),
         '{}'
       ) as answers
     from order_item oi
       join product p on p.id = oi.product_id
       left join customers c on c.id = oi.added_by_customer_id
     where oi.order_id = $1`,
    [order.id]
  );
  if (!items.length) return null;
  const labelFor = (customerId, name, phone) => {
    if (customerId === actingCustomerId) return 'You';
    return name || phone || 'a guest';
  };
  return {
    items: items.map((i) => ({
      id: i.id,
      productId: i.product_id,
      quantity: i.quantity,
      name: i.name,
      answers: i.answers || {},
      addedBy: i.added_by_customer_id || null,
      addedByLabel: labelFor(i.added_by_customer_id, i.added_by_name, i.added_by_phone),
    })),
    total: Number(order.total) || 0,
  };
}

router.get('/:qrToken', async (req, res) => {
  const table = await resolveTable(req.params.qrToken);
  if (!table) return res.status(404).send('Table not found.');
  const session = await openSessionFor(table);
  // Joint dine-in, Stage 1: whoever's actually opening the page right now
  // (see resolveActingCustomer) gets recorded as part of this sitting the
  // moment the page loads, same as a scan does -- "the first time each
  // guest actually interacts with the table."
  const actingCustomer = session ? await resolveActingCustomer(session, req) : null;
  if (session && actingCustomer) await upsertTableGuest(session.id, actingCustomer.id);
  // Same breadcrumb refresh menu-page.js's own GET route does -- keeps the
  // web-chat window alive for a guest who takes a while building their
  // basket here, so /review's own isViaWebChat check further down doesn't
  // go stale on them.
  if (actingCustomer && isViaWebChat(actingCustomer)) {
    await pool.query('update customers set web_chat_active_at = now() where id = $1', [actingCustomer.id]);
  }
  const [products, waNumber, pendingOrder] = await Promise.all([
    menuForBranch(table.branch_id),
    resolveWaNumber(table.branch_id),
    pendingOrderPayload(session, table, actingCustomer?.id || null),
  ]);
  // guestToken -- carried forward onto every fetch this page makes on its
  // own (review submit, the 15s poll) so the server keeps knowing who's
  // asking without the qrToken itself (shared by the whole table) having
  // to say. ensureMenuToken here as a defensive fallback only -- in the
  // normal path this guest already has one, handed to them the moment
  // flow.js sent their own copy of this link (handleDineinButtonTap).
  const guestToken = actingCustomer ? await ensureMenuToken(actingCustomer) : null;
  const qs = (extra) => {
    const params = new URLSearchParams(extra || {});
    if (guestToken) params.set('g', guestToken);
    const s = params.toString();
    return s ? `?${s}` : '';
  };
  res.set('Content-Type', 'text/html').send(
    renderMenuPage({
      reviewPath: `/t/${req.params.qrToken}/review${qs()}`,
      pollPath: session ? `/t/${req.params.qrToken}/menu.json${qs()}` : null,
      // Chidera, 2026-09-24: "the web menu should have a back to chat that
      // takes back to web chat." Same isViaWebChat gate /review's own
      // channel flip already uses -- only real when this guest actually
      // has a chat thread to go back to.
      webChatPath: actingCustomer && isViaWebChat(actingCustomer) ? `/wa/${guestToken}` : null,
      businessName: table.business_name,
      subtitle: `Table ${table.label} · ${table.branch_name}`,
      coverPhotoVersion: table.cover_photo_version,
      waNumber,
      products,
      pendingOrder,
      initialCategory: req.query.cat || null,
    })
  );
});

async function findOpenOrderForSession(session) {
  if (!session) return null;
  const { rows } = await pool.query(
    `select * from "order" where session_id = $1 and status not in ('completed', 'cancelled') order by created_at desc limit 1`,
    [session.id]
  );
  return rows[0] || null;
}

// The FULL order_payment row (payStatusPayload's own `payments` query
// below only selects display columns, not `reference` -- needed here for
// ensureDynamicPosAccount/checkMoniepointPaymentPaid to actually check
// with Moniepoint).
async function findMyPendingPayment(order, actingCustomerId) {
  if (!actingCustomerId) return null;
  const { rows } = await pool.query(
    `select * from order_payment where order_id = $1 and status = 'pending' and paid_by_customer_id = $2 order by created_at desc limit 1`,
    [order.id, actingCustomerId]
  );
  return rows[0] || null;
}

// Joint dine-in, Stage 3: everything the pay page (and its poll) needs to
// show who's here, what they each added, who's already paid for what,
// and what's genuinely still outstanding. Shared between the initial GET
// render and the JSON poll below -- one place computing this, not two
// that could drift.
async function payStatusPayload(order, session, actingCustomerId) {
  const { rows: items } = await pool.query(
    `select oi.id, oi.quantity, oi.price, p.name, oi.added_by_customer_id,
       coalesce(c.name, c.preferred_name) as added_by_name, c.phone_number as added_by_phone
     from order_item oi
       join product p on p.id = oi.product_id
       left join customers c on c.id = oi.added_by_customer_id
     where oi.order_id = $1`,
    [order.id]
  );
  const { rows: guestRows } = await pool.query(
    `select c.id, coalesce(c.name, c.preferred_name) as name, c.phone_number
     from customers c
     where c.id in (
       select customer_id from table_session_guest where session_id = $1
       union select customer_id from table_session where id = $1
     )`,
    [session.id]
  );
  // Chidera, 2026-09-20: "classified by the names of people on the
  // table... or their number when they dont put a name" -- same as
  // pendingOrderPayload above.
  const nameFor = (id, fallbackName, phone) => {
    if (id === actingCustomerId) return 'You';
    return fallbackName || phone || 'a guest';
  };
  const { rows: payments } = await pool.query(
    `select id, amount, status, covers_item_ids, paid_by_customer_id from order_payment where order_id = $1 order by created_at`,
    [order.id]
  );
  const itemById = new Map(items.map((i) => [i.id, i]));
  const total = items.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0);
  const confirmedTotal = payments
    .filter((p) => p.status === 'confirmed')
    .reduce((sum, p) => {
      if (p.covers_item_ids === null) return total; // a whole-order payment covers everything, regardless of amount rounding
      return sum + Number(p.amount);
    }, 0);

  // Chidera, 2026-09-20, real report: "when i refreshed that payment page
  // it accommodated a third pending payment that would cause an excess
  // payout." Root cause: a refresh always reloaded the page back at "Who
  // are you paying for?", with the guest-selection checkboxes reset to
  // just this guest -- if they'd originally requested a DIFFERENT
  // coverage (say, the whole table), tapping "Request payment amount"
  // again after the reset created a genuinely different-shaped payment
  // (createOrderPayment's own dedup only matches an EXACT same coverage),
  // not a duplicate of the first. Two (or three) real pending payments
  // then sit against the same order at once, any of which a real POS
  // transaction could independently match and confirm -- exactly the
  // "excess payout" risk. myPendingPayment is this guest's own most
  // recent pending request, if any; the page now opens straight into
  // showing it instead of the selection screen, so a refresh can never
  // trigger a second, different request in the first place.
  const myPendingPayment = payments.find((p) => p.status === 'pending' && p.paid_by_customer_id === actingCustomerId) || null;

  return {
    items: items.map((i) => ({
      id: i.id,
      name: i.name,
      price: Number(i.price),
      quantity: i.quantity,
      addedBy: i.added_by_customer_id,
      addedByLabel: nameFor(i.added_by_customer_id, i.added_by_name, i.added_by_phone),
    })),
    guests: guestRows.map((g) => ({ id: g.id, label: nameFor(g.id, g.name, g.phone_number) })),
    selfId: actingCustomerId,
    payments: payments.map((p) => ({
      id: p.id,
      amount: Number(p.amount),
      status: p.status,
      coversLabel: p.covers_item_ids === null
        ? 'Whole table'
        : [...new Set(p.covers_item_ids.map((id) => itemById.get(id)?.added_by_customer_id).filter(Boolean))]
            .map((id) => nameFor(id, items.find((i) => i.added_by_customer_id === id)?.added_by_name))
            .join(' & ') || 'Some items',
    })),
    myPendingAmount: myPendingPayment ? Number(myPendingPayment.amount) : null,
    total,
    outstanding: Math.max(0, total - confirmedTotal),
    completed: order.status === 'completed',
  };
}

// Joint dine-in, Stage 2: where the "Ready to pay" WhatsApp button
// (flow.js's notifyGuestsReadyToPay, sent the moment staff taps "Served")
// actually opens. Public, token-authenticated like every other route in
// this file. Stage 3: the guest here picks who they're paying for (just
// themselves, or grouped with other guests already at the table) and
// requests a payment amount -- POS (a real POS terminal, Moniepoint's
// webhook auto-confirms the match) or, "LET DINE IN SUPPORT PAYSTACK O",
// a real Paystack card payment (engine/payment.js's
// initializeOrderPaymentPaystackTransaction), depending on the business's
// own payment_config.provider.
router.get('/:qrToken/pay', async (req, res) => {
  const table = await resolveTable(req.params.qrToken);
  if (!table) return res.status(404).send('Table not found.');
  const session = await openSessionFor(table);
  const order = await findOpenOrderForSession(session);
  if (!order) return res.status(404).send('No open order for this table right now.');
  const actingCustomer = await resolveActingCustomer(session, req);
  // Same breadcrumb as the /:qrToken GET above -- completePayment (fired
  // later from a webhook or staff's POS claim tap, no live customer object
  // in hand) checks this freshness to decide whether the payment-confirmed
  // message can be a free bubble instead of a real send.
  if (actingCustomer && isViaWebChat(actingCustomer)) {
    await pool.query('update customers set web_chat_active_at = now() where id = $1', [actingCustomer.id]);
  }
  const status = await payStatusPayload(order, session, actingCustomer?.id || null);
  const guestToken = actingCustomer ? await ensureMenuToken(actingCustomer) : null;
  const qs = guestToken ? `?g=${guestToken}` : '';
  // Chidera, 2026-09-20: "i need pos to work now for both online and in
  // house... transfer will give them number on pos while card the bot
  // just waits to auto confirm payment." Only sent to the page when POS is
  // actually the business's chosen provider -- everyone else keeps
  // today's generic "pay at the counter or POS terminal" wording
  // unchanged (payment_config's own schema comment: no row/no provider
  // must never change existing behavior).
  const paymentConfig = await getPaymentConfig();
  let posTransfer =
    paymentConfig?.provider === 'pos' && paymentConfig.transfer_account_number && paymentConfig.transfer_account_name && paymentConfig.transfer_bank_name
      ? {
          accountNumber: paymentConfig.transfer_account_number,
          accountName: paymentConfig.transfer_account_name,
          bankName: paymentConfig.transfer_bank_name,
        }
      : null;
  let dynamicExpiresAt = null;
  let dynamicReadyAt = null;
  // Chidera, 2026-09-21: "THE IDEA IS FOR IT TO APROVE AUTO CONFIRME HOW
  // PAYSTACK DOES" -- a real, one-time account for THIS guest's own
  // already-pending payment (the "reopen straight into it" resume case),
  // confirmed live. A guest who hasn't requested an amount yet gets this
  // from /pay/create instead (nothing to generate a dynamic account FOR
  // until a real order_payment row exists).
  let paystackUrl = null;
  if (posTransfer && actingCustomer) {
    const myPending = await findMyPendingPayment(order, actingCustomer.id);
    if (myPending) {
      const dynamic = await ensureDynamicPosAccount(myPending);
      if (dynamic) {
        posTransfer = { accountNumber: dynamic.accountNumber, accountName: dynamic.accountName, bankName: posTransfer.bankName };
        dynamicExpiresAt = dynamic.expiresAt;
        dynamicReadyAt = dynamic.readyAt;
      }
    }
  } else if (paymentConfig?.provider === 'paystack' && actingCustomer) {
    const myPending = await findMyPendingPayment(order, actingCustomer.id);
    if (myPending) {
      // Reuses an already-generated link rather than initializing a fresh
      // Paystack transaction on every page view -- same "don't do this
      // more than once per payment for no reason" discipline as the POS
      // dynamic account above.
      paystackUrl = myPending.payment_link_url
        || (await initializeOrderPaymentPaystackTransaction({ orderPayment: myPending, order, customer: actingCustomer, amount: Number(myPending.amount) }).catch((err) => {
          console.error('initializeOrderPaymentPaystackTransaction failed:', err.message);
          return null;
        }));
    }
  }
  res.set('Content-Type', 'text/html').send(
    renderPayPage({
      businessName: table.business_name,
      tableLabel: table.label,
      coverPhotoVersion: table.cover_photo_version,
      status,
      statusPath: `/t/${req.params.qrToken}/pay/status${qs}`,
      createPath: `/t/${req.params.qrToken}/pay/create${qs}`,
      claimPath: `/t/${req.params.qrToken}/pay/claim${qs}`,
      posTransfer,
      dynamicExpiresAt,
      dynamicReadyAt,
      paystackUrl,
    })
  );
});

// Polled every 15s by the pay page itself, same pattern as the shared
// order page's own poll (Stage 1) -- so a guest sees "Payment confirmed!"
// the moment Moniepoint's webhook auto-matches their POS payment, without
// having to refresh.
router.get('/:qrToken/pay/status', async (req, res) => {
  const table = await resolveTable(req.params.qrToken);
  if (!table) return res.status(404).json({ error: 'Table not found.' });
  const session = await openSessionFor(table);
  const order = await findOpenOrderForSession(session);
  if (!order) return res.json({ completed: true, items: [], guests: [], payments: [], total: 0, outstanding: 0 });
  const actingCustomer = await resolveActingCustomer(session, req);
  res.json(await payStatusPayload(order, session, actingCustomer?.id || null));
});

// The tapping guest's own selection of who they're paying for -- never
// trusted as-is (guestIds is validated against real table_session_guest
// membership inside createOrderPayment, same "never trust the client's
// own claim" discipline as every basket submit in this file).
router.post('/:qrToken/pay/create', async (req, res) => {
  const table = await resolveTable(req.params.qrToken);
  if (!table) return res.status(404).json({ error: 'Table not found.' });
  const session = await openSessionFor(table);
  const order = await findOpenOrderForSession(session);
  if (!order) return res.status(404).json({ error: 'No open order for this table right now.' });
  const actingCustomer = await resolveActingCustomer(session, req);
  if (!actingCustomer) return res.status(404).json({ error: 'Customer not found.' });
  const requested = Array.isArray(req.body?.guestIds) ? req.body.guestIds.map(String) : [];
  const guestIds = requested.includes(actingCustomer.id) ? requested : [...requested, actingCustomer.id];
  const payment = await createOrderPayment(order, guestIds, actingCustomer.id);
  // Chidera, 2026-09-21: "THE IDEA IS FOR IT TO APROVE AUTO CONFIRME HOW
  // PAYSTACK DOES" -- a real, one-time account for THIS payment, confirmed
  // live. Only attempted for POS providers with a static account already
  // set (payment_config's own schema comment) -- falls back to the
  // static one on any failure, same as the GET /pay route above.
  let posTransfer = null;
  let dynamicExpiresAt = null;
  let dynamicReadyAt = null;
  let paystackUrl = null;
  if (payment.status === 'pending') {
    const paymentConfig = await getPaymentConfig();
    if (paymentConfig?.provider === 'pos' && paymentConfig.transfer_account_number && paymentConfig.transfer_account_name && paymentConfig.transfer_bank_name) {
      const dynamic = await ensureDynamicPosAccount(payment);
      posTransfer = dynamic
        ? { accountNumber: dynamic.accountNumber, accountName: dynamic.accountName, bankName: paymentConfig.transfer_bank_name }
        : { accountNumber: paymentConfig.transfer_account_number, accountName: paymentConfig.transfer_account_name, bankName: paymentConfig.transfer_bank_name };
      dynamicExpiresAt = dynamic?.expiresAt || null;
      dynamicReadyAt = dynamic?.readyAt || null;
    } else if (paymentConfig?.provider === 'paystack') {
      // Chidera, 2026-09-21: "LET DINE IN SUPPORT PAYSTACK O" -- a real
      // Paystack transaction for THIS payment (a split share or the
      // whole table), keyed to order_payment, not the order as a whole.
      paystackUrl = await initializeOrderPaymentPaystackTransaction({ orderPayment: payment, order, customer: actingCustomer, amount: Number(payment.amount) }).catch((err) => {
        console.error('initializeOrderPaymentPaystackTransaction failed:', err.message);
        return null;
      });
    }
  }
  res.json({ ok: true, amount: Number(payment.amount), status: payment.status, posTransfer, dynamicExpiresAt, dynamicReadyAt, paystackUrl });
});

// Chidera, 2026-09-21: "THE IDEA IS FOR IT TO APROVE AUTO CONFIRME HOW
// PAYSTACK DOES" -- the pay page's own "I've sent it" button. Checks
// Moniepoint directly first and auto-confirms instantly if it already
// shows paid; only falls back to alerting staff if it doesn't (see
// notifyCustomerClaimedPosPayment's own comment for why that's never
// treated as a failure).
router.post('/:qrToken/pay/claim', async (req, res) => {
  const table = await resolveTable(req.params.qrToken);
  if (!table) return res.status(404).json({ error: 'Table not found.' });
  const session = await openSessionFor(table);
  const order = await findOpenOrderForSession(session);
  if (!order) return res.status(404).json({ error: 'No open order for this table right now.' });
  const actingCustomer = await resolveActingCustomer(session, req);
  if (!actingCustomer) return res.status(404).json({ error: 'Customer not found.' });
  const payment = await findMyPendingPayment(order, actingCustomer.id);
  await notifyCustomerClaimedPosPayment(payment, order, actingCustomer);
  res.json({ ok: true });
});
