// JSON API for the React dashboard (client/). Session-cookie authenticated,
// same auth as the old server-rendered UI it replaces -- these routes are
// the real source of truth for what a business's own dashboard can do.
import express from 'express';
import { pool } from '../lib/db.js';
import {
  findStaffByEmail,
  verifyPassword,
  hashPassword,
  requireStaffApi,
  requireEditorApi,
  requireEraAdmin,
  canEdit,
  scopeToBranch,
  findPinStaffForBranch,
  findPinStaffById,
  verifyPin,
  hashPin,
  isPinTier,
  requireFullAccessApi,
  logActivity,
} from '../lib/auth.js';
import { parseMenuText, parseMenuImages, reconcileMenu } from '../engine/parse-menu.js';
import { sendStaffReply, completePayment, notifyReadyForPickup, resumeBotControl, takeOverConversation, findOrCreateCustomer, newReference, sendOutreachMessage } from '../engine/flow.js';
import { resolveZoneForAddress, getDeliveryConfig } from '../engine/delivery-zones.js';
import { createDelivery } from '../engine/delivery.js';
import { costForTokens, INTRO, STANDARD, INTRO_ENDS } from '../lib/ai-pricing.js';
import { getWhatsappBusinessProfile, updateWhatsappBusinessProfile } from '../engine/whatsapp-profile.js';
import { getCatalogStatus, markCatalogConnected, syncAllProducts, syncBestEffort, deleteBestEffort } from '../engine/whatsapp-catalog.js';
import { router as deliveryRoutes } from './delivery.js';
import { router as voiceRoutes } from './voice.js';
import { encrypt } from '../lib/crypto.js';
import { maybeDispatchOwnRiders } from '../engine/delivery-dispatch.js';

export const router = express.Router();

// --- Auth ---------------------------------------------------------------

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const staff = email && (await findStaffByEmail(email));
  if (!staff || !(await verifyPassword(staff, password || ''))) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  req.session.staff = { id: staff.id, name: staff.name, role: staff.role, branch_id: staff.branch_id, branch_name: staff.branch_name, auth_type: staff.auth_type };
  res.json({ staff: req.session.staff });
});

// PIN-tier login (Tier 3 staff) -- pick a branch, pick a name, enter a
// 4-digit PIN. Never a bare "which staff has this PIN" lookup: always
// scoped to one exact branch_id + staff_id pair, see findPinStaffById's
// comment. Same generic failure message either way ("Incorrect name or
// PIN") so a wrong staff_id and a right-id-wrong-PIN are indistinguishable
// from outside, matching engine/rider-auth.js's existing non-disclosure
// pattern for its own PIN-less OTP login.
router.get('/pin-login/branches', async (req, res) => {
  const { rows } = await pool.query(`select id, name from branch where status = 'active' order by name`);
  res.json({ branches: rows });
});

router.get('/pin-login/staff', async (req, res) => {
  const branchId = req.query.branch_id;
  if (!branchId) return res.status(400).json({ error: 'branch_id is required.' });
  const staff = await findPinStaffForBranch(branchId);
  res.json({ staff });
});

router.post('/pin-login', async (req, res) => {
  const { branch_id, staff_id, pin } = req.body;
  const staff = branch_id && staff_id && (await findPinStaffById(branch_id, staff_id));
  if (!staff || !(await verifyPin(staff, pin || ''))) {
    return res.status(401).json({ error: 'Incorrect name or PIN.' });
  }
  const { rows } = await pool.query(`select name from branch where id = $1`, [staff.branch_id]);
  req.session.staff = {
    id: staff.id,
    name: staff.name,
    role: staff.role,
    branch_id: staff.branch_id,
    branch_name: rows[0]?.name || null,
    auth_type: 'pin',
  };
  // A shorter session than the 30-day default every password login gets
  // (server.js's cookie-session mount) -- a PIN login is meant for a
  // shared/kiosk-style device on one shift, not someone's own phone, so it
  // should expire on its own rather than stay signed in for a month.
  req.sessionOptions.maxAge = 8 * 60 * 60 * 1000;
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

// Delivery add-on config (own_riders/relay/none). Two legitimate callers,
// same dual-check shape as /export above: the panel (ERA admin token, no
// staff session of its own -- it's what decides the mode) and this
// business's own logged-in staff (Layout.jsx's nav check, which needs to
// read the mode to know whether "Delivery" should appear at all). Sits
// above the router.use(requireStaffApi) line below for the same reason
// /export and the WhatsApp Catalogue toggles do.
router.get('/delivery-config', async (req, res) => {
  const isEraAdmin = process.env.EBOS_ADMIN_TOKEN && req.header('x-era-admin-token') === process.env.EBOS_ADMIN_TOKEN;
  if (!isEraAdmin && !req.staff) return res.status(401).json({ error: 'Not logged in.' });
  if (!isEraAdmin && isPinTier(req.staff)) return res.status(403).json({ error: 'Not available to this account.' });
  const { rows } = await pool.query(
    'select business_id, mode, payout_mode, provider, offer_timeout_seconds from delivery_config limit 1'
  );
  res.json(rows[0] || { mode: 'none', payout_mode: 'manual', provider: null, offer_timeout_seconds: 90 });
});

// mode itself is ERA's to flip, never the client's (0.7 of the addon spec:
// "ERA switches these, not the client" -- each one maps to something the
// client is paying for).
router.post('/delivery-config', requireEraAdmin, async (req, res) => {
  const { mode } = req.body;
  const { rows } = await pool.query(
    `insert into delivery_config (business_id, mode) values ((select id from business limit 1), $1)
     on conflict (business_id) do update set mode = excluded.mode returning *`,
    [mode]
  );
  res.json(rows[0]);
});

// Voice add-on toggle -- same dual-auth/ERA-switches-it shape as
// delivery-config immediately above, for the same reason (0.7 of the addon
// spec: "ERA switches these, not the client").
router.get('/voice-config', async (req, res) => {
  const isEraAdmin = process.env.EBOS_ADMIN_TOKEN && req.header('x-era-admin-token') === process.env.EBOS_ADMIN_TOKEN;
  if (!isEraAdmin && !req.staff) return res.status(401).json({ error: 'Not logged in.' });
  if (!isEraAdmin && isPinTier(req.staff)) return res.status(403).json({ error: 'Not available to this account.' });
  const { rows } = await pool.query(
    `select business_id, enabled, transport, inbound_number, voice_id, transfer_numbers, operating_hours,
       greeting_override, max_minutes_per_month, recording_enabled, recording_retention_days
     from voice_config limit 1`
  );
  res.json(rows[0] || {
    enabled: false, transport: 'forwarding', inbound_number: null, voice_id: null, transfer_numbers: [],
    operating_hours: null, greeting_override: null, max_minutes_per_month: null,
    recording_enabled: false, recording_retention_days: 30,
  });
});

router.post('/voice-config', requireEraAdmin, async (req, res) => {
  const { enabled } = req.body;
  const { rows } = await pool.query(
    `insert into voice_config (business_id, enabled) values ((select id from business limit 1), $1)
     on conflict (business_id) do update set enabled = excluded.enabled returning *`,
    [enabled]
  );
  res.json(rows[0]);
});

router.use(requireStaffApi);
router.use(scopeToBranch);

router.use('/delivery', deliveryRoutes);
router.use('/voice', voiceRoutes);

// payout_mode/provider/provider_keys are the restaurant's own to set, once
// mode is on -- same level of trust as them already self-managing
// bank_name/bank_account_number in Settings today.
// Automatic payout is deliberately locked off at the code level right now
// (Chidera's explicit call, 2026-09-01: "don't put any money yet") -- not
// just an unchecked box in the UI. Manual is the only real payout path
// until this is lifted on purpose; provider/provider_keys can still be
// saved ahead of time (so the form isn't wasted work), they just can't be
// switched live yet.
router.post('/delivery-config/payout', requireEditorApi, async (req, res) => {
  const { payout_mode, provider, provider_keys } = req.body;
  if (payout_mode === 'automatic') {
    return res.status(403).json({ error: 'Automatic payout is not enabled yet -- deliveries pay out manually for now.' });
  }
  const { rows } = await pool.query(
    `insert into delivery_config (business_id, payout_mode, provider, provider_keys)
     values ((select id from business limit 1), 'manual', $1, $2)
     on conflict (business_id) do update set payout_mode = 'manual', provider = excluded.provider,
       provider_keys = coalesce(excluded.provider_keys, delivery_config.provider_keys)
     returning business_id, mode, payout_mode, provider, offer_timeout_seconds`,
    [provider || null, provider_keys ? encrypt(JSON.stringify(provider_keys)) : null]
  );
  res.json(rows[0]);
});

// The restaurant's own to edit once voice is on -- transfer_numbers,
// operating_hours, greeting_override, usage cap, recording opt-in. Same
// trust level as them already self-managing delivery zone prices. `enabled`
// itself is deliberately not accepted here -- that stays ERA-only, above.
router.post('/voice-config/settings', requireEditorApi, async (req, res) => {
  const { transfer_numbers, operating_hours, greeting_override, max_minutes_per_month, recording_enabled, recording_retention_days } = req.body;
  // { open: "HH:MM", close: "HH:MM" } or null (always open) -- see
  // engine/voice-hours.js's own comment for why this is a small structured
  // shape rather than the free-text convention business.operating_hours
  // uses elsewhere. Validated here, not just trusted from the client, since
  // a malformed value would silently break every future hours check.
  const validHours = operating_hours && typeof operating_hours.open === 'string' && typeof operating_hours.close === 'string'
    ? { open: operating_hours.open, close: operating_hours.close }
    : null;
  const { rows } = await pool.query(
    `insert into voice_config (business_id, transfer_numbers, operating_hours, greeting_override, max_minutes_per_month, recording_enabled, recording_retention_days)
     values ((select id from business limit 1), $1, $2, $3, $4, $5, $6)
     on conflict (business_id) do update set
       transfer_numbers = excluded.transfer_numbers,
       operating_hours = excluded.operating_hours,
       greeting_override = excluded.greeting_override,
       max_minutes_per_month = excluded.max_minutes_per_month,
       recording_enabled = excluded.recording_enabled,
       recording_retention_days = excluded.recording_retention_days
     returning business_id, enabled, transport, inbound_number, voice_id, transfer_numbers, operating_hours,
       greeting_override, max_minutes_per_month, recording_enabled, recording_retention_days`,
    [
      Array.isArray(transfer_numbers) ? transfer_numbers : [],
      validHours ? JSON.stringify(validHours) : null,
      greeting_override || null,
      max_minutes_per_month || null,
      Boolean(recording_enabled),
      recording_retention_days || 30,
    ]
  );
  res.json(rows[0]);
});

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
  // Orders are always per branch, in both sharing modes (branch addendum
  // section 4) -- unlike customers/menu, there's no mode-dependent case
  // here, so this is a plain filter, not a resolver call. null (no branch
  // lock, no ?branch_id= requested) means "see everything", same as today.
  const { rows } = await pool.query(
    `select o.*, c.name as customer_name, c.phone_number as customer_phone, c.channel as customer_channel,
            (select coalesce(json_agg(json_build_object('name', p.name, 'quantity', oi.quantity)), '[]')
             from order_item oi join product p on p.id = oi.product_id where oi.order_id = o.id) as items
     from "order" o join customers c on c.id = o.customer_id
     where $1::uuid is null or o.branch_id = $1
     order by o.created_at desc limit 200`,
    [req.branchId]
  );
  res.json(rows);
});

// Staff creating an order directly -- a delivery or order that came in
// some way other than a channel this system listens on itself (a landline
// call, a walk-in). Owner/manager only (requireEditorApi) and never a
// PIN-tier session even if one somehow held a manager role
// (requireFullAccessApi) -- creating a real, priced, already-marked-paid
// order is a different trust level than the one write action (notify-
// ready) Tier 3 gets.
//
// Reuses the real engine pieces rather than a second, parallel path:
// findOrCreateCustomer (same lookup/branch-scoping WhatsApp uses),
// resolveZoneForAddress (same deterministic, never-guessed zone match
// own_riders delivery already relies on), and newReference for the order
// number. Item prices are always the real, current product.price --
// never trusted from the request, exactly like every other place an order
// gets priced.
//
// Lands directly as status='preparation', skipping 'confirmed' entirely
// (Chidera's call) -- 'confirmed' exists to flag a real WhatsApp order as
// "paid, needs someone to look at it," which is redundant here since
// staff just looked at it themselves by typing it in. engine_state=
// 'fulfilment' is the same state a real WhatsApp order reaches right after
// payment, so a later message from this same customer is treated as
// "asking about an existing order," never as a fresh chat mistaking this
// for a brand new inquiry. From here it's the exact same order everything
// else (the Preparation stage's "mark as ready" button, own_riders
// dispatch, delivery tracking) already works on unchanged.
router.post('/orders', requireFullAccessApi, requireEditorApi, async (req, res) => {
  const f = req.body;
  if (!f.phone) return res.status(400).json({ error: 'A customer phone number is required.' });
  if (!Array.isArray(f.items) || !f.items.length) return res.status(400).json({ error: 'At least one item is required.' });
  if (!['delivery', 'pickup'].includes(f.fulfilment_type)) return res.status(400).json({ error: 'fulfilment_type must be "delivery" or "pickup".' });
  if (f.fulfilment_type === 'delivery' && !f.address) return res.status(400).json({ error: 'A delivery address is required.' });

  const branchId = req.branchId || f.branch_id || null;
  const customer = await findOrCreateCustomer({ phoneNumber: f.phone, channel: 'manual', branchId });
  if (f.name && !customer.name) {
    await pool.query('update customers set name = $1 where id = $2', [f.name, customer.id]);
    customer.name = f.name;
  }
  // Kept in sync on the in-memory customer object too, not just written to
  // the row -- createDelivery() below reads customer.address directly, and
  // a stale value here would silently create a delivery row with the
  // customer's OLD (or no) address instead of the one just typed in.
  if (f.fulfilment_type === 'delivery' && f.address) {
    await pool.query('update customers set address = $1 where id = $2', [f.address, customer.id]);
    customer.address = f.address;
  }

  const { rows: products } = await pool.query(
    `select id, name, price from product where id = any($1::uuid[])`,
    [f.items.map((i) => i.productId)]
  );
  const byId = new Map(products.map((p) => [p.id, p]));
  const unknown = f.items.find((i) => !byId.has(i.productId));
  if (unknown) return res.status(400).json({ error: `Unknown product: ${unknown.productId}` });
  const lineItems = f.items.map((i) => {
    const product = byId.get(i.productId);
    return { productId: product.id, quantity: Math.max(1, Number(i.quantity) || 1), price: product.price };
  });
  const itemsTotal = lineItems.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0);

  let deliveryFee = 0;
  let deliveryZoneId = null;
  if (f.fulfilment_type === 'delivery') {
    const deliveryConfig = await getDeliveryConfig();
    if (deliveryConfig.mode === 'own_riders') {
      const zone = await resolveZoneForAddress(f.address, branchId);
      // Never guess a zone (same rule the bot itself follows) -- an
      // unresolved address here just means no delivery fee is added and no
      // own-riders dispatch will ever trigger for it, not a made-up price.
      // Staff typed the address themselves, so they can see and fix it.
      if (zone) {
        deliveryZoneId = zone.id;
        deliveryFee = Number(zone.customer_fee);
      }
    }
  }

  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, engine_state, status, total, delivery_fee, payment_status, fulfilment_type, branch_id, delivery_zone_id)
     values ($1, $2, 'fulfilment', 'preparation', $3, $4, 'confirmed', $5, $6, $7) returning *`,
    [customer.id, newReference('ORD'), itemsTotal + deliveryFee, deliveryFee, f.fulfilment_type, branchId, deliveryZoneId]
  );
  const order = orderRows[0];

  for (const item of lineItems) {
    await pool.query('insert into order_item (order_id, product_id, quantity, price) values ($1, $2, $3, $4)', [order.id, item.productId, item.quantity, item.price]);
  }

  // The same createDelivery() completePayment() calls for every real
  // WhatsApp order (engine/flow.js) -- without this, OrderDetail.jsx's
  // Delivery card has nothing to show even after a rider accepts, since
  // that card reads the `delivery` table, not delivery_offer/
  // delivery_assignment directly. Caught by testing this end to end, not
  // by inspection: a rider accepted the own_riders offer just fine, but
  // the order's own delivery summary stayed null until this was added.
  if (f.fulfilment_type === 'delivery') {
    await createDelivery(order, customer);
  }

  await logActivity(req, 'order_created_manually', { entityType: 'order', entityId: order.id, detail: { reference: order.reference } });
  res.status(201).json(order);
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
       from "order" where created_at >= date_trunc('day', now()) and ($1::uuid is null or branch_id = $1)`,
      [req.branchId]
    ),
    // "Answered in": for every bot/staff reply sent today, how long since
    // that same customer's most recent prior inbound message -- i.e. how
    // long the customer actually waited for that reply. Capped at 1 hour
    // so a reply to a customer who went quiet for days (picked back up
    // much later) doesn't skew the average into meaninglessness.
    // Not branch-filtered -- message has no branch_id (not every message
    // ties to one order, so there's no clean column to add it to), so this
    // one stat stays business-wide even inside a single-branch scope view.
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
       from "order" where created_at >= date_trunc('day', now()) and ($1::uuid is null or branch_id = $1)
       group by hour order by count desc limit 1`,
      [req.branchId]
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
  // Own_riders only -- the id staff need to call the /release override on
  // (routes/delivery.js), since `delivery` above is just the summary row
  // every provider shares and has no assignment id of its own.
  const { rows: assignment } = await pool.query(
    `select id, status from delivery_assignment where order_id = $1 order by created_at desc limit 1`,
    [order.id]
  );
  res.json({ order, items, customer: customerRows[0] || null, documents, delivery: delivery[0] || null, deliveryAssignment: assignment[0] || null });
});

// Staff-triggered, not automatic -- "I'll let you know when to pick up" (the
// payment-received message for pickup orders) only becomes true once
// someone here actually clicks it, once the food genuinely is ready.
// requireStaffApi, not requireEditorApi -- deliberately widened so Tier 3
// (PIN) staff can act on orders from the Orders tab, the one write
// capability their otherwise read-only 5-tab view needs. Was
// owner/manager-only before this; see the RBAC plan's rollout note about
// checking for pre-existing password-tier 'staff' rows before this ships,
// since they gain this too.
router.post('/orders/:id/notify-ready', requireStaffApi, async (req, res) => {
  try {
    await notifyReadyForPickup(req.params.id);
    await logActivity(req, 'order_notified_ready', { entityType: 'order', entityId: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: `Could not notify customer: ${err.message}` });
  }
});

router.post('/orders/:id/status', requireStaffApi, async (req, res) => {
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
  // One "Mark as ready" click on the Preparation stage, same button
  // regardless of fulfilment_type (Chidera's call) -- everything below
  // branches automatically off the order's own real fulfilment_type
  // instead of needing two different buttons for the same real-world "the
  // kitchen just finished" moment.
  if (status === 'ready') {
    // Own_riders dispatch (own_riders mode only) -- a no-op for pickup
    // orders, non-delivery-add-on businesses, and any order already
    // dispatched once (maybeDispatchOwnRiders's own idempotency check).
    await maybeDispatchOwnRiders(req.params.id);
    // The pickup-side equivalent of that same click -- the customer needs
    // to know their food is ready to collect, automatically, not via a
    // second manual button for the same fact.
    const { rows: orderRows } = await pool.query('select fulfilment_type from "order" where id = $1', [req.params.id]);
    if (orderRows[0]?.fulfilment_type === 'pickup') {
      await notifyReadyForPickup(req.params.id).catch((err) => console.error('notifyReadyForPickup failed:', err.message));
    }
  }
  await logActivity(req, 'order_status_changed', { entityType: 'order', entityId: req.params.id, detail: { status } });
  res.json({ ok: true });
});

// Staff confirming a manual/bank-transfer payment (after checking the
// customer's submitted proof image) goes through the exact same
// completePayment() the Paystack webhook uses -- receipt, delivery booking,
// customer notification, all of it -- rather than a second, thinner path
// that could drift out of sync with what a real automated payment does.
router.post('/orders/:id/confirm-payment', requireStaffApi, async (req, res) => {
  const { rows } = await pool.query(`update "order" set payment_status = 'confirmed' where id = $1 returning *`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found.' });
  try {
    await completePayment(req.params.id);
    await logActivity(req, 'order_payment_confirmed', { entityType: 'order', entityId: req.params.id });
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
// One shared queue (spec C1), not one per capability -- a delivery offer
// nobody accepted is a different SHAPE of fact than a customer handover
// (no name/phone_number/channel of its own, a zone and an order instead),
// so this is a kind-tagged UNION rather than forcing it to pretend to be a
// customer row. Only surfaces an offer once it's already crossed the
// staff-alert threshold (engine/delivery-dispatch.js's sweepOfferEscalation)
// -- the same real signal that already triggered a WhatsApp ping, not a
// second, earlier definition of "needs attention" invented here.
router.get('/conversations/needs-attention', async (req, res) => {
  const { rows } = await pool.query(
    `select 'conversation' as kind, c.id, c.name, c.phone_number, c.channel, c.channel_id,
            c.handover_reason as reason, c.handover_at as at, null::uuid as order_id, null as order_reference, null as zone_name, null::uuid as callback_task_id
     from customers c
     -- Voice channel excluded here on purpose: a voice handover shows up
     -- below instead, as its own richer 'callback' row (with a real
     -- context_summary and a claim/resolve workflow this generic
     -- customers.handled_by flag has none of) -- not both, which would
     -- show the same caller twice in the one queue staff watch (C1).
     where c.handled_by = 'staff' and c.channel != 'voice' and ($1::uuid is null or c.branch_id = $1)
     union all
     select 'delivery' as kind, o.id, null, null, null, null,
            'No rider has accepted this delivery' as reason, o.staff_alerted_at as at, o.order_id, ord.reference as order_reference, z.name as zone_name, null::uuid as callback_task_id
     from delivery_offer o
     join delivery_zone z on z.id = o.zone_id
     join "order" ord on ord.id = o.order_id
     where o.status = 'OPEN' and o.staff_alerted_at is not null and ($1::uuid is null or o.branch_id = $1)
     union all
     select 'callback' as kind, c.id, c.name, c.phone_number, c.channel, c.channel_id,
            ct.reason as reason, ct.created_at as at, null::uuid as order_id, null as order_reference, null as zone_name, ct.id as callback_task_id
     from callback_task ct
     join customers c on c.id = ct.customer_id
     where ct.status = 'open' and ($1::uuid is null or ct.branch_id = $1)
     order by at asc nulls last
     limit 200`,
    [req.branchId]
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

// Staff messaging a customer FIRST, not replying -- e.g. "we have your
// order ready" sent proactively rather than triggered by an inbound
// message. Goes out as the pre-approved "business_outreach" template (see
// scripts/lib/whatsapp-templates.mjs), so it works even for a customer who
// has never messaged this number, or whose 24h window has closed.
router.post('/conversations/outreach', async (req, res) => {
  const phone = (req.body?.phone_number || '').trim();
  const message = (req.body?.message || '').trim();
  if (!phone) return res.status(400).json({ error: 'A phone number is required.' });
  if (!message) return res.status(400).json({ error: 'A message is required.' });
  try {
    const customer = await sendOutreachMessage({ phoneNumber: phone, message, branchId: req.branchId, staffId: req.staff.id });
    await logActivity(req, 'message_sent', { entityType: 'conversation', entityId: customer.id });
    res.json({ ok: true, conversation_id: customer.id });
  } catch (err) {
    res.status(502).json({ error: `Could not send: ${err.message}` });
  }
});

router.post('/conversations/:id/send', async (req, res) => {
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Message text is required.' });
  try {
    await sendStaffReply(req.params.id, text, req.staff.id);
    await logActivity(req, 'message_sent', { entityType: 'conversation', entityId: req.params.id });
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
  await logActivity(req, 'conversation_returned_to_bot', { entityType: 'conversation', entityId: req.params.id });
  res.json({ ok: true });
});

// Claims the thread before staff has typed anything -- see
// takeOverConversation's comment in flow.js for why this exists as its own
// step instead of just relying on the first reply to mark the takeover.
router.post('/conversations/:id/take-over', async (req, res) => {
  await takeOverConversation(req.params.id, req.staff.id);
  await logActivity(req, 'conversation_taken_over', { entityType: 'conversation', entityId: req.params.id });
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

router.get('/bot-fields', requireFullAccessApi, async (req, res) => {
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

router.get('/bot-states', requireFullAccessApi, async (req, res) => {
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

router.get('/staff', requireFullAccessApi, async (req, res) => {
  const { rows } = await pool.query(
    `select s.id, s.name, s.phone_number, s.email, s.role, s.status, s.handover_alerts, s.created_at, s.branch_id, s.auth_type, b.name as branch_name
     from staff s left join branch b on b.id = s.branch_id
     where $1::uuid is null or s.branch_id = $1
     order by s.created_at`,
    [req.branchId]
  );
  res.json(rows);
});

// Email+password accounts are only ever Manager or Owner now -- a plain
// "staff" role login here would just be a confusing second way to create
// what PIN accounts (POST /staff/pin) are for. Kept as an application-
// level check, not a DB constraint: the same role value is still valid and
// required on a PIN row (auth_type = 'pin'), just never paired with a
// password here.
router.post('/staff', requireEditorApi, async (req, res) => {
  const f = req.body;
  if (f.role === 'staff') {
    return res.status(400).json({ error: 'Staff sign in with a name and PIN -- use "Add staff" below, not this form.' });
  }
  const passwordHash = await hashPassword(f.password);
  // A branch-locked manager can only ever create staff inside their own
  // branch -- req.branchId (their own, from scopeToBranch) wins over
  // whatever branch_id they sent, the same "locking is enforced, not just
  // defaulted" rule as scopeToBranch itself. An owner/admin (branchId null)
  // can set any branch, including none.
  const branchId = req.branchId || f.branch_id || null;
  const { rows } = await pool.query(
    'insert into staff (name, phone_number, email, password_hash, role, branch_id) values ($1, $2, $3, $4, $5, $6) returning id, name, phone_number, email, role, status, branch_id',
    [f.name, f.phone_number || null, f.email.trim().toLowerCase(), passwordHash, f.role, branchId]
  );
  res.status(201).json(rows[0]);
});

// A branch-locked manager can only touch staff inside their own branch,
// and can never touch an owner account regardless -- disabling the person
// who runs the whole business is not something a branch's own manager
// should ever be able to do from here. requireEditorApi alone didn't catch
// this: it only checks the ACTOR's role, never who the target row actually
// is, so any manager could previously disable any staff row by id,
// including an owner's.
router.post('/staff/:id/status', requireEditorApi, async (req, res) => {
  const { rows: target } = await pool.query('select id, role, branch_id from staff where id = $1', [req.params.id]);
  if (!target[0]) return res.status(404).json({ error: 'Staff member not found.' });
  if (req.branchId && (target[0].role === 'owner' || target[0].branch_id !== req.branchId)) {
    return res.status(403).json({ error: 'You can only manage staff in your own branch.' });
  }
  const { rows } = await pool.query('update staff set status = $1 where id = $2 returning id, status', [req.body.status, req.params.id]);
  res.json(rows[0]);
});

// Only an owner/admin (branchId null) can move someone between branches --
// a branch-locked manager reassigning their own staff elsewhere would be
// exactly the branch-control gap the lock exists to close. Sending
// branch_id: null clears the lock (that staff member becomes "all
// branches" -- effectively promotion to an owner-style scope, so this
// stays owner-only, not just requireEditorApi).
router.post('/staff/:id/branch', requireEditorApi, async (req, res) => {
  if (req.branchId) return res.status(403).json({ error: 'Only an owner can reassign a branch.' });
  const { rows } = await pool.query(
    `update staff set branch_id = $1 where id = $2 returning id, branch_id`,
    [req.body.branch_id || null, req.params.id]
  );
  res.json(rows[0]);
});

// A staff member needs a phone number on file before a handover alert can
// reach them -- toggling this on with no number set would silently do
// nothing, so that's rejected here rather than failing quietly later.
// Same branch scoping as /staff/:id/status above -- a branch manager can
// only toggle this for staff in their own branch.
router.post('/staff/:id/handover-alerts', requireEditorApi, async (req, res) => {
  const { rows: existing } = await pool.query('select phone_number, branch_id from staff where id = $1', [req.params.id]);
  if (!existing[0]) return res.status(404).json({ error: 'Staff member not found.' });
  if (req.branchId && existing[0].branch_id !== req.branchId) {
    return res.status(403).json({ error: 'You can only manage staff in your own branch.' });
  }
  if (req.body.handover_alerts && !existing[0].phone_number) {
    return res.status(400).json({ error: 'Add a phone number for this staff member first.' });
  }
  const { rows } = await pool.query('update staff set handover_alerts = $1 where id = $2 returning id, handover_alerts', [
    !!req.body.handover_alerts,
    req.params.id,
  ]);
  res.json(rows[0]);
});

// PIN-tier (Tier 3) staff provisioning -- always branch-scoped by
// construction: req.branchId has to be set (a branch-locked manager, or an
// owner explicitly acting ?branch_id= on one branch) since there is no
// "all-branches PIN staff", the same way an all-branches password account
// only ever makes sense for role = 'owner'.
router.post('/staff/pin', requireEditorApi, async (req, res) => {
  if (!req.branchId) return res.status(400).json({ error: 'Pick a branch first -- a PIN account always belongs to exactly one branch.' });
  const { name, pin } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
  if (!/^\d{4}$/.test(pin || '')) return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });
  const pinHash = await hashPin(pin);
  const { rows } = await pool.query(
    `insert into staff (name, role, branch_id, auth_type, pin_hash, created_by_staff_id)
     values ($1, 'staff', $2, 'pin', $3, $4)
     returning id, name, role, status, branch_id, auth_type`,
    [name.trim(), req.branchId, pinHash, req.staff.id]
  );
  await logActivity(req, 'staff_pin_created', { entityType: 'staff', entityId: rows[0].id, detail: { name: rows[0].name } });
  res.status(201).json(rows[0]);
});

// Resets an existing PIN-tier staff member's PIN -- also clears any
// lockout, so a reset doubles as an unlock. A branch manager can only ever
// touch staff inside their own branch, same guard as POST /staff/:id/branch
// above -- the where clause below scopes the update, not just the lookup,
// so this can never silently no-op onto the wrong row.
router.post('/staff/:id/pin', requireEditorApi, async (req, res) => {
  if (!req.branchId) return res.status(400).json({ error: 'Pick a branch first.' });
  const { pin } = req.body;
  if (!/^\d{4}$/.test(pin || '')) return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });
  const pinHash = await hashPin(pin);
  const { rows } = await pool.query(
    `update staff set pin_hash = $1, pin_failed_attempts = 0, pin_locked_until = null
     where id = $2 and branch_id = $3 and auth_type = 'pin'
     returning id, name`,
    [pinHash, req.params.id, req.branchId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'PIN staff member not found in your branch.' });
  await logActivity(req, 'staff_pin_reset', { entityType: 'staff', entityId: rows[0].id, detail: { name: rows[0].name } });
  res.json(rows[0]);
});

// Never reachable by a PIN-tier session -- this is the accountability
// trail ABOUT staff, not a tab staff themselves get. Filtered by
// req.branchId exactly like /orders: a branch manager sees only their own
// branch's log, an owner sees everything unless explicitly scoped to one
// branch via the same scope switcher every other branch-scoped page uses.
router.get('/activity-log', requireFullAccessApi, async (req, res) => {
  const { rows } = await pool.query(
    `select a.id, a.action, a.entity_type, a.entity_id, a.detail, a.created_at, a.branch_id, s.name as staff_name
     from activity_log a left join staff s on s.id = a.staff_id
     where $1::uuid is null or a.branch_id = $1
     order by a.created_at desc limit 200`,
    [req.branchId]
  );
  res.json(rows);
});

// --- Generated documents -----------------------------------------------

router.get('/documents', async (req, res) => {
  const { rows } = await pool.query('select * from generated_document order by created_at desc limit 200');
  res.json(rows);
});

// --- Settings (the single business row) --------------------------------

router.get('/business', requireFullAccessApi, async (req, res) => {
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
router.get('/settings/instagram-status', requireFullAccessApi, async (req, res) => {
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

router.get('/whatsapp-profile', requireFullAccessApi, async (req, res) => {
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
// Filtered by req.branchId like every other branch-scoped route -- a
// branch-locked manager only ever gets their own branch's row back, never
// every branch in the business. This was a real gap before: the query used
// to ignore req.branchId entirely, so a branch manager could see (and,
// through the edit routes below, touch) every other branch too, exactly
// the cross-branch view locking them to a branch_id is meant to prevent.
router.get('/branches', requireFullAccessApi, async (req, res) => {
  const { rows } = await pool.query('select * from branch where $1::uuid is null or id = $1 order by name', [req.branchId]);
  res.json(rows);
});

// Powers the dashboard's "compare branches" scope -- deliberately no order
// rail here (see client/src/pages/AllBranches.jsx), just the side-by-side
// numbers an owner with several locations genuinely can't get today.
// Owner-only by construction, not just requireEditorApi: comparing
// branches side-by-side is meaningless once you're locked to one, so a
// branch manager gets a clear 403 here rather than a degenerate
// one-row "comparison."
// "Needs attention" is bucketed by customers.branch_id, which is only ever
// set under sharing_mode = 'independent' with a resolved branch (see
// fields.js's customer resolver) -- under 'merged', or before a branch is
// known, those conversations land in the null bucket below rather than
// being force-attributed to a branch that didn't actually handle them.
router.get('/branches/summary', requireFullAccessApi, async (req, res) => {
  if (req.branchId) return res.status(403).json({ error: 'Only an owner can compare branches.' });
  const [{ rows: branches }, { rows: orders }, { rows: deliveries }, { rows: attention }, { rows: hourly }] = await Promise.all([
    pool.query('select id, name from branch order by name'),
    pool.query(
      `select branch_id, count(*) as orders_today, coalesce(sum(total) filter (where payment_status in ('confirmed', 'accepted')), 0) as revenue_today
       from "order" where created_at >= date_trunc('day', now()) group by branch_id`
    ),
    pool.query(`select branch_id, count(*) as in_progress from delivery where status = 'dispatched' group by branch_id`),
    pool.query(`select branch_id, count(*) as needs_attention from customers where handled_by = 'staff' group by branch_id`),
    pool.query(
      `select branch_id, date_trunc('hour', created_at) as hour, count(*) as count
       from "order" where created_at >= date_trunc('day', now()) group by branch_id, hour`
    ),
  ]);
  const byBranch = (rows) => new Map(rows.map((r) => [r.branch_id, r]));
  const ordersByBranch = byBranch(orders);
  const deliveriesByBranch = byBranch(deliveries);
  const attentionByBranch = byBranch(attention);
  // Picking the busiest hour per branch in JS, not SQL -- today's volume
  // per branch is small enough that a DISTINCT ON/window-function query
  // isn't worth the extra SQL complexity for a same-day dashboard stat.
  const busiestByBranch = new Map();
  for (const row of hourly) {
    const current = busiestByBranch.get(row.branch_id);
    if (!current || Number(row.count) > Number(current.count)) busiestByBranch.set(row.branch_id, row);
  }
  res.json(
    branches.map((b) => {
      const o = ordersByBranch.get(b.id);
      const busiest = busiestByBranch.get(b.id);
      return {
        id: b.id,
        name: b.name,
        ordersToday: Number(o?.orders_today || 0),
        revenueToday: Number(o?.revenue_today || 0),
        deliveriesInProgress: Number(deliveriesByBranch.get(b.id)?.in_progress || 0),
        needsAttention: Number(attentionByBranch.get(b.id)?.needs_attention || 0),
        busiestHour: busiest ? { start: busiest.hour, count: Number(busiest.count) } : null,
      };
    })
  );
});

// A new branch never starts primary on its own -- the first branch a
// business ever creates becomes primary automatically (there's nothing
// else for "the default scope" to mean yet); after that, is_primary only
// moves when someone explicitly sets it on another branch (see below).
router.post('/branches', requireEditorApi, async (req, res) => {
  const f = req.body;
  const { rows: existing } = await pool.query('select count(*) from branch');
  const isFirst = Number(existing[0].count) === 0;
  const { rows } = await pool.query(
    `insert into branch (name, address, phone_number, operating_hours, area, whatsapp_number, instagram_handle, opening_hours, timezone, status, is_primary)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *`,
    [
      f.name,
      f.address,
      f.phone_number || null,
      f.operating_hours || null,
      f.area || null,
      f.whatsapp_number || null,
      f.instagram_handle || null,
      f.opening_hours || null,
      f.timezone || 'Africa/Lagos',
      f.status || 'active',
      isFirst,
    ]
  );
  res.status(201).json(rows[0]);
});

router.post('/branches/:id', requireEditorApi, async (req, res) => {
  const f = req.body;
  // Exactly one primary branch at a time -- setting this one true clears
  // every other branch's flag first, in the same request, so there's never
  // a moment with two (or zero, once one exists) primary branches.
  if (f.is_primary) {
    await pool.query('update branch set is_primary = false where id != $1', [req.params.id]);
  }
  const { rows } = await pool.query(
    `update branch set name = $1, address = $2, phone_number = $3, operating_hours = $4,
       area = $5, whatsapp_number = $6, instagram_handle = $7, opening_hours = $8,
       timezone = $9, status = $10, is_primary = $11
     where id = $12 returning *`,
    [
      f.name,
      f.address,
      f.phone_number || null,
      f.operating_hours || null,
      f.area || null,
      f.whatsapp_number || null,
      f.instagram_handle || null,
      f.opening_hours || null,
      f.timezone || 'Africa/Lagos',
      f.status || 'active',
      Boolean(f.is_primary),
      req.params.id,
    ]
  );
  res.json(rows[0]);
});

router.delete('/branches/:id', requireEditorApi, async (req, res) => {
  await pool.query('delete from branch where id = $1', [req.params.id]);
  res.json({ ok: true });
});
