// JSON API for the React dashboard (client/). Session-cookie authenticated,
// same auth as the old server-rendered UI it replaces -- these routes are
// the real source of truth for what a business's own dashboard can do.
import express from 'express';
import { pool } from '../lib/db.js';
import { findStaffByEmail, verifyPassword, hashPassword, requireStaffApi, requireEditorApi, requireEraAdmin, canEdit } from '../lib/auth.js';
import { parseMenuText, parseMenuImages, reconcileMenu } from '../engine/parse-menu.js';
import { sendStaffReply, completePayment, notifyReadyForPickup, resumeBotControl, takeOverConversation } from '../engine/flow.js';
import { costForTokens, INTRO, STANDARD, INTRO_ENDS } from '../lib/ai-pricing.js';
import { getWhatsappBusinessProfile, updateWhatsappBusinessProfile } from '../engine/whatsapp-profile.js';
import { getCatalogStatus, markCatalogConnected, syncAllProducts, syncBestEffort, deleteBestEffort } from '../engine/whatsapp-catalog.js';

export const router = express.Router();

// --- Auth ---------------------------------------------------------------

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const staff = email && (await findStaffByEmail(email));
  if (!staff || !(await verifyPassword(staff, password || ''))) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  req.session.staff = { id: staff.id, name: staff.name, role: staff.role };
  res.json({ staff: req.session.staff });
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({ staff: req.staff || null });
});

// ERA-admin-only, not staff-session gated -- has to sit above the
// router.use(requireStaffApi) line below, or it inherits a staff-login
// requirement it was never meant to have (requireEraAdmin already does its
// own, separate check via x-era-admin-token). This business's own real AI
// spend this calendar month, computed from every Claude call
// engine/claude.js logged (see ai_usage) -- not an estimate, since every
// business shares one ANTHROPIC_API_KEY and Anthropic's own billing can't
// split cost out per business. Read by ERA Dash OS's monitoring panel,
// never by this business's own staff.
router.get('/usage-summary', requireEraAdmin, async (req, res) => {
  // Summed in SQL, not fetched-then-reduced in JS -- at real scale (a busy
  // business logs one ai_usage row per Claude call, so potentially
  // thousands a day) pulling every row into Node every time this panel
  // polls would itself become the cost/performance problem this endpoint
  // exists to watch for. Split by the intro/standard pricing cutover so
  // each half can be priced at its own rate with one costForTokens() call.
  const { rows } = await pool.query(
    `select
       count(*) filter (where created_at < $1)  as calls_intro,
       count(*) filter (where created_at >= $1) as calls_standard,
       coalesce(sum(input_tokens) filter (where created_at < $1), 0)  as input_intro,
       coalesce(sum(input_tokens) filter (where created_at >= $1), 0) as input_standard,
       coalesce(sum(output_tokens) filter (where created_at < $1), 0)  as output_intro,
       coalesce(sum(output_tokens) filter (where created_at >= $1), 0) as output_standard,
       coalesce(sum(cache_creation_input_tokens) filter (where created_at < $1), 0)  as cache_write_intro,
       coalesce(sum(cache_creation_input_tokens) filter (where created_at >= $1), 0) as cache_write_standard,
       coalesce(sum(cache_read_input_tokens) filter (where created_at < $1), 0)  as cache_read_intro,
       coalesce(sum(cache_read_input_tokens) filter (where created_at >= $1), 0) as cache_read_standard
     from ai_usage where created_at >= date_trunc('month', now())`,
    [INTRO_ENDS]
  );
  const r = rows[0];
  const totalCostUsd =
    costForTokens(INTRO, {
      inputTokens: Number(r.input_intro),
      outputTokens: Number(r.output_intro),
      cacheCreationInputTokens: Number(r.cache_write_intro),
      cacheReadInputTokens: Number(r.cache_read_intro),
    }) +
    costForTokens(STANDARD, {
      inputTokens: Number(r.input_standard),
      outputTokens: Number(r.output_standard),
      cacheCreationInputTokens: Number(r.cache_write_standard),
      cacheReadInputTokens: Number(r.cache_read_standard),
    });
  // Last 30 minutes, not "this month" -- a monitoring check cares whether
  // Claude is failing RIGHT NOW, not whether it ever failed once weeks ago.
  const { rows: errorRows } = await pool.query(
    `select message from ai_errors where created_at >= now() - interval '30 minutes' order by created_at desc`
  );
  res.json({
    month: new Date().toISOString().slice(0, 7),
    totalCalls: Number(r.calls_intro) + Number(r.calls_standard),
    totalCostUsd: Number(totalCostUsd.toFixed(4)),
    recentErrorCount: errorRows.length,
    lastErrorMessage: errorRows[0]?.message || null,
  });
});

// ERA-admin-only, same trust boundary as /usage-summary above. Reuses
// signals every business already logs for its own dashboard --
// message.trigger, customers.handover_reason, ai_errors -- rather than a
// second, parallel logging path for the same facts. This is the counts
// half of ERA Dash OS's central "Bot Monitoring" panel; /monitor/feed
// below is the raw-content half.
//
// Two different audiences read this data, and only one of them is Chidera:
// kb_miss (bot doesn't know an answer), field_reprompt (customer's answer
// didn't parse), and handovers in general are normal day-to-day business
// operation -- that's the business owner's concern, visible in their own
// dashboard, not something that should alert the platform operator.
// codeErrorCount below is deliberately narrow: only signals that mean the
// shared engine itself is actually broken (an unhandled exception it had
// to recover from, or a real Claude/API call failure) -- that's the one
// thing Chidera is responsible for across every business. Everything else
// stays visible in the trigger/handover breakdown for context, it just
// doesn't drive the "Bot concerns" count or the WhatsApp alert threshold.
const INFO_TRIGGERS = ['kb_miss', 'error_recovery', 'field_reprompt'];

router.get('/monitor/summary', requireEraAdmin, async (req, res) => {
  const hours = Math.min(Number(req.query.hours) || 1, 24 * 7);
  const interval = `${hours} hours`;
  const [{ rows: triggerRows }, { rows: handoverRows }, { rows: aiErrorRows }] = await Promise.all([
    pool.query(
      `select trigger, count(*) as count from message
       where direction = 'outbound' and trigger = any($1) and created_at >= now() - $2::interval
       group by trigger`,
      [INFO_TRIGGERS, interval]
    ),
    pool.query(
      `select handover_reason, count(*) as count from customers
       where handover_at >= now() - $1::interval
       group by handover_reason`,
      [interval]
    ),
    pool.query(`select count(*) as count from ai_errors where created_at >= now() - $1::interval`, [interval]),
  ]);
  const aiErrors = Number(aiErrorRows[0].count);
  const errorRecoveryCount = triggerRows.find((r) => r.trigger === 'error_recovery')?.count ?? 0;
  res.json({
    hours,
    triggers: triggerRows.map((r) => ({ trigger: r.trigger, count: Number(r.count) })),
    handovers: handoverRows.map((r) => ({ reason: r.handover_reason, count: Number(r.count) })),
    aiErrors,
    // The number that actually matters for alerting: real code errors only.
    codeErrorCount: Number(errorRecoveryCount) + aiErrors,
  });
});

// Raw-content half of the same panel -- deliberately not gated behind any
// "flag" logic. The point Chidera asked for is to actually watch real
// conversations across every business from one place, not wait for the
// system to decide something is flag-worthy; concern-tagged rows (see
// CONCERN_TRIGGERS / handover_reason above) just get a visible highlight
// client-side, nothing here is filtered out.
router.get('/monitor/feed', requireEraAdmin, async (req, res) => {
  const hours = Math.min(Number(req.query.hours) || 6, 24 * 7);
  const { rows } = await pool.query(
    `select m.id, m.direction, m.channel, m.sender, m.body, m.trigger, m.created_at,
            c.id as customer_id, c.name as customer_name, c.phone_number, c.handled_by
     from message m
     join customers c on c.id = m.customer_id
     where m.created_at >= now() - $1::interval
     order by m.created_at desc
     limit 500`,
    [`${hours} hours`]
  );
  res.json(rows);
});

// Everything this business's own data actually is -- theirs to keep,
// regardless of what happens to the EBOS relationship itself. Two separate
// legitimate callers, so it sits above the staff-login gate below and
// checks both itself instead of picking one: the business's own owner/
// manager (self-service, from Settings > Download my data), or ERA
// directly via x-era-admin-token (scripts/offboard-business.mjs, which has
// no staff login of its own). Not a per-table pick-and-choose -- a
// business considering whether to trust handing their real operations to
// a bot deserves a real, complete answer to "can I get my data back".
router.get('/export', async (req, res) => {
  const isEraAdmin = process.env.EBOS_ADMIN_TOKEN && req.header('x-era-admin-token') === process.env.EBOS_ADMIN_TOKEN;
  const isOwnerOrManager = req.staff && canEdit(req.staff);
  if (!isEraAdmin && !isOwnerOrManager) return res.status(403).json({ error: 'Owner/manager login or ERA admin access required.' });

  const [business, customers, messages, orders, orderItems, bookings, deliveries, products, knowledgeBase, branches, documents] = await Promise.all([
    pool.query('select * from business limit 1'),
    pool.query('select * from customers order by created_at'),
    pool.query('select * from message order by created_at'),
    pool.query('select * from "order" order by created_at'),
    pool.query('select * from order_item'),
    pool.query('select * from booking order by created_at'),
    pool.query('select * from delivery'),
    pool.query('select * from product order by created_at'),
    pool.query('select * from knowledge_base order by created_at'),
    pool.query('select * from branch'),
    pool.query('select * from generated_document order by created_at'),
  ]);
  const bundle = {
    exportedAt: new Date().toISOString(),
    business: business.rows[0] || null,
    customers: customers.rows,
    messages: messages.rows,
    orders: orders.rows,
    orderItems: orderItems.rows,
    bookings: bookings.rows,
    deliveries: deliveries.rows,
    products: products.rows,
    knowledgeBase: knowledgeBase.rows,
    branches: branches.rows,
    documents: documents.rows,
  };
  const filename = `${(business.rows[0]?.name || 'ebos-business').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-export-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.json(bundle);
});

// --- WhatsApp Catalogue (Meta's native in-chat shop) ---------------------
// ERA-admin-only, same trust boundary as /usage-summary and /monitor above
// -- not something a business's own staff can see or trigger. See
// engine/whatsapp-catalog.js for why the "connect" step still needs one
// manual click in Meta Business Suite that no API call can do instead.
router.get('/whatsapp-catalog/status', requireEraAdmin, async (req, res) => {
  try {
    res.json(await getCatalogStatus());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/whatsapp-catalog/enable', requireEraAdmin, async (req, res) => {
  try {
    const result = await syncAllProducts({ requireEnabled: false });
    res.json({ ...result, ...(await getCatalogStatus()) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/whatsapp-catalog/resync', requireEraAdmin, async (req, res) => {
  try {
    res.json(await syncAllProducts({ requireEnabled: false }));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/whatsapp-catalog/confirm-connected', requireEraAdmin, async (req, res) => {
  await markCatalogConnected();
  res.json({ ok: true });
});

router.use(requireStaffApi);

router.post('/change-password', async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password are required.' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });

  const { rows } = await pool.query('select * from staff where id = $1', [req.staff.id]);
  const staff = rows[0];
  if (!staff || !(await verifyPassword(staff, currentPassword))) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }

  const hash = await hashPassword(newPassword);
  await pool.query('update staff set password_hash = $1 where id = $2', [hash, staff.id]);
  res.json({ ok: true });
});

// --- Orders ---------------------------------------------------------------

router.get('/orders', async (req, res) => {
  const { rows } = await pool.query(
    `select o.*, c.name as customer_name, c.phone_number as customer_phone, c.channel as customer_channel,
            (select coalesce(json_agg(json_build_object('name', p.name, 'quantity', oi.quantity)), '[]')
             from order_item oi join product p on p.id = oi.product_id where oi.order_id = o.id) as items
     from "order" o join customers c on c.id = o.customer_id
     order by o.created_at desc limit 200`
  );
  res.json(rows);
});

// Today's dashboard summary card. Defined before /orders/:id below even
// though the path shape (/orders/stats/today) can't actually collide with
// it (that only matches a single path segment) -- kept here anyway so the
// "specific route before :id" convention stays consistent everywhere in
// this file, after the bulk-import bug that convention exists to prevent.
router.get('/orders/stats/today', async (req, res) => {
  const [{ rows: totals }, { rows: answered }, { rows: busiest }] = await Promise.all([
    // Collected/Average count only orders both placed AND already paid --
    // there's no dedicated "paid at" timestamp on `order` (updated_at gets
    // bumped by unrelated activity, like getOpenOrder's staleness touch),
    // so this is the closest honest proxy: today's placed orders that have
    // since been paid, not strictly "paid today". Good enough for a
    // same-day summary card, not meant as an accounting close.
    pool.query(
      `select count(*) as orders, coalesce(sum(total) filter (where payment_status in ('confirmed', 'accepted')), 0) as collected
       from "order" where created_at >= date_trunc('day', now())`
    ),
    // "Answered in": for every bot/staff reply sent today, how long since
    // that same customer's most recent prior inbound message -- i.e. how
    // long the customer actually waited for that reply. Capped at 1 hour
    // so a reply to a customer who went quiet for days (picked back up
    // much later) doesn't skew the average into meaninglessness.
    pool.query(
      `select avg(extract(epoch from (m.created_at - prior.created_at))) as avg_seconds
       from message m
       join lateral (
         select created_at from message ic
         where ic.customer_id = m.customer_id and ic.direction = 'inbound' and ic.created_at < m.created_at
         order by ic.created_at desc limit 1
       ) prior on true
       where m.direction = 'outbound' and m.sender in ('bot', 'staff') and m.created_at >= date_trunc('day', now())
         and m.created_at - prior.created_at < interval '1 hour'`
    ),
    pool.query(
      `select date_trunc('hour', created_at) as hour, count(*) as count
       from "order" where created_at >= date_trunc('day', now())
       group by hour order by count desc limit 1`
    ),
  ]);

  const t = totals[0];
  const orders = Number(t.orders);
  const collected = Number(t.collected);
  const average = orders > 0 ? Math.round(collected / orders) : 0;
  const answeredSeconds = answered[0]?.avg_seconds != null ? Math.round(Number(answered[0].avg_seconds)) : null;
  const busiestHour = busiest[0]
    ? { start: busiest[0].hour, count: Number(busiest[0].count) }
    : null;

  res.json({ orders, collected, average, answeredSeconds, busiestHour });
});

router.get('/orders/:id', async (req, res) => {
  const { rows: orderRows } = await pool.query('select * from "order" where id = $1', [req.params.id]);
  const order = orderRows[0];
  if (!order) return res.status(404).json({ error: 'Not found.' });
  const { rows: items } = await pool.query(
    `select oi.*, p.name from order_item oi join product p on p.id = oi.product_id where oi.order_id = $1`,
    [order.id]
  );
  const { rows: customerRows } = await pool.query('select * from customers where id = $1', [order.customer_id]);
  const { rows: documents } = await pool.query('select * from generated_document where order_id = $1 order by created_at', [order.id]);
  const { rows: delivery } = await pool.query('select * from delivery where order_id = $1', [order.id]);
  res.json({ order, items, customer: customerRows[0] || null, documents, delivery: delivery[0] || null });
});

// Staff-triggered, not automatic -- "I'll let you know when to pick up" (the
// payment-received message for pickup orders) only becomes true once
// someone here actually clicks it, once the food genuinely is ready.
router.post('/orders/:id/notify-ready', requireEditorApi, async (req, res) => {
  try {
    await notifyReadyForPickup(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: `Could not notify customer: ${err.message}` });
  }
});

router.post('/orders/:id/status', requireEditorApi, async (req, res) => {
  const { status } = req.body;
  await pool.query('update "order" set status = $1, updated_at = now() where id = $2', [status, req.params.id]);
  // Staff marking an order completed (or cancelling it) is what actually
  // closes it for the bot too -- engine_state stays at 'fulfilment'
  // indefinitely after payment on purpose (see engine/flow.js's
  // completePayment), so a customer can still message in to add something
  // right up until staff says the order is genuinely done.
  if (status === 'completed' || status === 'cancelled') {
    await pool.query('update "order" set engine_state = $1 where id = $2', [status, req.params.id]);
  }
  res.json({ ok: true });
});

// Staff confirming a manual/bank-transfer payment (after checking the
// customer's submitted proof image) goes through the exact same
// completePayment() the Paystack webhook uses -- receipt, delivery booking,
// customer notification, all of it -- rather than a second, thinner path
// that could drift out of sync with what a real automated payment does.
router.post('/orders/:id/confirm-payment', requireEditorApi, async (req, res) => {
  const { rows } = await pool.query(`update "order" set payment_status = 'confirmed' where id = $1 returning *`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found.' });
  try {
    await completePayment(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: `Payment marked confirmed, but finishing the order failed: ${err.message}` });
  }
});

// --- Bookings (Section 7.2-7.4 business types, listed the same way) -------

router.get('/bookings', async (req, res) => {
  const { rows } = await pool.query(
    `select b.*, c.name as customer_name, c.phone_number as customer_phone, p.name as product_name
     from booking b join customers c on c.id = b.customer_id join product p on p.id = b.product_id
     order by b.date desc limit 200`
  );
  res.json(rows);
});

// --- Catalogue --------------------------------------------------------

router.get('/catalogue', async (req, res) => {
  const { rows } = await pool.query('select * from product order by created_at desc');
  res.json(rows);
});

router.post('/catalogue', requireEditorApi, async (req, res) => {
  const f = req.body;
  const { rows } = await pool.query(
    'insert into product (name, description, price, availability_type, duration_minutes, category, image_data_url) values ($1, $2, $3, $4, $5, $6, $7) returning *',
    [f.name, f.description || null, f.price, f.availability_type || 'stock', f.duration_minutes || null, f.category || null, f.image_data_url || null]
  );
  syncBestEffort();
  res.status(201).json(rows[0]);
});

// Deliberately defined before /catalogue/:id below -- Express would
// otherwise match "bulk-import" as an :id (this was a real live bug: the
// old bulk-import route sat AFTER :id in file order, so every bulk-import
// call actually hit the update-by-id handler with id="bulk-import" and
// failed on the uuid cast, confirmed via a real test call). Same fix
// pattern as /conversations/search vs /conversations/:id above.
//
// Bulk entry -- paste the whole menu as text, or send photo(s) of it
// (images: [{ mediaType, base64 }]). Never writes straight to the live
// catalogue: every recognised item is reconciled against what's already on
// file (reconcileMenu) and staged as a proposal (product.import_status) for
// a human to approve via the routes below -- see schema.sql's comment on
// why. A photo-based import also replaces the stored menu_photo(s) so the
// bot has the actual images to forward to customers (engine/flow.js); a
// text-only import leaves any existing menu photo(s) alone.
router.post('/catalogue/bulk-import', requireEditorApi, async (req, res) => {
  const { text, images } = req.body;
  if (!text && !images?.length) return res.status(400).json({ error: 'Paste some menu text or attach photo(s).' });
  let items;
  try {
    items = images?.length ? await parseMenuImages(images) : await parseMenuText(text);
  } catch (err) {
    return res.status(502).json({ error: `Could not read the menu: ${err.message}` });
  }
  if (!items.length) return res.status(422).json({ error: "Couldn't find any priced items in that -- try again with clearer text or clearer photo(s)." });

  // Reconciles against confirmed-live items only (import_status is null) --
  // if an earlier import is still awaiting review, resolve that one first;
  // re-importing on top of it isn't reconciled against those in-flight
  // proposals, only against what's actually settled.
  const { rows: existing } = await pool.query(
    `select id, name, price, category from product where import_status is null order by name`
  );
  const { matches, newItems, removedIds } = await reconcileMenu(existing, items);

  let changed = 0;
  for (const m of matches) {
    const current = existing.find((e) => e.id === m.existingId);
    const samePrice = Number(current.price) === Number(m.price);
    const sameName = current.name === m.name;
    const sameCategory = (current.category || null) === (m.category || null);
    if (samePrice && sameName && sameCategory) continue; // Genuinely unchanged -- nothing to stage.
    await pool.query(
      `update product set import_status = 'changed', pending_name = $1, pending_description = $2, pending_price = $3, pending_category = $4 where id = $5`,
      [m.name, m.description, m.price, m.category, m.existingId]
    );
    changed++;
  }
  for (const item of newItems) {
    await pool.query(
      `insert into product (name, description, price, availability_type, category, import_status) values ($1, $2, $3, 'stock', $4, 'new')`,
      [item.name, item.description, item.price, item.category]
    );
  }
  if (removedIds.length) {
    await pool.query(`update product set import_status = 'removed' where id = any($1)`, [removedIds]);
  }

  if (images?.length) {
    await pool.query('delete from menu_photo');
    for (let i = 0; i < images.length; i++) {
      const dataUrl = `data:${images[i].mediaType};base64,${images[i].base64}`;
      await pool.query('insert into menu_photo (data_url, position) values ($1, $2)', [dataUrl, i]);
    }
  }

  res.status(201).json({ new: newItems.length, changed, removed: removedIds.length });
});

// The staged diff awaiting human review -- see product.import_status.
router.get('/catalogue/import/pending', async (req, res) => {
  const { rows } = await pool.query(`select * from product where import_status is not null order by import_status, name`);
  res.json(rows);
});

router.post('/catalogue/import/:id/approve', requireEditorApi, async (req, res) => {
  const { rows } = await pool.query('select * from product where id = $1', [req.params.id]);
  const product = rows[0];
  if (!product || !product.import_status) return res.status(404).json({ error: 'Not found.' });
  if (product.import_status === 'removed') {
    await pool.query('delete from product where id = $1', [req.params.id]);
    deleteBestEffort(req.params.id);
    return res.json({ ok: true, deleted: true });
  }
  if (product.import_status === 'changed') {
    await pool.query(
      `update product set name = coalesce(pending_name, name), description = pending_description, price = coalesce(pending_price, price), category = pending_category,
         import_status = null, pending_name = null, pending_description = null, pending_price = null, pending_category = null where id = $1`,
      [req.params.id]
    );
  } else {
    // 'new'
    await pool.query('update product set import_status = null where id = $1', [req.params.id]);
  }
  syncBestEffort();
  const { rows: updated } = await pool.query('select * from product where id = $1', [req.params.id]);
  res.json(updated[0]);
});

router.post('/catalogue/import/:id/reject', requireEditorApi, async (req, res) => {
  const { rows } = await pool.query('select * from product where id = $1', [req.params.id]);
  const product = rows[0];
  if (!product || !product.import_status) return res.status(404).json({ error: 'Not found.' });
  if (product.import_status === 'new') {
    await pool.query('delete from product where id = $1', [req.params.id]);
    return res.json({ ok: true, deleted: true });
  }
  // 'changed' or 'removed' -- discard the proposal, keep the live item as it was.
  await pool.query(
    `update product set import_status = null, pending_name = null, pending_description = null, pending_price = null, pending_category = null where id = $1`,
    [req.params.id]
  );
  const { rows: updated } = await pool.query('select * from product where id = $1', [req.params.id]);
  res.json(updated[0]);
});

router.post('/catalogue/:id', requireEditorApi, async (req, res) => {
  const f = req.body;
  const { rows } = await pool.query(
    'update product set name = $1, description = $2, price = $3, availability_type = $4, duration_minutes = $5, category = $6, image_data_url = coalesce($7, image_data_url) where id = $8 returning *',
    [f.name, f.description || null, f.price, f.availability_type || 'stock', f.duration_minutes || null, f.category || null, f.image_data_url || null, req.params.id]
  );
  syncBestEffort();
  res.json(rows[0]);
});

router.post('/catalogue/:id/toggle', requireEditorApi, async (req, res) => {
  const { rows } = await pool.query('update product set availability = not availability where id = $1 returning *', [req.params.id]);
  syncBestEffort();
  res.json(rows[0]);
});

router.delete('/catalogue/:id', requireEditorApi, async (req, res) => {
  await pool.query('delete from product where id = $1', [req.params.id]);
  deleteBestEffort(req.params.id);
  res.json({ ok: true });
});

// --- Conversations --------------------------------------------------------

// last_message/last_message_at are stamped straight onto customers by
// engine/flow.js's logMessage, so this is a plain indexed sort -- cost stays
// the same whether there are 200 customers or 200,000, instead of the old
// per-row correlated subquery into message. A customer who's gone quiet just
// falls out of this top-200 window; /conversations/search below is how staff
// still reach them.
router.get('/conversations', async (req, res) => {
  const { rows } = await pool.query(`select * from customers order by last_message_at desc nulls last limit 200`);
  res.json(rows);
});

// The handover queue: every customer the bot has (or an app-reply has) put
// into staff's hands -- complaints, questions it couldn't answer, payment
// confirmations, anything requiring a real person. Oldest handover first,
// not most-recent-message first, so whoever's been waiting longest surfaces
// at the top instead of getting buried by newer chatter elsewhere.
// Deliberately defined before the /:id route below, same reason as /search.
router.get('/conversations/needs-attention', async (req, res) => {
  const { rows } = await pool.query(
    `select * from customers where handled_by = 'staff' order by handover_at asc nulls last limit 200`
  );
  res.json(rows);
});

// Deliberately defined before the /:id route below -- Express would
// otherwise match "search" as an :id. Plain ilike scan, not another indexed
// hot path: this only runs on a deliberate manual lookup by staff, not once
// per message like the list above, so it doesn't need the same treatment.
router.get('/conversations/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const { rows } = await pool.query(
    `select * from customers
     where phone_number ilike $1 || '%' or channel_id ilike $1 || '%' or name ilike '%' || $1 || '%'
     order by last_message_at desc nulls last
     limit 20`,
    [q]
  );
  res.json(rows);
});

router.get('/conversations/:id', async (req, res) => {
  const { rows: customerRows } = await pool.query('select * from customers where id = $1', [req.params.id]);
  if (!customerRows[0]) return res.status(404).json({ error: 'Not found.' });
  const { rows: messages } = await pool.query('select * from message where customer_id = $1 order by created_at', [req.params.id]);
  res.json({ customer: customerRows[0], messages });
});

router.post('/conversations/:id/send', async (req, res) => {
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Message text is required.' });
  try {
    await sendStaffReply(req.params.id, text, req.staff.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: `Could not send: ${err.message}` });
  }
});

// Not just a flag flip -- resumeBotControl replays whatever the customer
// told staff since the handover through the real order pipeline, so the
// bot picks up from where staff actually left it (already gave their
// order? straight to payment) instead of re-asking from scratch.
router.post('/conversations/:id/return-to-bot', async (req, res) => {
  await resumeBotControl(req.params.id);
  res.json({ ok: true });
});

// Claims the thread before staff has typed anything -- see
// takeOverConversation's comment in flow.js for why this exists as its own
// step instead of just relying on the first reply to mark the takeover.
router.post('/conversations/:id/take-over', async (req, res) => {
  await takeOverConversation(req.params.id, req.staff.id);
  res.json({ ok: true });
});

// --- Knowledge base ---------------------------------------------------

router.get('/knowledge-base', async (req, res) => {
  const { rows } = await pool.query('select * from knowledge_base order by position');
  res.json(rows);
});

router.post('/knowledge-base', requireEditorApi, async (req, res) => {
  const { rows } = await pool.query('insert into knowledge_base (question, answer) values ($1, $2) returning *', [req.body.question, req.body.answer]);
  res.status(201).json(rows[0]);
});

router.post('/knowledge-base/:id', requireEditorApi, async (req, res) => {
  const { rows } = await pool.query(
    'update knowledge_base set question = $1, answer = $2 where id = $3 returning *',
    [req.body.question, req.body.answer, req.params.id]
  );
  res.json(rows[0]);
});

router.delete('/knowledge-base/:id', requireEditorApi, async (req, res) => {
  await pool.query('delete from knowledge_base where id = $1', [req.params.id]);
  res.json({ ok: true });
});

// --- Train the bot: bot_field + bot_state ----------------------------

router.get('/bot-fields', async (req, res) => {
  const { rows } = await pool.query('select * from bot_field order by key');
  res.json(rows);
});

router.post('/bot-fields', requireEraAdmin, async (req, res) => {
  const f = req.body;
  const { rows } = await pool.query(
    `insert into bot_field (key, label, question, type, choices, examples, required_for_state) values ($1, $2, $3, $4, $5, $6, $7) returning *`,
    [f.key, f.label, f.question, f.type || 'text', f.choices || null, f.examples || null, f.required_for_state || null]
  );
  res.status(201).json(rows[0]);
});

router.post('/bot-fields/:key', requireEraAdmin, async (req, res) => {
  const f = req.body;
  const { rows } = await pool.query(
    `update bot_field set label = $1, question = $2, type = $3, choices = $4, examples = $5 where key = $6 returning *`,
    [f.label, f.question, f.type, f.choices || null, f.examples || null, req.params.key]
  );
  res.json(rows[0]);
});

router.delete('/bot-fields/:key', requireEraAdmin, async (req, res) => {
  await pool.query('delete from bot_field where key = $1', [req.params.key]);
  res.json({ ok: true });
});

router.get('/bot-states', async (req, res) => {
  const { rows } = await pool.query('select * from bot_state order by label');
  res.json(rows);
});

// Position is the only thing the canvas itself writes on drag -- editing
// the actual flow (allowed_next) is a deliberate separate action, not a
// side effect of moving a box around.
router.post('/bot-states/:key/position', requireEraAdmin, async (req, res) => {
  const { x, y } = req.body;
  await pool.query('update bot_state set position_x = $1, position_y = $2 where key = $3', [x, y, req.params.key]);
  res.json({ ok: true });
});

router.post('/bot-states/:key/transitions', requireEraAdmin, async (req, res) => {
  await pool.query('update bot_state set allowed_next = $1 where key = $2', [req.body.allowed_next || [], req.params.key]);
  res.json({ ok: true });
});

// --- Roles and numbers (staff) -----------------------------------------

router.get('/staff', async (req, res) => {
  const { rows } = await pool.query('select id, name, phone_number, email, role, status, handover_alerts, created_at from staff order by created_at');
  res.json(rows);
});

router.post('/staff', requireEditorApi, async (req, res) => {
  const f = req.body;
  const passwordHash = await hashPassword(f.password);
  const { rows } = await pool.query(
    'insert into staff (name, phone_number, email, password_hash, role) values ($1, $2, $3, $4, $5) returning id, name, phone_number, email, role, status',
    [f.name, f.phone_number || null, f.email.trim().toLowerCase(), passwordHash, f.role]
  );
  res.status(201).json(rows[0]);
});

router.post('/staff/:id/status', requireEditorApi, async (req, res) => {
  const { rows } = await pool.query('update staff set status = $1 where id = $2 returning id, status', [req.body.status, req.params.id]);
  res.json(rows[0]);
});

// A staff member needs a phone number on file before a handover alert can
// reach them -- toggling this on with no number set would silently do
// nothing, so that's rejected here rather than failing quietly later.
router.post('/staff/:id/handover-alerts', requireEditorApi, async (req, res) => {
  const { rows: existing } = await pool.query('select phone_number from staff where id = $1', [req.params.id]);
  if (!existing[0]) return res.status(404).json({ error: 'Staff member not found.' });
  if (req.body.handover_alerts && !existing[0].phone_number) {
    return res.status(400).json({ error: 'Add a phone number for this staff member first.' });
  }
  const { rows } = await pool.query('update staff set handover_alerts = $1 where id = $2 returning id, handover_alerts', [
    !!req.body.handover_alerts,
    req.params.id,
  ]);
  res.json(rows[0]);
});

// --- Generated documents -----------------------------------------------

router.get('/documents', async (req, res) => {
  const { rows } = await pool.query('select * from generated_document order by created_at desc limit 200');
  res.json(rows);
});

// --- Settings (the single business row) --------------------------------

router.get('/business', async (req, res) => {
  const { rows } = await pool.query(
    'select id, name, type, phone_number, address, operating_hours, delivery_enabled, whatsapp_connection, handover_number, bank_name, bank_account_number, bank_account_name, logo_data_url, brand_color from business limit 1'
  );
  res.json(rows[0] || null);
});

// Which Instagram account (if any) is actually connected right now, read
// live from Meta rather than just echoing back the stored user ID -- a
// real username/profile picture is what actually lets staff (or a Meta App
// Review reviewer) confirm the right account is linked, not just an opaque
// numeric ID. instagram_business_basic is exactly the permission this
// exercises.
router.get('/settings/instagram-status', async (req, res) => {
  const igUserId = process.env.INSTAGRAM_USER_ID;
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!igUserId || !accessToken) return res.json({ connected: false });
  try {
    const igRes = await fetch(`https://graph.instagram.com/v23.0/${igUserId}?fields=username,name,profile_picture_url&access_token=${accessToken}`);
    if (!igRes.ok) return res.json({ connected: false, error: `Instagram returned ${igRes.status}` });
    const profile = await igRes.json();
    res.json({ connected: true, username: profile.username, name: profile.name, profilePictureUrl: profile.profile_picture_url });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

// --- WhatsApp Business Profile (customer-facing: About, description,
// email, address, websites, category) -- separate from the /business route
// above, which only drives the bot's own behaviour.

router.get('/whatsapp-profile', async (req, res) => {
  try {
    res.json(await getWhatsappBusinessProfile());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/whatsapp-profile', requireEditorApi, async (req, res) => {
  const f = req.body;
  const fields = {};
  if (f.about !== undefined) fields.about = f.about;
  if (f.description !== undefined) fields.description = f.description;
  if (f.email !== undefined) fields.email = f.email;
  if (f.address !== undefined) fields.address = f.address;
  if (f.vertical !== undefined) fields.vertical = f.vertical;
  if (f.websites !== undefined) fields.websites = Array.isArray(f.websites) ? f.websites.filter(Boolean).slice(0, 2) : [];
  try {
    await updateWhatsappBusinessProfile(fields);
    res.json(await getWhatsappBusinessProfile());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/business', requireEditorApi, async (req, res) => {
  const f = req.body;
  const { rows } = await pool.query(
    `update business set name = $1, address = $2, phone_number = $3, delivery_enabled = $4, whatsapp_connection = $5,
       handover_number = $6, bank_name = $7, bank_account_number = $8, bank_account_name = $9,
       logo_data_url = $10, brand_color = $11
     where id = (select id from business limit 1) returning *`,
    [
      f.name,
      f.address || null,
      f.phone_number || null,
      Boolean(f.delivery_enabled),
      f.whatsapp_connection || null,
      f.handover_number || null,
      f.bank_name || null,
      f.bank_account_number || null,
      f.bank_account_name || null,
      f.logo_data_url || null,
      f.brand_color || '#111827',
    ]
  );
  res.json(rows[0]);
});

// --- Branches -- optional, only matters for a business with more than one
// physical location. Real business data (like catalogue), so any owner or
// manager can manage it, unlike bot config.
router.get('/branches', async (req, res) => {
  const { rows } = await pool.query('select * from branch order by name');
  res.json(rows);
});

router.post('/branches', requireEditorApi, async (req, res) => {
  const f = req.body;
  const { rows } = await pool.query(
    'insert into branch (name, address, phone_number, operating_hours) values ($1, $2, $3, $4) returning *',
    [f.name, f.address, f.phone_number || null, f.operating_hours || null]
  );
  res.status(201).json(rows[0]);
});

router.post('/branches/:id', requireEditorApi, async (req, res) => {
  const f = req.body;
  const { rows } = await pool.query(
    'update branch set name = $1, address = $2, phone_number = $3, operating_hours = $4 where id = $5 returning *',
    [f.name, f.address, f.phone_number || null, f.operating_hours || null, req.params.id]
  );
  res.json(rows[0]);
});

router.delete('/branches/:id', requireEditorApi, async (req, res) => {
  await pool.query('delete from branch where id = $1', [req.params.id]);
  res.json({ ok: true });
});
