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
  scopeToWorkArea,
  findPinStaffForBranch,
  findPinStaffById,
  verifyPin,
  hashPin,
  isPinTier,
  requireFullAccessApi,
  logActivity,
  consumeMagicLink,
  magicLinkAuthTypeHint,
} from '../lib/auth.js';
import { parseMenuText, parseMenuImages, reconcileMenu } from '../engine/parse-menu.js';
import { sendStaffReply, completePayment, notifyReadyForPickup, resumeBotControl, takeOverConversation, findOrCreateCustomer, newReference, startConversation, sendFeedbackRequest, closeTableSessionIfSettled, UPSELL_GROUPS, categoryMatchesGroup } from '../engine/flow.js';
import { getDeliveryConfig } from '../engine/delivery-zones.js';
import { getWalletStatus, creditWallet } from '../engine/wallet.js';
import { createDelivery } from '../engine/delivery.js';
import { costForTokens, INTRO, STANDARD, INTRO_ENDS } from '../lib/ai-pricing.js';
import { getWhatsappBusinessProfile, updateWhatsappBusinessProfile } from '../engine/whatsapp-profile.js';
import { getCatalogStatus, markCatalogConnected, syncAllProducts, syncBestEffort, deleteBestEffort } from '../engine/whatsapp-catalog.js';
import { router as deliveryRoutes } from './delivery.js';
import { router as voiceRoutes } from './voice.js';
import { router as dineinRoutes } from './dinein.js';
import { encrypt } from '../lib/crypto.js';
import { maybeDispatchOwnRiders, manuallyRingForRider } from '../engine/delivery-dispatch.js';
import { offerBus } from '../engine/offer-bus.js';

export const router = express.Router();

// --- Auth ---------------------------------------------------------------

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const staff = email && (await findStaffByEmail(email));
  if (!staff || !(await verifyPassword(staff, password || ''))) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  req.session.staff = {
    id: staff.id,
    name: staff.name,
    role: staff.role,
    branch_id: staff.branch_id,
    branch_name: staff.branch_name,
    auth_type: staff.auth_type,
    work_area: staff.work_area,
  };
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
    work_area: staff.work_area,
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

// Tapped from a handover alert on WhatsApp (engine/flow.js's handover()) --
// signs the staff member straight in and drops them on the conversation
// that triggered the alert, no separate login, no leaving WhatsApp first.
// Public (no requireStaffApi -- that gate is below this route) since the
// whole point is bootstrapping a session that doesn't exist yet; the token
// itself is the credential, single-use and short-lived (lib/auth.js).
router.get('/auth/magic/:token', async (req, res) => {
  const consumed = await consumeMagicLink(req.params.token);
  // A dead-end text response used to strand whoever tapped a genuinely
  // expired link with no way forward -- redirect to the right login screen
  // instead, /staff-login for a PIN account and /login (email+password)
  // for everyone else, via lib/auth.js's magicLinkAuthTypeHint (a
  // read-only, expiry-tolerant lookup -- purely a "which screen" hint, not
  // itself a security check; consumeMagicLink above is what actually gates
  // login). A token this route has genuinely never seen at all (garbage,
  // not just expired) has no hint to give, so that one case falls back to
  // /login.
  if (!consumed) {
    const hint = await magicLinkAuthTypeHint(req.params.token);
    return res.redirect(hint === 'pin' ? '/staff-login' : '/login');
  }
  const { rows } = await pool.query(
    `select s.id, s.name, s.role, s.status, s.branch_id, s.auth_type, s.work_area, b.name as branch_name
     from staff s left join branch b on b.id = s.branch_id where s.id = $1`,
    [consumed.staff_id]
  );
  const staff = rows[0];
  if (!staff || staff.status !== 'active') return res.redirect(staff?.auth_type === 'pin' ? '/staff-login' : '/login');
  req.session.staff = {
    id: staff.id,
    name: staff.name,
    role: staff.role,
    branch_id: staff.branch_id,
    branch_name: staff.branch_name,
    auth_type: staff.auth_type,
    work_area: staff.work_area,
  };
  // Same reasoning as pin-login above -- a PIN account is kiosk-style, not
  // someone's own phone, so it shouldn't stay signed in via a magic link
  // any longer than a normal PIN login would.
  if (staff.auth_type === 'pin') req.sessionOptions.maxAge = 8 * 60 * 60 * 1000;
  res.redirect(consumed.redirect_path || '/');
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

// Chidera, 2026-09-22: "meta will start charging 14 naira per message on
// october first... my bot can end up texting lots of messages for just
// one order if customer keeps typing back and forth." Meta is ending free
// service-window messages on 2026-10-01 -- every outbound message this
// business's bot sends (WhatsApp only; inbound is never billed) starts
// costing real money past the first 1,000/month per WhatsApp number,
// publicly reported at roughly NGN 14 each (no official per-country rate
// from Meta as of this writing -- see PER_MESSAGE_NAIRA below, update it
// the moment Meta publishes the real one). This turns that fear into a
// real number: how many outbound WhatsApp messages this business actually
// sent per order over the last 30 days, and what October would cost at
// today's real order volume.
const PER_MESSAGE_NAIRA = 14; // public reporting as of 2026-09, not Meta's own confirmed rate -- revisit
const FREE_MESSAGES_PER_NUMBER = 1000; // per WhatsApp number, per month

router.get('/monitor/messaging-cost', requireEraAdmin, async (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 90);
  const [{ rows: outboundRows }, { rows: orderRows }, { rows: numberRows }] = await Promise.all([
    pool.query(
      `select count(*) as count from message
       where direction = 'outbound' and channel = 'whatsapp' and created_at >= now() - $1::interval`,
      [`${days} days`]
    ),
    pool.query(`select count(*) as count from "order" where created_at >= now() - $1::interval`, [`${days} days`]),
    pool.query(`select count(distinct phone_number_id) as count from branch_channel where channel = 'whatsapp' and phone_number_id is not null`),
  ]);
  const outboundWhatsapp = Number(outboundRows[0].count);
  const orders = Number(orderRows[0].count);
  // Zero rows means this business runs on the one shared .env number, not
  // zero numbers -- see branch_channel's own table comment.
  const whatsappNumbers = Math.max(1, Number(numberRows[0].count));
  const freeAllowance = whatsappNumbers * FREE_MESSAGES_PER_NUMBER * (days / 30);
  const billableMessages = Math.max(0, outboundWhatsapp - freeAllowance);
  res.json({
    days,
    outboundWhatsapp,
    orders,
    avgMessagesPerOrder: orders ? Number((outboundWhatsapp / orders).toFixed(1)) : null,
    whatsappNumbers,
    freeAllowance: Math.round(freeAllowance),
    billableMessages: Math.round(billableMessages),
    projectedCostNaira: Math.round(billableMessages * PER_MESSAGE_NAIRA),
    perMessageNaira: PER_MESSAGE_NAIRA,
  });
});

// Chidera, 2026-09-24: "i want a personal dashboard for myself to monitor
// all my ebos business and see if im really improving their business with
// my tactics... upsell success rate... abandoned chat rate... complaint
// rate... basically all these things that help me study the customers
// response to the automation". ERA-admin-only, same trust boundary as
// monitor/summary -- this is Chidera's own cross-business read, not
// something a business owner's own dashboard exposes. Reuses
// computeUpsellStats (a hoisted function declaration further down this
// file, built for customers/stats) rather than a second copy of that
// match-and-count logic. Must stay above router.use(requireStaffApi)
// below -- see the comment on pos-sync-config for why.
router.get('/business-intelligence', requireEraAdmin, async (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 365);
  const interval = `${days} days`;

  const [upsell, { rows: complaintRows }, { rows: activeCustomerRows }, { rows: abandonedRows }, { rows: totalOrderRows }] = await Promise.all([
    computeUpsellStats('and o.created_at >= now() - $1::interval', [interval]),
    // Complaint rate: the exact handover_reason string handleInboundMessage
    // sets when Claude classifies a message as a complaint (see
    // handleInboundMessage's own `intent === 'complaint'` branch) --
    // deliberately not a LIKE match on "complaint" anywhere in the reason,
    // since a handover a STAFF member typed a free-text reason for could
    // coincidentally contain that word without being one.
    pool.query(
      `select count(*) as count from customers
       where handover_reason = 'Customer message classified as a complaint' and handover_at >= now() - $1::interval`,
      [interval]
    ),
    pool.query(
      `select count(distinct customer_id) as count from message where direction = 'inbound' and created_at >= now() - $1::interval`,
      [interval]
    ),
    // Abandoned chat rate: there's no dedicated "why was this cancelled"
    // column yet (closeStaleOrders' own timeout-sweep and a customer
    // explicitly saying no both just land on status='cancelled') -- this is
    // an honest proxy, not exact: a cancelled order whose customer sent
    // nothing in the hour immediately before the order's own last update.
    // An explicit cancel is customer-driven and near-instant (their own
    // message is what causes the update); closeStaleOrders only ever fires
    // long after the customer already went quiet, so the two shapes are
    // genuinely distinguishable most of the time even without a real flag.
    pool.query(
      `select count(*) as count from "order" o
       where o.status = 'cancelled' and o.created_at >= now() - $1::interval
         and not exists (
           select 1 from message m
           where m.customer_id = o.customer_id and m.direction = 'inbound'
             and m.created_at > o.updated_at - interval '1 hour' and m.created_at <= o.updated_at
         )`,
      [interval]
    ),
    pool.query(`select count(*) as count from "order" where created_at >= now() - $1::interval`, [interval]),
  ]);

  const activeCustomers = Number(activeCustomerRows[0].count);
  const complaints = Number(complaintRows[0].count);
  const abandonedOrders = Number(abandonedRows[0].count);
  const totalOrders = Number(totalOrderRows[0].count);

  res.json({
    days,
    ...upsell,
    complaints,
    activeCustomers,
    complaintRate: activeCustomers > 0 ? Math.round((complaints / activeCustomers) * 1000) / 10 : null,
    abandonedOrders,
    totalOrders,
    abandonedRate: totalOrders > 0 ? Math.round((abandonedOrders / totalOrders) * 1000) / 10 : null,
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
    'select business_id, mode, payout_mode, provider, provider_keys is not null as "hasProviderKey", offer_timeout_seconds from delivery_config limit 1'
  );
  res.json(rows[0] || { mode: 'none', payout_mode: 'manual', provider: null, hasProviderKey: false, offer_timeout_seconds: 90 });
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

// Dine-in add-on toggle -- same dual-auth/ERA-switches-it shape as
// delivery-config/voice-config immediately above. Chidera 2026-09-11:
// this route was referenced (routes/dinein.js's own header comment even
// claims it exists) but never actually defined -- Layout.jsx's nav check
// and DineIn.jsx's own config load both silently got back null forever
// (the SPA's index.html, not JSON, swallowed by api.js's error handling),
// which meant the Dine-in nav link never showed AND the whole Dine-in
// page rendered blank (`if (!config || !tables) return null;`) even
// after the routes/dinein.js router-mounting fix earlier this session.
router.get('/dinein-config', async (req, res) => {
  const isEraAdmin = process.env.EBOS_ADMIN_TOKEN && req.header('x-era-admin-token') === process.env.EBOS_ADMIN_TOKEN;
  if (!isEraAdmin && !req.staff) return res.status(401).json({ error: 'Not logged in.' });
  if (!isEraAdmin && isPinTier(req.staff)) return res.status(403).json({ error: 'Not available to this account.' });
  const { rows } = await pool.query(
    `select business_id, enabled, feedback_enabled, feedback_delay_minutes, auto_close_hours,
       pos_mode, review_link, welcome_image_url
     from dinein_config limit 1`
  );
  res.json(rows[0] || {
    enabled: false, feedback_enabled: true, feedback_delay_minutes: 120, auto_close_hours: 4,
    pos_mode: 'none', review_link: null, welcome_image_url: null,
  });
});

router.post('/dinein-config', requireEraAdmin, async (req, res) => {
  const { enabled } = req.body;
  const { rows } = await pool.query(
    `insert into dinein_config (business_id, enabled) values ((select id from business limit 1), $1)
     on conflict (business_id) do update set enabled = excluded.enabled returning *`,
    [enabled]
  );
  res.json(rows[0]);
});

// Customer database (CRM) add-on toggle -- same dual-auth/ERA-switches-it
// shape as delivery-config/voice-config/dinein-config just above. Chidera,
// 2026-09-16: a client wants a customer profile/spend/birthday dashboard,
// no mass-marketing send (deliberately never built -- see the Customers
// list's "Text" button, which only ever opens ONE existing conversation,
// same as Conversations already does).
router.get('/crm-config', async (req, res) => {
  const isEraAdmin = process.env.EBOS_ADMIN_TOKEN && req.header('x-era-admin-token') === process.env.EBOS_ADMIN_TOKEN;
  if (!isEraAdmin && !req.staff) return res.status(401).json({ error: 'Not logged in.' });
  if (!isEraAdmin && isPinTier(req.staff)) return res.status(403).json({ error: 'Not available to this account.' });
  const { rows } = await pool.query(`select business_id, enabled, birthday_prompt_enabled from crm_config limit 1`);
  res.json(rows[0] || { enabled: false, birthday_prompt_enabled: true });
});

// Chidera, 2026-09-17: "that birthday pop up, not every restaurant needs
// it, let it be a toogle on or off capability" -- birthdayPromptEnabled is
// its own independent field now, not tied to CRM's own on/off. Both args
// optional so the panel's two separate toggles (crm-mode, its own new
// birthday-prompt-mode below) can each update just their own field without
// clobbering the other's current value.
router.post('/crm-config', requireEraAdmin, async (req, res) => {
  const { enabled, birthdayPromptEnabled } = req.body;
  const { rows } = await pool.query(
    `insert into crm_config (business_id, enabled, birthday_prompt_enabled)
     values ((select id from business limit 1), coalesce($1, false), coalesce($2, true))
     on conflict (business_id) do update set
       enabled = coalesce($1, crm_config.enabled),
       birthday_prompt_enabled = coalesce($2, crm_config.birthday_prompt_enabled)
     returning *`,
    [enabled, birthdayPromptEnabled]
  );
  res.json(rows[0]);
});

// Chidera, 2026-09-17: "i give them 1500 free every month then they cover
// the rest by putting money in an account... i extract it from there" --
// ERA's own prepaid message wallet (engine/wallet.js), enabled/credited
// ONLY from the panel side (requireEraAdmin), same "ERA switches these"
// shape as every other add-on toggle. Deliberately no client-facing
// self-service top-up yet -- she credits it herself once she's actually
// received the money, outside this codebase.
router.get('/wallet-status', requireEraAdmin, async (req, res) => {
  res.json((await getWalletStatus()) || { enabled: false, balance_kobo: 0 });
});

router.post('/wallet-credit', requireEraAdmin, async (req, res) => {
  const kobo = Math.round(Number(req.body?.naira) * 100);
  if (!Number.isInteger(kobo) || kobo <= 0) return res.status(400).json({ error: 'A positive naira amount is required.' });
  res.json(await creditWallet(kobo));
});

router.post('/wallet-mode', requireEraAdmin, async (req, res) => {
  const { enabled } = req.body;
  const { rows } = await pool.query(
    `insert into message_wallet (business_id, enabled) values ((select id from business limit 1), $1)
     on conflict (business_id) do update set enabled = excluded.enabled returning *`,
    [Boolean(enabled)]
  );
  res.json(rows[0]);
});

// POS sync add-on (Chidera, 2026-09-16): pulls a client's own Moniepoint POS
// terminal sales into the dashboard as a real transaction list -- separate
// concern from crm-config just above, same dual-auth/ERA-switches-it shape.
// Credentials (webhook_username/password) are only ever set by
// scripts/add-pos-sync.mjs, never echoed back here.
router.get('/pos-sync-config', async (req, res) => {
  const isEraAdmin = process.env.EBOS_ADMIN_TOKEN && req.header('x-era-admin-token') === process.env.EBOS_ADMIN_TOKEN;
  if (!isEraAdmin && !req.staff) return res.status(401).json({ error: 'Not logged in.' });
  if (!isEraAdmin && isPinTier(req.staff)) return res.status(403).json({ error: 'Not available to this account.' });
  // Chidera, 2026-09-24: "monify?" -- was checking webhook_username, the
  // OLD dead API-key system's own column (see the comment on the
  // /webhook-secret route below for why that system never worked). The
  // real, confirmed-working mechanism sets webhook_secret and/or
  // client_id/client_secret instead -- checking those is what actually
  // reflects whether either piece is connected.
  const { rows } = await pool.query(
    `select business_id, enabled, provider,
            webhook_secret is not null as "hasWebhookCredentials",
            client_id is not null and client_secret is not null as "hasClientCredentials",
            terminal_serial, connected_at
     from pos_sync_config limit 1`
  );
  res.json(rows[0] || { enabled: false, provider: 'moniepoint', hasWebhookCredentials: false, hasClientCredentials: false, terminal_serial: null, connected_at: null });
});

router.post('/pos-sync-config', requireEraAdmin, async (req, res) => {
  const { enabled } = req.body;
  const { rows } = await pool.query(
    `insert into pos_sync_config (business_id, enabled) values ((select id from business limit 1), $1)
     on conflict (business_id) do update set enabled = excluded.enabled returning *`,
    [enabled]
  );
  res.json(rows[0]);
});

// Separate from the toggle above on purpose -- only scripts/add-pos-sync.mjs
// (run once a client's real Moniepoint API access is in hand) ever calls
// this, so a plain enable/disable click through the panel can never
// accidentally wipe stored credentials by omitting them from the body.
// Chidera, 2026-09-20: the real connection mechanism -- a webhook
// subscription created through Moniepoint's own Settings UI (not the
// API-key-based system /credentials above was built for, which never
// actually worked) authenticates with an HMAC-SHA256 signature instead of
// Basic auth, one secret, no Moniepoint API call needed to connect it at
// all -- see engine/webhook-moniepoint.js's own comment for the full
// mechanism. requireEraAdmin, same as /credentials -- POS sync stays an
// ERA-switched add-on, not a self-service business-owner setting.
router.post('/pos-sync-config/webhook-secret', requireEraAdmin, async (req, res) => {
  const { secret } = req.body;
  if (!secret) return res.status(400).json({ error: 'secret is required.' });
  const { rows } = await pool.query(
    `insert into pos_sync_config (business_id, enabled, provider, webhook_secret, connected_at)
     values ((select id from business limit 1), true, 'moniepoint', $1, now())
     on conflict (business_id) do update set webhook_secret = excluded.webhook_secret, enabled = true, connected_at = now()
     returning business_id, enabled, provider, connected_at`,
    [secret]
  );
  res.json(rows[0]);
});

// Chidera, 2026-09-21: "LET ME TRY ANOTHER ACCOUNT AND SEE IF IT WORKS" --
// the real "POS as a Platform" API works after all, root cause of every
// earlier "Invalid key provided" was scripts/add-pos-sync.mjs hitting the
// wrong base URL and treating a single api_key as a bearer token directly
// instead of exchanging clientId/clientSecret for one via POST
// channel.moniepoint.com/v1/auth (see pos_sync_config's own schema
// comment, and engine/moniepoint-api.js). Separate from /credentials
// above (the old, dead single-api_key shape) -- this is the real one.
// terminalSerial optional -- the client_id/client_secret pair alone is
// enough to auth (engine/moniepoint-api.js), but ensureDynamicPosAccount
// (flow.js) also needs the terminal serial to push a real one-time
// payment request. Not required here since it's frequently sent together
// but sometimes found/added later (the physical terminal's own sticker).
router.post('/pos-sync-config/client-credentials', requireEraAdmin, async (req, res) => {
  const { clientId, clientSecret, terminalSerial } = req.body;
  if (!clientId || !clientSecret) return res.status(400).json({ error: 'clientId and clientSecret are required.' });
  const { rows } = await pool.query(
    `insert into pos_sync_config (business_id, enabled, provider, client_id, client_secret, terminal_serial, connected_at)
     values ((select id from business limit 1), true, 'moniepoint', $1, $2, $3, now())
     on conflict (business_id) do update set
       client_id = excluded.client_id, client_secret = excluded.client_secret,
       terminal_serial = coalesce(excluded.terminal_serial, pos_sync_config.terminal_serial),
       enabled = true, connected_at = now()
     returning business_id, enabled, provider, terminal_serial, connected_at`,
    [clientId, clientSecret, terminalSerial || null]
  );
  res.json(rows[0]);
});

router.post('/pos-sync-config/credentials', requireEraAdmin, async (req, res) => {
  const { provider, apiKey, webhookUsername, webhookPassword } = req.body;
  if (!webhookUsername || !webhookPassword) return res.status(400).json({ error: 'webhookUsername and webhookPassword are required.' });
  const { rows } = await pool.query(
    `insert into pos_sync_config (business_id, enabled, provider, api_key, webhook_username, webhook_password, connected_at)
     values ((select id from business limit 1), true, $1, $2, $3, $4, now())
     on conflict (business_id) do update set
       provider = excluded.provider, api_key = excluded.api_key,
       webhook_username = excluded.webhook_username, webhook_password = excluded.webhook_password,
       enabled = true, connected_at = now()
     returning business_id, enabled, provider, connected_at`,
    [provider || 'moniepoint', apiKey || null, webhookUsername, webhookPassword]
  );
  res.json(rows[0]);
});

// Chidera, 2026-09-21: "THAT POS MANUAL AND PAYSTACK IS FOR DASH NOT THE
// CLIENT DASHBOARD" -- how a business gets paid is ERA's own decision per
// client, same as pos-sync-config just above, NOT something a business
// owner picks in their own Settings. requireEraAdmin, above
// router.use(requireStaffApi), for the same reason pos-sync-config is.
// Chidera, 2026-09-21: "ISNT THERE ALREADY SPACE IN SETTING TO PUT ACCOUNT
// NUMBER AND ALL?" -- yes, business.bank_name/bank_account_number/
// bank_account_name (the existing "manual" proof-of-payment fields) --
// this route only ever owns `provider`; transfer_* here is a read-only
// join for display, same as engine/payment.js's getPaymentConfig().
router.get('/payment-config', async (req, res) => {
  const isEraAdmin = process.env.EBOS_ADMIN_TOKEN && req.header('x-era-admin-token') === process.env.EBOS_ADMIN_TOKEN;
  if (!isEraAdmin && !req.staff) return res.status(401).json({ error: 'Not logged in.' });
  if (!isEraAdmin && isPinTier(req.staff)) return res.status(403).json({ error: 'Not available to this account.' });
  const { rows } = await pool.query(
    `select pc.provider,
            b.bank_name as transfer_bank_name,
            b.bank_account_number as transfer_account_number,
            b.bank_account_name as transfer_account_name
     from business b
     left join payment_config pc on pc.business_id = b.id
     limit 1`
  );
  res.json(rows[0] || { provider: null, transfer_account_number: null, transfer_account_name: null, transfer_bank_name: null });
});

router.post('/payment-config', requireEraAdmin, async (req, res) => {
  const { provider } = req.body;
  const { rows } = await pool.query(
    `insert into payment_config (business_id, provider) values ((select id from business limit 1), $1)
     on conflict (business_id) do update set provider = excluded.provider
     returning *`,
    [provider || null]
  );
  res.json(rows[0]);
});


// Both below are ERA control-plane calls, same requireEraAdmin gate as
// delivery-config/voice-config/dinein-config just above -- and both must
// stay above the router.use(requireStaffApi) line for the same reason
// those do. Deliberately NOT the existing GET /branches further down
// (staff-session-gated with requireFullAccessApi, for a real, unrelated
// reason) -- this is a narrower, control-plane-only surface for Dash
// OS's own "connect a branch's WhatsApp number" flow (Chidera's ask,
// 2026-09-16).

// Powers the picker on Dash OS's /connect/:token page -- just enough to
// render a dropdown, nothing sensitive.
router.get('/branches/for-connect', requireEraAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `select id, name, area, is_primary from branch where status != 'closed' order by is_primary desc, name`
  );
  res.json(rows);
});

// The actual connect/reconnect write. branch_channel's own unique index
// on (branch_id, channel) means this MUST be an upsert, never a plain
// insert -- a branch reconnecting (rotated token, phone swapped) updates
// its one existing row instead of erroring. The second
// unique index (phone_number_id, where not null) catches a real mistake
// -- the same Meta number accidentally pointed at two different branches
// -- as a clean 409 instead of a raw 500. No encryption on these columns,
// on purpose: branch_channel's own schema comment already says this
// matches secrets.env's plaintext trust boundary, and introducing
// encryption just here would be inconsistent with everything else in
// this codebase, not more secure.
router.post('/branch-channels/whatsapp', requireEraAdmin, async (req, res) => {
  const { branchId, phoneNumberId, accessToken, verifyToken } = req.body || {};
  if (!branchId || !phoneNumberId || !accessToken || !verifyToken) {
    return res.status(400).json({ error: 'branchId, phoneNumberId, accessToken and verifyToken are all required.' });
  }
  const { rows: branchRows } = await pool.query('select id from branch where id = $1', [branchId]);
  if (!branchRows.length) return res.status(404).json({ error: 'No branch with that id.' });
  try {
    const { rows } = await pool.query(
      `insert into branch_channel (branch_id, channel, phone_number_id, access_token, verify_token)
       values ($1, 'whatsapp', $2, $3, $4)
       on conflict (branch_id, channel)
       do update set phone_number_id = excluded.phone_number_id, access_token = excluded.access_token, verify_token = excluded.verify_token
       returning branch_id, channel, phone_number_id`,
      [branchId, phoneNumberId, accessToken, verifyToken]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'branch_channel_phone_number_id_idx') {
      return res.status(409).json({ error: 'This WhatsApp number is already connected to a different branch.' });
    }
    throw err;
  }
});

router.use(requireStaffApi);
router.use(scopeToBranch);
router.use(scopeToWorkArea);

router.use('/delivery', deliveryRoutes);
router.use('/voice', voiceRoutes);
// Was never mounted at all -- DineIn.jsx's tables/feedback/orders-pending
// calls have been 404ing since dine-in Stage 1. Found live, 2026-09-10,
// while adding the in-house-guests orders queue to this same router.
// work_area === 'online' is blocked here, not just hidden from their nav --
// Chidera 2026-09-11's "2 types of staff" split means an online-scoped PIN
// account has no legitimate reason to ever reach dine-in data, same
// defense-in-depth reasoning as requireFullAccessApi's own comment.
// 'in_house' and null (unrestricted -- owner/manager, or any staff from
// before work_area existed) both pass through unchanged.
router.use(
  '/dinein',
  (req, res, next) => {
    if (req.workArea === 'online') return res.status(403).json({ error: 'Not available to this account.' });
    next();
  },
  dineinRoutes
);

// payout_mode/provider/provider_keys are the restaurant's own to set, once
// mode is on -- same level of trust as them already self-managing
// bank_name/bank_account_number in Settings today. Manual is the default
// and stays perfectly usable forever; automatic is an optimisation on top,
// never a requirement.
//
// Automatic payout used to be hard-refused at the code level regardless of
// what was posted (Chidera's earlier call, 2026-09-01: "don't put any
// money yet") -- lifted 2026-09-03 at her explicit "yes" once a real
// restaurant actually wanted it. Still guarded for real, not just
// unlocked outright: 'moniepoint' is refused specifically for automatic
// mode, since engine/payout-providers.js itself fails closed on that
// provider (its transfer API was never independently confirmed against
// real docs -- rule 0.4, never guess with real money), and switching to
// automatic without ever having supplied a secret key (this request or a
// previously saved one) is refused too, so a business can never end up
// "automatic" with nothing on file that could actually pay a rider.
router.post('/delivery-config/payout', requireEditorApi, async (req, res) => {
  const { payout_mode, provider, provider_keys } = req.body;
  if (!['manual', 'automatic'].includes(payout_mode)) {
    return res.status(400).json({ error: 'payout_mode must be "manual" or "automatic".' });
  }
  if (provider && !['paystack', 'flutterwave', 'moniepoint'].includes(provider)) {
    return res.status(400).json({ error: `Unknown payout provider "${provider}".` });
  }
  if (payout_mode === 'automatic') {
    if (!provider) return res.status(400).json({ error: 'Pick a payout provider first.' });
    if (provider === 'moniepoint') {
      return res.status(400).json({ error: 'Moniepoint automatic payout is not built yet -- use manual payout for now, or switch to Paystack/Flutterwave.' });
    }
    const { rows: existing } = await pool.query('select provider_keys from delivery_config limit 1');
    if (!provider_keys?.secretKey && !existing[0]?.provider_keys) {
      return res.status(400).json({ error: 'Add this provider\'s secret key before switching to automatic payout.' });
    }
  }
  const { rows } = await pool.query(
    `with saved as (
       insert into delivery_config (business_id, payout_mode, provider, provider_keys)
       values ((select id from business limit 1), $1, $2, $3)
       on conflict (business_id) do update set payout_mode = excluded.payout_mode, provider = excluded.provider,
         provider_keys = coalesce(excluded.provider_keys, delivery_config.provider_keys)
       returning *
     )
     select business_id, mode, payout_mode, provider, provider_keys is not null as "hasProviderKey", offer_timeout_seconds from saved`,
    [payout_mode, provider || null, provider_keys?.secretKey ? encrypt(JSON.stringify(provider_keys)) : null]
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

// Same security bar as change-password above (current password required) --
// added 2026-09-16 because there was previously no way to change a login
// email at all after a business was created (only set once, at build time,
// via the workstation's owner-email field). Real need: a business is
// sometimes onboarded before the real owner's email is known (a
// placeholder used at build time), or ownership changes hands later.
router.post('/change-email', async (req, res) => {
  const { currentPassword, newEmail } = req.body;
  if (!currentPassword || !newEmail) return res.status(400).json({ error: 'Current password and new email are required.' });

  const { rows } = await pool.query('select * from staff where id = $1', [req.staff.id]);
  const staff = rows[0];
  if (!staff || !(await verifyPassword(staff, currentPassword))) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }

  try {
    await pool.query('update staff set email = $1 where id = $2', [newEmail, staff.id]);
  } catch (err) {
    // staff.email has a unique constraint -- the only realistic way this
    // update fails is another account on this same business already using
    // it, not a generic DB error worth a 500.
    if (err.code === '23505') return res.status(409).json({ error: 'Another account already uses that email.' });
    throw err;
  }
  res.json({ ok: true });
});

// --- Orders ---------------------------------------------------------------

router.get('/orders', async (req, res) => {
  // Orders are always per branch, in both sharing modes (branch addendum
  // section 4) -- unlike customers/menu, there's no mode-dependent case
  // here, so this is a plain filter, not a resolver call. null (no branch
  // lock, no ?branch_id= requested) means "see everything", same as today.
  // Same null-means-unrestricted idiom for work_area -- 'online' excludes
  // dine-in orders, 'in_house' is only dine-in orders, matching the exact
  // two worlds Chidera's staff split creates (2026-09-11).
  const { rows } = await pool.query(
    `select o.*, c.name as customer_name, c.phone_number as customer_phone, c.channel as customer_channel,
            d.rider_name as rider_name,
            (select coalesce(json_agg(json_build_object(
               'name', p.name, 'quantity', oi.quantity,
               'answers', (
                 select coalesce(json_agg(json_build_object('question', pq.question, 'answer', oa.answer) order by oa.created_at), '[]')
                 from order_item_answer oa join product_question pq on pq.id = oa.question_id
                 where oa.order_item_id = oi.id
               )
             )), '[]')
             from order_item oi join product p on p.id = oi.product_id where oi.order_id = o.id) as items
     from "order" o join customers c on c.id = o.customer_id
     left join delivery d on d.order_id = o.id
     where ($1::uuid is null or o.branch_id = $1)
       and ($2::text is null or ($2 = 'online' and o.channel != 'dinein') or ($2 = 'in_house' and o.channel = 'dinein'))
     order by o.created_at desc limit 200`,
    [req.branchId, req.workArea]
  );
  res.json(rows);
});

// Staff creating an order directly -- always a delivery (Chidera's call,
// 2026-09-03: "any order manually created is solely for delivery
// purpose"), for one that came in some way other than a channel this
// system listens on itself (a landline call, a walk-in). Owner/manager
// only (requireEditorApi) and never a PIN-tier session even if one
// somehow held a manager role (requireFullAccessApi) -- creating a real,
// priced, already-marked-paid order is a different trust level than the
// one write action (notify-ready) Tier 3 gets.
//
// Reuses the real engine pieces rather than a second, parallel path:
// findOrCreateCustomer (same lookup/branch-scoping WhatsApp uses) and
// newReference for the order number. Item prices are always the real,
// current product.price -- never trusted from the request, exactly like
// every other place an order gets priced.
//
// The delivery AREA is a real dropdown of this business's own configured
// delivery_zone rows (f.zoneId), not free-text address matching -- used
// to run the address through resolveZoneForAddress the same fuzzy way
// the bot does, but a manually typed address that didn't match any zone's
// name/aliases meant no delivery_zone_id at all, which meant
// maybeDispatchOwnRiders (routes/api.js's /orders/:id/status) silently
// never dispatched a rider for it -- staff had no way to notice until
// "Ring rider" turned up "No rider offer exists for this order" on an
// order that looked completely normal otherwise. Picking a real zone up
// front makes that failure mode impossible by construction.
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
  if (!f.address) return res.status(400).json({ error: 'A delivery address is required.' });

  const branchId = req.branchId || f.branch_id || null;
  const customer = await findOrCreateCustomer({ phoneNumber: f.phone, channel: 'manual', branchId });
  // Kept in sync on the in-memory customer object too, not just written to
  // the row -- createDelivery() below reads customer.address directly, and
  // a stale value here would silently create a delivery row with the
  // customer's OLD (or no) address instead of the one just typed in.
  await pool.query('update customers set address = $1 where id = $2', [f.address, customer.id]);
  customer.address = f.address;

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
  const deliveryConfig = await getDeliveryConfig();
  if (deliveryConfig.mode === 'own_riders') {
    if (!f.zoneId) return res.status(400).json({ error: 'Pick a delivery area for this order.' });
    const { rows: zoneRows } = await pool.query('select * from delivery_zone where id = $1', [f.zoneId]);
    if (!zoneRows[0]) return res.status(400).json({ error: 'That delivery area no longer exists -- pick another.' });
    deliveryZoneId = zoneRows[0].id;
    deliveryFee = Number(zoneRows[0].customer_fee);
  }

  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, engine_state, status, total, delivery_fee, payment_status, fulfilment_type, branch_id, delivery_zone_id)
     values ($1, $2, 'fulfilment', 'preparation', $3, $4, 'confirmed', 'delivery', $5, $6) returning *`,
    [customer.id, newReference('ORD'), itemsTotal + deliveryFee, deliveryFee, branchId, deliveryZoneId]
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
  await createDelivery(order, customer);

  await logActivity(req, 'order_created_manually', { entityType: 'order', entityId: order.id, detail: { reference: order.reference } });
  res.status(201).json(order);
});

// Today's dashboard summary card. Defined before /orders/:id below even
// though the path shape (/orders/stats/today) can't actually collide with
// it (that only matches a single path segment) -- kept here anyway so the
// "specific route before :id" convention stays consistent everywhere in
// this file, after the bulk-import bug that convention exists to prevent.
router.get('/orders/stats/today', async (req, res) => {
  const [{ rows: totals }, { rows: busiest }] = await Promise.all([
    // Collected/Outstanding/Average count only orders both placed AND
    // already paid -- there's no dedicated "paid at" timestamp on `order`
    // (updated_at gets bumped by unrelated activity, like getOpenOrder's
    // staleness touch), so this is the closest honest proxy: today's
    // placed orders that have since been paid, not strictly "paid today".
    // Good enough for a same-day summary card, not meant as an accounting
    // close.
    // Chidera, 2026-09-24: "there should be an outstanding" -- total is
    // every today order regardless of payment status; outstanding is
    // computed below as total minus collected (never counts a cancelled
    // order's full value as still-owed forever, since a cancelled order's
    // own total should be excluded from what's actually still expected --
    // see the where clause below).
    pool.query(
      `select count(*) as orders,
              coalesce(sum(total) filter (where payment_status in ('confirmed', 'accepted')), 0) as collected,
              coalesce(sum(total) filter (where status != 'cancelled'), 0) as total_value
       from "order" where created_at >= date_trunc('day', now()) and ($1::uuid is null or branch_id = $1)
         and ($2::text is null or ($2 = 'online' and channel != 'dinein') or ($2 = 'in_house' and channel = 'dinein'))`,
      [req.branchId, req.workArea]
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
  const outstanding = Math.max(0, Number(t.total_value) - collected);
  const average = orders > 0 ? Math.round(collected / orders) : 0;
  const busiestHour = busiest[0]
    ? { start: busiest[0].hour, count: Number(busiest[0].count) }
    : null;

  res.json({ orders, collected, outstanding, average, busiestHour });
});

router.get('/orders/:id', async (req, res) => {
  const { rows: orderRows } = await pool.query('select * from "order" where id = $1', [req.params.id]);
  const order = orderRows[0];
  if (!order) return res.status(404).json({ error: 'Not found.' });
  // Chidera, 2026-09-17: "when you ask those penne or spaghetti questions
  // or cold or room temperature, you dont record it anywhere??" -- the
  // answer was genuinely saved (order_item_answer, flow.js's
  // askNextItemQuestion/its own insert), just never read back anywhere
  // staff could see it -- captured, then invisible to whoever actually
  // preps the order. json_agg here, not a separate query, since answers
  // is naturally a per-item array.
  const { rows: items } = await pool.query(
    `select oi.*, p.name, p.category,
       coalesce(
         (select json_agg(json_build_object('question', pq.question, 'answer', oa.answer) order by oa.created_at)
          from order_item_answer oa join product_question pq on pq.id = oa.question_id
          where oa.order_item_id = oi.id),
         '[]'
       ) as answers
     from order_item oi join product p on p.id = oi.product_id where oi.order_id = $1`,
    [order.id]
  );
  const { rows: customerRows } = await pool.query('select * from customers where id = $1', [order.customer_id]);
  const { rows: topups } = await pool.query('select * from order_topup where order_id = $1 order by created_at', [order.id]);
  // Most-recent-first, same reasoning as OrderDetail.jsx's gallery -- the
  // newest proof (e.g. for a top-up just sent) is what staff need to see
  // first. Falls back to the old single order.payment_proof_url column only
  // when there's no row here yet -- an order already mid-flow the moment
  // this table shipped shouldn't lose an already-submitted proof.
  const { rows: paymentProofRows } = await pool.query(
    'select id, data_url, created_at from order_payment_proof where order_id = $1 order by created_at desc',
    [order.id]
  );
  const paymentProofs =
    paymentProofRows.length || !order.payment_proof_url
      ? paymentProofRows
      : [{ id: 'legacy', data_url: order.payment_proof_url, created_at: order.created_at }];
  const { rows: delivery } = await pool.query('select * from delivery where order_id = $1', [order.id]);
  // Own_riders only -- the id staff need to call the /release override on
  // (routes/delivery.js), since `delivery` above is just the summary row
  // every provider shares and has no assignment id of its own.
  const { rows: assignment } = await pool.query(
    `select id, status from delivery_assignment where order_id = $1 order by created_at desc limit 1`,
    [order.id]
  );
  // Chidera, 2026-09-21: "the orders placed that appear in the kanban for
  // in house can it be printed from a docket?" -- the printed docket
  // (OrderDetail.jsx) needs the table label, which the order row itself
  // doesn't carry (table_id only).
  const { rows: tableRows } = order.table_id
    ? await pool.query('select label from restaurant_table where id = $1', [order.table_id])
    : { rows: [] };
  const { rows: bizRows } = await pool.query('select name from business limit 1');
  res.json({
    order,
    items,
    customer: customerRows[0] || null,
    topups,
    paymentProofs,
    delivery: delivery[0] || null,
    deliveryAssignment: assignment[0] || null,
    tableLabel: tableRows[0]?.label || null,
    businessName: bizRows[0]?.name || null,
  });
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

// Staff's manual retry for a push that never rang (Chidera's report,
// 2026-09-03: "it didnt even ring atall this time") -- requireStaffApi,
// same tier as notify-ready and status above, since this is the same kind
// of one-click action a Tier 3 (PIN) staff member acting on the Orders tab
// needs, not an owner-only capability.
router.post('/orders/:id/ring-rider', requireStaffApi, async (req, res) => {
  try {
    const result = await manuallyRingForRider(req.params.id);
    await logActivity(req, 'order_rider_rung', { entityType: 'order', entityId: req.params.id, detail: result });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Chidera, 2026-09-24, real live incident: a rider was waiting on a
// customer code that could never come (a test), and there was no way to
// close the order out -- routes/delivery.js's /assignments/:id/release
// only exists for own_riders orders that got as far as a real
// delivery_assignment row, and nextStageFor's own in_transit case
// deliberately returns null (2026-09-21: no generic "mark completed" with
// no reason). Between those two, an in_transit order with no assignment
// (third-party delivery, or own_riders but no rider ever actually
// accepted) had no path off in_transit at all. "Every order in transit
// should be able to be released with reason" -- this is that path, order-
// scoped rather than assignment-scoped: if a real assignment exists it's
// released exactly like the dedicated route would (rider still gets
// paid), and if not, the order still closes out with the same
// reason-required accountability, just with nothing assignment-specific
// to update.
router.post('/orders/:id/release', requireEditorApi, async (req, res) => {
  const reason = (req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required.' });

  const { rows: orderRows } = await pool.query('select * from "order" where id = $1', [req.params.id]);
  const order = orderRows[0];
  if (!order) return res.status(404).json({ error: 'Not found.' });
  if (order.status !== 'in_transit') return res.status(409).json({ error: 'This order is not in transit.' });

  const { rows: assignmentRows } = await pool.query(
    `select id from delivery_assignment where order_id = $1 and status not in ('DELIVERED', 'FAILED') order by created_at desc limit 1`,
    [order.id]
  );
  if (assignmentRows[0]) {
    await pool.query(
      `update delivery_assignment set status = 'DELIVERED', delivered_at = now(), released_by_staff = $1, override_reason = $2 where id = $3`,
      [req.staff.id, reason, assignmentRows[0].id]
    );
  }
  await pool.query(`update delivery set status = 'delivered' where order_id = $1`, [order.id]);
  // Chidera, real live report right after this route shipped: "my order
  // with dee is complete but im texting them and instead of starting a
  // new chat im geting the paid and its on its way text" -- status alone
  // isn't enough. engine/flow.js's getOpenOrder gates on engine_state, not
  // status (see routes/rider.js's own /deliver route and its 2026-09-03
  // comment for the first time this exact bug was found and fixed) --
  // without also moving engine_state here, a released order still looks
  // "open" to the bot forever, and the customer's next message keeps
  // routing into the finished order's own fulfilment-stage handler instead
  // of ever reaching the post-completion flow.
  await pool.query(`update "order" set status = 'completed', engine_state = 'completed', completed_at = now() where id = $1`, [order.id]);
  sendFeedbackRequest(order.id).catch((err) => console.error('sendFeedbackRequest failed:', err.message));
  await logActivity(req, 'order_released', { entityType: 'order', entityId: order.id, detail: { reason, hadAssignment: !!assignmentRows[0] } });
  res.json({ ok: true });
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
  // completed_at drives the 24h "want to order again?" window -- see
  // schema.sql's comment on the column.
  if (status === 'completed') {
    await pool.query('update "order" set completed_at = now() where id = $1', [req.params.id]);
    // One of the three real completion sites -- covers pickup's "Picked
    // up" click and dine-in's "Mark paid" (In House's second pipeline).
    // Fire-and-forget: a feedback-send failure should never block staff
    // from actually closing the order out.
    sendFeedbackRequest(req.params.id).catch((err) => console.error('sendFeedbackRequest failed:', err.message));
    // Dine-in only (session_id is null for pickup/delivery orders) -- if
    // this was the last outstanding order in its table_session, close the
    // table automatically instead of making staff also tap "Close table"
    // separately. Chidera 2026-09-11: "marking an in house order as paid
    // should close the table automatically." Fire-and-forget, same
    // reasoning as sendFeedbackRequest above -- this never blocks the
    // order actually being marked paid.
    pool
      .query('select session_id from "order" where id = $1', [req.params.id])
      .then(({ rows }) => {
        if (rows[0]?.session_id) return closeTableSessionIfSettled(rows[0].session_id, { closedBy: 'auto', staffId: req.staff.id });
      })
      .catch((err) => console.error('closeTableSessionIfSettled failed:', err.message));
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
  // Staff hitting "Mark in delivery" themselves (handing the order to a
  // rider directly, arranging delivery outside the app) means a still-OPEN
  // own_riders offer for it must stop being offered around -- Chidera's
  // ask, 2026-09-11: "when an order is marked in delivery manually from
  // the pipeline, it should stop showing as accept on riders phones as
  // well." Cancelling it here (not leaving it to rot until the timeout
  // sweep) also retracts it from any rider who already has it up on
  // screen right now, over the same offerBus every new offer already
  // broadcasts through -- routes/rider.js's /offers/stream forwards a
  // `retracted: true` event, and the rider app clears it if it's the one
  // currently showing.
  if (status === 'in_transit') {
    const { rows: cancelledOffers } = await pool.query(
      `update delivery_offer set status = 'CANCELLED' where order_id = $1 and status = 'OPEN' returning id, branch_id`,
      [req.params.id]
    );
    for (const offer of cancelledOffers) {
      offerBus.emit('offer', { id: offer.id, branchId: offer.branch_id, retracted: true });
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

// A top-up (engine/flow.js's sendTopupInvoice, for items added to an
// already-paid order) is its own small, separate payment -- confirming it
// only marks that one order_topup row, deliberately not the wider
// confirm-payment/completePayment() flow above, which is for the order's
// original payment and would be a no-op (or worse, re-run delivery/receipt
// side effects) on an order that's already past that point.
router.post('/orders/:id/topups/:topupId/confirm', requireStaffApi, async (req, res) => {
  const { rows } = await pool.query(
    `update order_topup set payment_status = 'confirmed' where id = $1 and order_id = $2 returning *`,
    [req.params.topupId, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found.' });
  await logActivity(req, 'order_topup_confirmed', { entityType: 'order', entityId: req.params.id, detail: { topupId: req.params.topupId, amount: rows[0].amount } });
  res.json({ ok: true });
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

// --- Feedback (order_feedback -- see engine/flow.js's sendFeedbackRequest,
// sent for every order the moment it's actually completed, not just
// dine-in on table-close) -----------------------------------------------

// Shared by all three views below -- 'online'/'dinein' is the same
// null-means-everything, "differentiate feedback for in house or online"
// idiom used everywhere else in this file (see scopeToWorkArea). Owner/
// manager only (requireEditorApi), same tier as Roles/Activity log --
// customer feedback isn't a PIN-tier staff member's to see.
// colPrefix qualifies the column (e.g. "f.") -- found live, 2026-09-11,
// Chidera: "the page is empti its meant to have cards": /feedback/recent
// joins "order" o, which ALSO has its own channel column, so the bare
// "channel" this used before was genuinely ambiguous SQL -- every call to
// /feedback/recent 500'd, and Feedback.jsx's `if (!summary || !recent ||
// !monthly) return null` meant the whole page just silently never
// rendered anything while waiting on a request that would never resolve.
function feedbackChannelClause(paramIndex, colPrefix = '') {
  return `($${paramIndex}::text is null or ($${paramIndex} = 'online' and ${colPrefix}channel != 'dinein') or ($${paramIndex} = 'dinein' and ${colPrefix}channel = 'dinein'))`;
}

router.get('/feedback/summary', requireEditorApi, async (req, res) => {
  const channel = ['online', 'dinein'].includes(req.query.channel) ? req.query.channel : null;
  const { rows } = await pool.query(
    `select avg(experience_rating) as experience, avg(food_rating) as food, avg(service_rating) as service, count(*) as total
     from order_feedback
     where status = 'answered' and ($1::uuid is null or branch_id = $1) and ${feedbackChannelClause(2)}`,
    [req.branchId, channel]
  );
  res.json(rows[0]);
});

// Last 7 days only -- Chidera 2026-09-11: "the individual is for a week
// only after a weak it can clear so that it wont get too chocked up."
// Nothing is ever deleted (that's what /feedback/monthly and
// /feedback/summary above are for, unaffected by this window) -- purely a
// display filter on the recent-list view.
router.get('/feedback/recent', requireEditorApi, async (req, res) => {
  const channel = ['online', 'dinein'].includes(req.query.channel) ? req.query.channel : null;
  const { rows } = await pool.query(
    `select f.*, o.reference as order_reference, c.name as customer_name, c.phone_number as customer_phone
     from order_feedback f
     join "order" o on o.id = f.order_id
     join customers c on c.id = f.customer_id
     where f.status = 'answered' and f.created_at > now() - interval '7 days'
       and ($1::uuid is null or f.branch_id = $1) and ${feedbackChannelClause(2, 'f.')}
     order by f.created_at desc limit 200`,
    [req.branchId, channel]
  );
  res.json(rows);
});

// "he can see feedback per month" -- one row per calendar month, so a
// manager can tell whether the experience is trending up or down over
// time, not just a single all-time number.
router.get('/feedback/monthly', requireEditorApi, async (req, res) => {
  const channel = ['online', 'dinein'].includes(req.query.channel) ? req.query.channel : null;
  const { rows } = await pool.query(
    `select to_char(date_trunc('month', created_at), 'YYYY-MM') as month,
            avg(experience_rating) as experience, avg(food_rating) as food, avg(service_rating) as service, count(*) as total
     from order_feedback
     where status = 'answered' and ($1::uuid is null or branch_id = $1) and ${feedbackChannelClause(2)}
     group by 1 order by 1 desc limit 24`,
    [req.branchId, channel]
  );
  res.json(rows);
});

// --- Catalogue --------------------------------------------------------

router.get('/catalogue', async (req, res) => {
  const { rows } = await pool.query(
    `select p.*,
       (select coalesce(json_agg(json_build_object('componentProductId', pci.component_product_id, 'name', cp.name, 'quantity', pci.quantity)), '[]')
        from product_combo_item pci join product cp on cp.id = pci.component_product_id where pci.product_id = p.id) as combo_items
     from product p
     order by p.position asc nulls last, p.created_at asc`
  );
  res.json(rows);
});

// requireStaffApi, not requireEditorApi -- Catalogue and Knowledge base
// (every requireStaffApi route from here through the knowledge-base block
// below) are deliberately open to Tier 3 (PIN) staff too, same "widened so
// staff can work normally, not just view" call as the orders write routes
// above (Chidera's own words, 2026-09-03: "when i say they can see
// knowledge base and catalogue it means they can edit it and work on it
// normally not just view only").
router.post('/catalogue', requireStaffApi, async (req, res) => {
  const f = req.body;
  const { rows } = await pool.query(
    `insert into product (name, description, price, availability_type, duration_minutes, category, image_data_url, position)
     values ($1, $2, $3, $4, $5, $6, $7, (select coalesce(max(position), 0) + 1 from product)) returning *`,
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
router.post('/catalogue/bulk-import', requireStaffApi, async (req, res) => {
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
  // Sequential positions in the order items were found in the source
  // text/photo(s) -- parseMenuText/parseMenuImages return items in reading
  // order, so this is what preserves the real menu's own layout (both
  // which category appears first and item order within it) instead of
  // Catalogue.jsx falling back to an alphabetical re-sort. One query for
  // the starting point, then a plain per-item increment -- newItems is
  // never large enough (a single menu upload) to need a bulk insert.
  const { rows: maxPositionRows } = await pool.query('select coalesce(max(position), 0) as max from product');
  let nextPosition = maxPositionRows[0].max;
  for (const item of newItems) {
    nextPosition += 1;
    await pool.query(
      `insert into product (name, description, price, availability_type, category, import_status, position) values ($1, $2, $3, 'stock', $4, 'new', $5)`,
      [item.name, item.description, item.price, item.category, nextPosition]
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

router.post('/catalogue/import/:id/approve', requireStaffApi, async (req, res) => {
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

router.post('/catalogue/import/:id/reject', requireStaffApi, async (req, res) => {
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

// A combo/special offer -- its own name, its own bundled price, a real
// list of what's inside -- created here as its own thing, not a flag
// "marked" onto an ordinary item. Chidera 2026-09-10: "a special offer is
// a combo so it should be created not marked... with form style adding
// the items in the deal and how much and name of deal." Defined before
// /catalogue/:id below for the same reason bulk-import is -- Express would
// otherwise try to match "combo" as an :id and fail the uuid cast.
router.post('/catalogue/combo', requireStaffApi, async (req, res) => {
  const f = req.body;
  const items = Array.isArray(f.items) ? f.items : [];
  if (!f.name || !f.price) return res.status(400).json({ error: 'Name and price are required.' });
  if (!items.length) return res.status(400).json({ error: 'A combo needs at least one item in it.' });

  const productIds = items.map((i) => i.productId);
  const { rows: realProducts } = await pool.query('select id, name, is_combo from product where id = any($1::uuid[])', [productIds]);
  const byId = new Map(realProducts.map((p) => [p.id, p]));
  for (const item of items) {
    const p = byId.get(item.productId);
    if (!p) return res.status(400).json({ error: 'One of the items in this deal no longer exists on the menu.' });
    if (p.is_combo) return res.status(400).json({ error: "A combo can only include real menu items, not another combo." });
  }

  // Stored straight into description -- every existing customer-facing
  // read (menuForBranch, resolveMenu, receipts, the upsell offer) already
  // shows description with no change needed, rather than every one of
  // them growing its own product_combo_item join just for this.
  const description = `Includes: ${items.map((item) => `${item.quantity || 1}x ${byId.get(item.productId).name}`).join(', ')}`;

  const { rows: productRows } = await pool.query(
    `insert into product (name, description, price, category, is_combo, position)
     values ($1, $2, $3, 'Special Offers', true, (select coalesce(max(position), 0) + 1 from product)) returning *`,
    [f.name, description, f.price]
  );
  const combo = productRows[0];
  for (const item of items) {
    await pool.query('insert into product_combo_item (product_id, component_product_id, quantity) values ($1, $2, $3)', [combo.id, item.productId, item.quantity || 1]);
  }
  syncBestEffort();
  res.status(201).json({
    ...combo,
    combo_items: items.map((item) => ({ componentProductId: item.productId, name: byId.get(item.productId).name, quantity: item.quantity || 1 })),
  });
});

// Per-item customization questions (product_question) -- Catalogue.jsx's
// own add/list/remove UI has been calling these three routes all along,
// but they were never actually defined here. The table and the bot side
// (engine/flow.js's askNextItemQuestion) were both real and working --
// this was the one missing piece, which is exactly why adding a question
// from the dashboard never seemed to do anything. Chidera 2026-09-11:
// "when i add questions per food item it doesnt reeflect."
router.get('/catalogue/:id/questions', async (req, res) => {
  const { rows } = await pool.query('select * from product_question where product_id = $1 order by position, created_at', [req.params.id]);
  res.json(rows);
});

// options: Chidera, 2026-09-20: "should not be a text thing they should
// pick from dropdown ... so it can be faster" -- optional; a staff member
// leaving it blank keeps the exact same free-text question it always was.
// Trimmed and empties dropped so a stray blank row typed in the Catalogue
// UI never becomes a real, selectable dropdown option.
router.post('/catalogue/:id/questions', requireStaffApi, async (req, res) => {
  const question = (req.body?.question || '').trim();
  if (!question) return res.status(400).json({ error: 'A question is required.' });
  const options = Array.isArray(req.body?.options)
    ? req.body.options.map((o) => String(o).trim()).filter(Boolean)
    : [];
  const { rows: existing } = await pool.query('select coalesce(max(position), -1) as max_position from product_question where product_id = $1', [req.params.id]);
  const { rows } = await pool.query(
    'insert into product_question (product_id, question, options, position) values ($1, $2, $3, $4) returning *',
    [req.params.id, question, options.length ? options : null, existing[0].max_position + 1]
  );
  res.status(201).json(rows[0]);
});

router.delete('/catalogue/questions/:questionId', requireStaffApi, async (req, res) => {
  await pool.query('delete from product_question where id = $1', [req.params.questionId]);
  res.json({ ok: true });
});

router.post('/catalogue/:id', requireStaffApi, async (req, res) => {
  const f = req.body;
  const { rows } = await pool.query(
    'update product set name = $1, description = $2, price = $3, availability_type = $4, duration_minutes = $5, category = $6, image_data_url = coalesce($7, image_data_url) where id = $8 returning *',
    [f.name, f.description || null, f.price, f.availability_type || 'stock', f.duration_minutes || null, f.category || null, f.image_data_url || null, req.params.id]
  );
  syncBestEffort();
  res.json(rows[0]);
});

router.post('/catalogue/:id/toggle', requireStaffApi, async (req, res) => {
  const { rows } = await pool.query('update product set availability = not availability where id = $1 returning *', [req.params.id]);
  syncBestEffort();
  res.json(rows[0]);
});

router.delete('/catalogue/:id', requireStaffApi, async (req, res) => {
  try {
    await pool.query('delete from product where id = $1', [req.params.id]);
  } catch (err) {
    // component_product_id on product_combo_item has no ON DELETE CASCADE
    // on purpose (see schema.sql) -- deleting an item that's still inside
    // a combo should fail loudly, not silently leave that combo claiming
    // to include something that no longer exists.
    if (err.code === '23503') return res.status(409).json({ error: 'This item is part of a special offer/combo -- remove it from that deal first, or delete the deal instead.' });
    throw err;
  }
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
  // Same order-stage lookup /conversations/needs-attention already does --
  // Chidera's call, 2026-09-03: "on conversation-active tab let stage show
  // there too". One shared query for both tabs (client/src/pages/
  // Conversations.jsx) instead of a second near-duplicate endpoint.
  const { rows } = await pool.query(`
    select c.*, coalesce(o.status, 'new') as stage
    from customers c
    left join lateral (
      select status from "order"
      where customer_id = c.id and status != 'cancelled'
      order by created_at desc limit 1
    ) o on true
    order by c.last_message_at desc nulls last limit 200
  `);
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
            c.handover_reason as reason, c.handover_at as at, o.id as order_id, o.reference as order_reference, null as zone_name, null::uuid as callback_task_id,
            coalesce(o.status, 'new') as stage
     from customers c
     -- Most recent non-cancelled order for this customer, if any -- same
     -- "no order yet" case as orderStages.js's own 'new' stage (a draft
     -- order still being built through chat, before staff's kanban board
     -- ever renders it), which is also what a customer with no order row
     -- at all falls back to here via coalesce.
     left join lateral (
       select id, reference, status from "order"
       where customer_id = c.id and status != 'cancelled'
       order by created_at desc limit 1
     ) o on true
     -- Voice channel excluded here on purpose: a voice handover shows up
     -- below instead, as its own richer 'callback' row (with a real
     -- context_summary and a claim/resolve workflow this generic
     -- customers.handled_by flag has none of) -- not both, which would
     -- show the same caller twice in the one queue staff watch (C1).
     where c.handled_by = 'staff' and c.channel != 'voice' and ($1::uuid is null or c.branch_id = $1)
     union all
     select 'delivery' as kind, o.id, null, null, null, null,
            'No rider has accepted this delivery' as reason, o.staff_alerted_at as at, o.order_id, ord.reference as order_reference, z.name as zone_name, null::uuid as callback_task_id,
            null as stage
     from delivery_offer o
     join delivery_zone z on z.id = o.zone_id
     join "order" ord on ord.id = o.order_id
     where o.status = 'OPEN' and o.staff_alerted_at is not null and ($1::uuid is null or o.branch_id = $1)
     union all
     select 'callback' as kind, c.id, c.name, c.phone_number, c.channel, c.channel_id,
            ct.reason as reason, ct.created_at as at, null::uuid as order_id, null as order_reference, null as zone_name, ct.id as callback_task_id,
            null as stage
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

// Customer database (CRM add-on) -- every customer with spend computed
// live from real completed orders, never a separately-maintained number
// that could drift from the actual order history. Deliberately no bulk-
// send anywhere on this list or its export -- see crm-config's own comment
// on why (Chidera's explicit call, 2026-09-16).
// segment: the same New/Repeat/VIP definitions /customers/stats uses below
// (1 order / 2+ orders / top 10% spend among ordering customers) -- one
// customer's segment must never disagree between the stats cards and this
// list's own status badge, so both read it from the identical case
// expression rather than two separately-maintained rules.
// Every ordering customer falls into exactly one segment (matches a
// mockup the client shared where New + Repeat + VIP sums to 100%): New =
// exactly 1 completed order; VIP = top 10% by spend AMONG customers with
// 2+ orders (so VIP is always a subset of "has ordered more than once",
// never a one-off big spender counted as both New and VIP); Repeat =
// everyone else with 2+ orders. spend_pct_rank is computed only within the
// 2+-orders group for that reason -- ranking against every ordering
// customer (including one-time ones) would let a single big first order
// rank as VIP despite having no repeat behaviour at all.
router.get('/customers', requireFullAccessApi, async (req, res) => {
  const { rows } = await pool.query(
    `select c.*,
       coalesce(o.order_count, 0)::int as order_count,
       coalesce(o.total_spend, 0) as total_spend,
       case when coalesce(o.order_count, 0) > 0 then round(o.total_spend / o.order_count, 2) else 0 end as average_spend,
       case
         when coalesce(o.order_count, 0) = 0 then null
         when o.order_count = 1 then 'new'
         when coalesce(r.spend_pct_rank, 0) >= 0.9 then 'vip'
         else 'repeat'
       end as segment
     from customers c
     left join (
       select customer_id, count(*) as order_count, sum(total) as total_spend
       from "order" where status = 'completed'
       group by customer_id
     ) o on o.customer_id = c.id
     left join (
       select customer_id, percent_rank() over (order by total_spend) as spend_pct_rank
       from (
         select customer_id, sum(total) as total_spend
         from "order" where status = 'completed'
         group by customer_id having count(*) >= 2
       ) repeat_spend
     ) r on r.customer_id = c.id
     order by o.total_spend desc nulls last, c.created_at desc`
  );
  res.json(rows);
});

// How often an upsell offer actually landed. There's no explicit
// "accepted" flag anywhere (a tapped or typed acceptance inserts an
// order_item the exact same way any other item does -- see engine/flow.js's
// handleUpsellListTap/handlePendingUpsell) -- so "accepted" is inferred the
// same way nextUpsellGroup itself decides a category's already satisfied:
// the completed order ends up containing a product whose category matches
// the offered group's keywords. dateWhereSql/dateParams let the two
// callers below scope this to "all time" or one calendar month without
// duplicating the match-and-count logic itself.
async function computeUpsellStats(dateWhereSql, dateParams) {
  const { rows } = await pool.query(
    `select o.upsell_offered,
       coalesce(array_agg(distinct p.category) filter (where p.category is not null), '{}') as item_categories
     from "order" o
     left join order_item oi on oi.order_id = o.id
     left join product p on p.id = oi.product_id
     where o.status = 'completed' and o.upsell_offered != '{}' ${dateWhereSql}
     group by o.id, o.upsell_offered`,
    dateParams
  );
  let accepted = 0;
  for (const row of rows) {
    // Only one offer per order going forward (Chidera, 2026-09-20: "only
    // upsell once"), but upsell_offered is still an array for older orders
    // from before that -- the last entry is the one that was actually
    // left standing when the order completed.
    const key = row.upsell_offered[row.upsell_offered.length - 1];
    const group = UPSELL_GROUPS.find((g) => g.key === key);
    if (!group) continue;
    if (row.item_categories.some((c) => categoryMatchesGroup(c, group.keywords))) accepted++;
  }
  const offered = rows.length;
  return {
    upsellOffered: offered,
    upsellAccepted: accepted,
    upsellSuccessRate: offered > 0 ? Math.round((accepted / offered) * 1000) / 10 : null,
  };
}

// Dashboard cards/charts (Chidera, 2026-09-16, matching a client's own CRM
// mockup) -- New = exactly 1 completed order, Repeat = 2+, VIP = top 10%
// by total spend among customers who've ordered at least once. Retention
// rate is deliberately just "repeat / everyone who's ordered at least
// once" -- the same repeat-customer count the stat card already shows, not
// a second, differently-defined number. "vs last month" compares the
// trailing 30 days to the 30 days before that; a metric with nothing in
// the prior window (deltaPct: null) shows as new rather than a fake "+infinity%".
router.get('/customers/stats', requireFullAccessApi, async (req, res) => {
  const [totals, segments, thisMonth, lastMonth, daily, upsell] = await Promise.all([
    pool.query(`select count(*)::int as total_customers from customers`),
    pool.query(
      `with per_customer as (
         select customer_id, count(*) as order_count, sum(total) as total_spend
         from "order" where status = 'completed'
         group by customer_id
       ),
       repeat_ranked as (
         select customer_id, percent_rank() over (order by total_spend) as spend_pct_rank
         from per_customer where order_count >= 2
       )
       select
         count(*) filter (where c.order_count = 1)::int as new_count,
         count(*) filter (where c.order_count >= 2)::int as repeat_count,
         count(*) filter (where c.order_count > 0)::int as ordering_count,
         count(*) filter (where r.spend_pct_rank >= 0.9)::int as vip_count,
         coalesce(sum(c.total_spend), 0) as total_revenue
       from per_customer c
       left join repeat_ranked r on r.customer_id = c.customer_id`
    ),
    // "This month" -- trailing 30 days, not calendar-month, so the number
    // is always a real rolling window (a business built on the 3rd of the
    // month never sees a nonsensical "week-old data = 100% of the month").
    pool.query(
      `select count(distinct customer_id) filter (where order_rank = 1)::int as new_customers,
         coalesce(sum(total) filter (where completed_at > now() - interval '30 days'), 0) as revenue
       from (
         select customer_id, total, completed_at, row_number() over (partition by customer_id order by completed_at) as order_rank
         from "order" where status = 'completed'
       ) o
       where completed_at > now() - interval '30 days'`
    ),
    pool.query(
      `select count(distinct customer_id) filter (where order_rank = 1)::int as new_customers,
         coalesce(sum(total) filter (where completed_at between now() - interval '60 days' and now() - interval '30 days'), 0) as revenue
       from (
         select customer_id, total, completed_at, row_number() over (partition by customer_id order by completed_at) as order_rank
         from "order" where status = 'completed'
       ) o
       where completed_at between now() - interval '60 days' and now() - interval '30 days'`
    ),
    // Last 7 days, one row per day: how many customers placed their FIRST
    // ever completed order that day (new) vs a later one (repeat) -- the
    // Customer Overview line chart.
    pool.query(
      `select date(completed_at) as day,
         count(*) filter (where order_rank = 1)::int as new_customers,
         count(*) filter (where order_rank > 1)::int as repeat_customers
       from (
         select customer_id, completed_at, row_number() over (partition by customer_id order by completed_at) as order_rank
         from "order" where status = 'completed'
       ) o
       where completed_at > now() - interval '7 days'
       group by date(completed_at)
       order by day`
    ),
    computeUpsellStats('', []),
  ]);

  const s = segments.rows[0];
  const totalCustomers = totals.rows[0].total_customers;
  const retentionRate = s.ordering_count > 0 ? Math.round((s.repeat_count / s.ordering_count) * 1000) / 10 : 0;

  const pctChange = (current, previous) => (previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null);

  res.json({
    totalCustomers,
    repeatCustomers: s.repeat_count,
    retentionRate,
    totalRevenue: Number(s.total_revenue),
    // vip_count is already a subset of repeat_count (computed only among
    // 2+-order customers, same as the /customers list's own segment
    // column), so this subtraction can never go negative.
    segments: { new: s.new_count, repeat: s.repeat_count - s.vip_count, vip: s.vip_count },
    deltas: {
      newCustomersPct: pctChange(thisMonth.rows[0].new_customers, lastMonth.rows[0].new_customers),
      revenuePct: pctChange(Number(thisMonth.rows[0].revenue), Number(lastMonth.rows[0].revenue)),
    },
    daily: daily.rows.map((r) => ({ day: r.day, newCustomers: r.new_customers, repeatCustomers: r.repeat_customers })),
    upsellOffered: upsell.upsellOffered,
    upsellAccepted: upsell.upsellAccepted,
    upsellSuccessRate: upsell.upsellSuccessRate,
  });
});

// Same shape as /customers/stats above (stat cards + Customer Overview
// chart + Customer Segments donut), scoped to one real calendar month
// instead of all time. Chidera, 2026-09-16: "i didnt meant recent text by
// month, i meant even revenue, retention, customers, should also be able
// to be checked by month, customer overview and customer segment" -- the
// plain monthly table (/customers/monthly above) covered the table view;
// this is what lets Crm.jsx swap the stat cards/charts themselves to a
// specific month, reusing the exact same rendering code either way.
//
// segments here still classify each customer by their real, all-time
// segment (new/repeat/vip) -- there's no separate "this customer's segment
// as of last month" concept anywhere else in this codebase, and inventing
// one just for this view would answer a question nobody asked ("of the
// people who bought in September, how many are VIPs overall" is the useful
// question, not "were they a VIP specifically in September").
router.get('/customers/monthly-stats', requireFullAccessApi, async (req, res) => {
  const month = req.query.month; // 'YYYY-MM'
  if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ error: 'month must be YYYY-MM.' });
  const start = `${month}-01`;

  const [current, previous, segmentsByMonth, daily, upsell] = await Promise.all([
    pool.query(
      `with month_orders as (
         select customer_id, total, completed_at,
           row_number() over (partition by customer_id order by completed_at) as order_rank
         from "order" where status = 'completed' and completed_at is not null
       ),
       per_customer as (
         select customer_id, sum(total) as month_spend, min(order_rank) as first_rank
         from month_orders
         where completed_at >= $1::date and completed_at < ($1::date + interval '1 month')
         group by customer_id
       )
       select
         count(*)::int as total_customers,
         count(*) filter (where first_rank = 1)::int as new_count,
         count(*) filter (where first_rank > 1)::int as repeat_count,
         coalesce(sum(month_spend), 0) as total_revenue
       from per_customer`,
      [start]
    ),
    // Preceding calendar month -- what "vs last month" compares against
    // here, same idea as the cumulative route's trailing-30-days compare,
    // just calendar-aligned since a specific month is already the frame.
    pool.query(
      `with month_orders as (
         select customer_id, total, completed_at,
           row_number() over (partition by customer_id order by completed_at) as order_rank
         from "order" where status = 'completed' and completed_at is not null
       ),
       per_customer as (
         select customer_id, sum(total) as month_spend, min(order_rank) as first_rank
         from month_orders
         where completed_at >= ($1::date - interval '1 month') and completed_at < $1::date
         group by customer_id
       )
       select
         count(*) filter (where first_rank = 1)::int as new_count,
         coalesce(sum(month_spend), 0) as total_revenue
       from per_customer`,
      [start]
    ),
    pool.query(
      `with all_time as (
         select customer_id, count(*) as order_count, sum(total) as total_spend
         from "order" where status = 'completed' and completed_at is not null
         group by customer_id
       ),
       repeat_ranked as (
         select customer_id, percent_rank() over (order by total_spend) as spend_pct_rank
         from all_time where order_count >= 2
       ),
       segment as (
         select a.customer_id,
           case when a.order_count = 1 then 'new' when coalesce(r.spend_pct_rank, 0) >= 0.9 then 'vip' else 'repeat' end as name
         from all_time a left join repeat_ranked r on r.customer_id = a.customer_id
       ),
       month_customers as (
         select distinct customer_id from "order"
         where status = 'completed' and completed_at >= $1::date and completed_at < ($1::date + interval '1 month')
       )
       select seg.name, count(*)::int as n
       from month_customers mc join segment seg on seg.customer_id = mc.customer_id
       group by seg.name`,
      [start]
    ),
    pool.query(
      `select date(completed_at) as day,
         count(*) filter (where order_rank = 1)::int as new_customers,
         count(*) filter (where order_rank > 1)::int as repeat_customers
       from (
         select customer_id, completed_at, row_number() over (partition by customer_id order by completed_at) as order_rank
         from "order" where status = 'completed' and completed_at is not null
       ) o
       where completed_at >= $1::date and completed_at < ($1::date + interval '1 month')
       group by date(completed_at)
       order by day`,
      [start]
    ),
    computeUpsellStats(`and o.completed_at >= $1::date and o.completed_at < ($1::date + interval '1 month')`, [start]),
  ]);

  const c = current.rows[0];
  const p = previous.rows[0];
  const retentionRate = c.total_customers > 0 ? Math.round((c.repeat_count / c.total_customers) * 1000) / 10 : 0;
  const segMap = Object.fromEntries(segmentsByMonth.rows.map((r) => [r.name, r.n]));
  const pctChange = (curr, prev) => (prev > 0 ? Math.round(((curr - prev) / prev) * 1000) / 10 : null);

  res.json({
    totalCustomers: c.total_customers,
    repeatCustomers: c.repeat_count,
    retentionRate,
    totalRevenue: Number(c.total_revenue),
    segments: { new: segMap.new || 0, repeat: segMap.repeat || 0, vip: segMap.vip || 0 },
    deltas: {
      newCustomersPct: pctChange(c.new_count, p.new_count),
      revenuePct: pctChange(Number(c.total_revenue), Number(p.total_revenue)),
    },
    daily: daily.rows.map((r) => ({ day: r.day, newCustomers: r.new_customers, repeatCustomers: r.repeat_customers })),
    upsellOffered: upsell.upsellOffered,
    upsellAccepted: upsell.upsellAccepted,
    upsellSuccessRate: upsell.upsellSuccessRate,
  });
});

// Chidera, 2026-09-16: "let crm tab and customer tab seperate cause
// customer can reach 2000 and make crm tab too long, so let crm only be
// recent chat" -- CRM's own "Recent" tab (Crm.jsx), same 7-day window and
// shape as Feedback's own Recent tab, so it stays fast regardless of how
// large the full customer base (Customers.jsx's own /customers list) gets.
// "Recent" here means real order activity, not a literal message log --
// same definition the /customers/stats daily chart already uses.
router.get('/customers/recent', requireFullAccessApi, async (req, res) => {
  const { rows } = await pool.query(
    `select c.id, c.name, c.phone_number, c.birthday,
       o.order_count, o.total_spend, o.last_order_at,
       case when o.order_count = 1 then 'new' when coalesce(r.spend_pct_rank, 0) >= 0.9 then 'vip' else 'repeat' end as segment
     from customers c
     join (
       select customer_id, count(*) as order_count, sum(total) as total_spend, max(completed_at) as last_order_at
       from "order" where status = 'completed'
       group by customer_id
       having max(completed_at) > now() - interval '7 days'
     ) o on o.customer_id = c.id
     left join (
       select customer_id, percent_rank() over (order by total_spend) as spend_pct_rank
       from (
         select customer_id, sum(total) as total_spend
         from "order" where status = 'completed'
         group by customer_id having count(*) >= 2
       ) repeat_spend
     ) r on r.customer_id = c.id
     order by o.last_order_at desc`
  );
  res.json(rows);
});

// CRM's "By month" list -- one row per calendar month. new_customers counts
// each customer once, on the month of their first-ever completed order;
// repeat_customers counts a customer at most once per month even if they
// ordered more than once that month (order_rank > 1 marks every order
// after their first, ever).
//
// completed_at is not null found live, 2026-09-16: a real completed order
// with no completed_at set (a data gap, not something this route should
// paper over silently) grouped into a `month: null` row, which crashed the
// dashboard's own date formatting -- Chidera: "when i click by month on
// crm it goes blank." Filtered out here rather than letting one bad row
// take down the whole report; that order still exists and still counts
// everywhere completed_at isn't the grouping key.
router.get('/customers/monthly', requireFullAccessApi, async (req, res) => {
  const { rows } = await pool.query(
    `select to_char(date_trunc('month', completed_at), 'YYYY-MM') as month,
       count(*) filter (where order_rank = 1)::int as new_customers,
       count(distinct customer_id) filter (where order_rank > 1)::int as repeat_customers,
       coalesce(sum(total), 0) as revenue,
       count(*)::int as total_orders
     from (
       select customer_id, total, completed_at, row_number() over (partition by customer_id order by completed_at) as order_rank
       from "order" where status = 'completed' and completed_at is not null
     ) o
     group by date_trunc('month', completed_at)
     order by date_trunc('month', completed_at) desc`
  );
  res.json(rows);
});

// Best sellers -- which real menu items actually move, by units and by
// revenue, so a business can see what to push/restock rather than guess.
// month optional: omitted means all-time (cumulative), YYYY-MM scopes to
// one calendar month, same convention as /customers/monthly-stats.
router.get('/sales/top-products', requireFullAccessApi, async (req, res) => {
  const month = req.query.month;
  if (month && !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM.' });
  const dateFilter = month ? `and o.completed_at >= $1::date and o.completed_at < ($1::date + interval '1 month')` : '';
  const { rows } = await pool.query(
    `select p.name, p.category, sum(oi.quantity)::int as units_sold, coalesce(sum(oi.quantity * oi.price), 0) as revenue
     from order_item oi
     join product p on p.id = oi.product_id
     join "order" o on o.id = oi.order_id
     where o.status = 'completed' ${dateFilter}
     group by p.id, p.name, p.category
     order by units_sold desc
     limit 10`,
    month ? [`${month}-01`] : []
  );
  res.json(rows.map((r) => ({ name: r.name, category: r.category, unitsSold: r.units_sold, revenue: Number(r.revenue) })));
});

// Best-selling days -- aggregated by day of the WEEK (Monday..Sunday), not
// by calendar date, since "which specific date sold most" tells a business
// nothing repeatable to act on, but "Fridays and Saturdays are our busiest"
// tells them exactly when to staff up or run a promo. dow: Postgres's
// extract(dow) is 0=Sunday..6=Saturday; remapped below so the response is
// always Monday-first, the order a business actually thinks in.
router.get('/sales/by-day-of-week', requireFullAccessApi, async (req, res) => {
  const month = req.query.month;
  if (month && !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM.' });
  const dateFilter = month ? `and completed_at >= $1::date and completed_at < ($1::date + interval '1 month')` : '';
  const { rows } = await pool.query(
    `select extract(dow from completed_at)::int as dow, count(*)::int as order_count, coalesce(sum(total), 0) as revenue
     from "order"
     where status = 'completed' ${dateFilter}
     group by dow`,
    month ? [`${month}-01`] : []
  );
  const byDow = new Map(rows.map((r) => [r.dow, r]));
  const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const ordered = DAY_NAMES.map((name, i) => {
    const dow = (i + 1) % 7; // Monday=1 ... Saturday=6, Sunday=0
    const row = byDow.get(dow);
    return { day: name, orderCount: row?.order_count || 0, revenue: Number(row?.revenue || 0) };
  });
  res.json(ordered);
});

// Deliberately its own narrow route (one field), not folded into a
// general customer-edit endpoint that doesn't otherwise exist yet -- this
// is the popup on an order's own page asking for a missing birthday
// (Chidera: "can it be a pop up when taking orders...for customers that
// dont have"), not a broader profile editor.
router.post('/customers/:id/birthday', requireEditorApi, async (req, res) => {
  const { birthday } = req.body;
  const { rows } = await pool.query('update customers set birthday = $1 where id = $2 returning *', [birthday || null, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found.' });
  res.json(rows[0]);
});

// Chidera, 2026-09-16: "delete the chat even in back end" -- a real,
// permanent delete (not an archive/hide), for a customer who genuinely
// shouldn't have a record left (a test conversation, a privacy request),
// as distinct from cancelling one order (routes/api.js's /orders/:id/status
// already does that -- staff cancel the order first, then delete the
// customer here if the whole conversation should go too).
//
// requireEditorApi (owner/manager only, not PIN-tier) -- this is the one
// genuinely irreversible write on this whole customers surface, so it gets
// a narrower gate than birthday/export above.
//
// Most customer_id-referencing tables cascade through `order` already
// (order_item, order_payment_proof, order_topup, generated_document,
// order_feedback, delivery -- see schema.sql's own "on delete cascade" on
// each), but four tables reference an order/voice_call/table_session
// WITHOUT cascade (delivery_offer, delivery_assignment, callback_task,
// waiter_call) and would otherwise block the delete with a foreign key
// violation -- cleared explicitly, deepest-dependency-first, before the
// order/booking/voice_call/table_session rows they point to. This is the
// first explicit transaction in this codebase (everywhere else is plain
// sequential pool.query calls) -- deliberate here specifically because a
// partial delete across this many tables would be a real, hard-to-notice
// data integrity problem, not just a UX annoyance.
router.delete('/customers/:id', requireEditorApi, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = req.params.id;
    const { rows: existing } = await client.query('select id from customers where id = $1', [id]);
    if (!existing[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found.' });
    }
    // Chidera, 2026-09-20: three real FK bugs found from one real customer
    // ("i tried to delete the conversation... it didn't delete"), one at a
    // time as each fix exposed the next. Same root cause every time: a
    // dependent table has to be cleared before the row it points at can go,
    // and several tables here reference table_session/delivery_assignment/
    // customers with no cascade at all.
    //   1) table_session used to be deleted BEFORE "order", but
    //      order.session_id/table_id reference table_session/
    //      restaurant_table with no cascade -- any customer with even one
    //      dine-in order hit this instantly. order now goes first;
    //      table_session (nothing left pointing at it once order is gone)
    //      moved after.
    //   2) rider_payout.assignment_id references delivery_assignment with
    //      no cascade, and this route never touched rider_payout at all.
    //   3) the retired `feedback` table (dine-in's pre-2026-09-11 rating
    //      system, replaced by order_feedback but never dropped since its
    //      existing rows are real history) references table_session AND
    //      customers directly, neither with a cascade -- only matters for
    //      a customer with old dine-in history, exactly this one.
    await client.query(`delete from feedback where customer_id = $1`, [id]);
    await client.query(`delete from waiter_call where session_id in (select id from table_session where customer_id = $1)`, [id]);
    await client.query(`delete from callback_task where customer_id = $1 or call_id in (select id from voice_call where customer_id = $1)`, [id]);
    await client.query(`delete from call_turn where call_id in (select id from voice_call where customer_id = $1)`, [id]);
    await client.query(`delete from voice_call where customer_id = $1`, [id]);
    await client.query(`delete from rider_payout where assignment_id in (select id from delivery_assignment where order_id in (select id from "order" where customer_id = $1))`, [id]);
    await client.query(`delete from delivery_assignment where order_id in (select id from "order" where customer_id = $1)`, [id]);
    await client.query(`delete from delivery_offer where order_id in (select id from "order" where customer_id = $1)`, [id]);
    await client.query(`delete from booking where customer_id = $1`, [id]);
    await client.query(`delete from "order" where customer_id = $1`, [id]);
    await client.query(`delete from table_session where customer_id = $1`, [id]);
    await client.query(`delete from message where customer_id = $1`, [id]);
    await client.query(`delete from customers where id = $1`, [id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// "Able to extract their data" -- a real CSV a business owner can open in
// Excel/Sheets, not the full JSON /export dump above (built for a data
// migration/backup, not for a person to actually read).
router.get('/customers/export', requireFullAccessApi, async (req, res) => {
  const { rows } = await pool.query(
    `select c.name, c.phone_number, c.birthday,
       coalesce(o.order_count, 0)::int as order_count,
       coalesce(o.total_spend, 0) as total_spend,
       case when coalesce(o.order_count, 0) > 0 then round(o.total_spend / o.order_count, 2) else 0 end as average_spend
     from customers c
     left join (
       select customer_id, count(*) as order_count, sum(total) as total_spend
       from "order" where status = 'completed'
       group by customer_id
     ) o on o.customer_id = c.id
     order by o.total_spend desc nulls last, c.created_at desc`
  );
  const esc = (v) => (v === null || v === undefined ? '' : `"${String(v).replace(/"/g, '""')}"`);
  const header = 'Name,Phone number,Birthday,Orders,Total spend,Average spend\n';
  const body = rows
    .map((r) => [r.name, r.phone_number, r.birthday, r.order_count, r.total_spend, r.average_spend].map(esc).join(','))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="customers.csv"');
  res.send(header + body);
});

// POS sync add-on's own data (see pos-sync-config above) -- every row
// engine/webhook-moniepoint.js has stored from a client's real Moniepoint
// terminal, newest first. Not joined to customers: Moniepoint's docs never
// confirmed a transaction carries customer identity, only amount/reference.
router.get('/pos-transactions', requireFullAccessApi, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const { rows } = await pool.query(
    `select id, provider, provider_reference, amount, occurred_at from pos_transaction
     order by occurred_at desc limit $1`,
    [limit]
  );
  res.json(rows);
});

router.get('/pos-transactions/stats', requireFullAccessApi, async (req, res) => {
  const { rows } = await pool.query(`
    select
      coalesce(sum(amount), 0) as "totalRevenue",
      count(*)::int as "totalTransactions",
      coalesce(sum(amount) filter (where occurred_at >= date_trunc('day', now())), 0) as "todayRevenue",
      count(*) filter (where occurred_at >= date_trunc('day', now()))::int as "todayTransactions"
    from pos_transaction
  `);
  res.json(rows[0]);
});

// Staff reaching a phone number with no existing thread yet -- just opens
// (or creates) the conversation. No message sent here: the normal reply box
// on that conversation (POST /conversations/:id/send, via
// engine/flow.js's sendStaffReply) sends it, falling back to the approved
// business_outreach template automatically if the plain send is rejected
// for being outside the 24h window. One send path, not a separate
// "message a customer first" flow (Chidera's call, 2026-09-02).
router.post('/conversations/start', async (req, res) => {
  const phone = (req.body?.phone_number || '').trim();
  if (!phone) return res.status(400).json({ error: 'A phone number is required.' });
  const customer = await startConversation({ phoneNumber: phone, branchId: req.branchId });
  res.json({ conversation_id: customer.id });
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

router.post('/knowledge-base', requireStaffApi, async (req, res) => {
  const { rows } = await pool.query('insert into knowledge_base (question, answer) values ($1, $2) returning *', [req.body.question, req.body.answer]);
  res.status(201).json(rows[0]);
});

router.post('/knowledge-base/:id', requireStaffApi, async (req, res) => {
  const { rows } = await pool.query(
    'update knowledge_base set question = $1, answer = $2 where id = $3 returning *',
    [req.body.question, req.body.answer, req.params.id]
  );
  res.json(rows[0]);
});

router.delete('/knowledge-base/:id', requireStaffApi, async (req, res) => {
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
    `select s.id, s.name, s.phone_number, s.email, s.role, s.status, s.handover_alerts, s.order_alerts, s.created_at, s.branch_id, s.auth_type, s.work_area, b.name as branch_name
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
  // A branch-locked manager can create staff for their own branch (the PIN
  // form below), but never another manager or owner account -- that's the
  // general manager's (or owner's) call, not a single branch's own.
  // Chidera's own words, 2026-09-03: "branch manager cant create a new
  // manager or owner but general manager when there are multiple branches
  // can create branch managers." req.branchId is null exactly for an
  // owner or an unlocked ("general") manager, so that's the same signal
  // every other branch-lock check in this file already uses.
  if (req.branchId) {
    return res.status(403).json({ error: 'Only the general manager or owner can create a manager or owner account.' });
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

// Chidera, 2026-09-22: "on roles and number i need to be able to... edit
// incase a change of number or email" -- disabling never actually let a
// business correct a typo or move a login to whoever now has that number,
// only hide the old row. Name/phone/email only -- role, branch and
// auth_type each already have their own dedicated, more carefully-guarded
// endpoint (branch reassignment is owner-only, role changes never existed
// at all) and don't belong bundled into a plain edit. Same branch-lock +
// "never touch an owner" guard as /status above.
router.post('/staff/:id/edit', requireEditorApi, async (req, res) => {
  const { rows: target } = await pool.query('select id, role, branch_id, auth_type from staff where id = $1', [req.params.id]);
  if (!target[0]) return res.status(404).json({ error: 'Staff member not found.' });
  if (req.branchId && (target[0].role === 'owner' || target[0].branch_id !== req.branchId)) {
    return res.status(403).json({ error: 'You can only manage staff in your own branch.' });
  }
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const phoneNumber = req.body.phone_number ? String(req.body.phone_number).trim() : null;
  // PIN-tier staff have no email at all (see schema.sql's own comment on
  // staff.email) -- only ever touch it for a password-login account, same
  // as POST /staff never sets one for a PIN row.
  const email = target[0].auth_type === 'pin' ? null : String(req.body.email || '').trim().toLowerCase() || null;
  if (target[0].auth_type !== 'pin' && !email) return res.status(400).json({ error: 'Email is required.' });
  try {
    const { rows } = await pool.query(
      'update staff set name = $1, phone_number = $2, email = $3 where id = $4 returning id, name, phone_number, email',
      [name, phoneNumber, email, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Another staff member already uses that email.' });
    throw err;
  }
});

// Real removal, not just hiding the row -- Chidera, 2026-09-22: "i need to
// be able to delete not just disable." A staff member who ever actually
// did anything (took an order, handled a handover, appears in the
// activity log) is referenced by foreign key from that history, and this
// deliberately does NOT cascade through years of real order/activity
// records just to free up one row -- the 409 below is the signal to
// disable instead, same as this file's other "can't just silently do the
// wrong thing" guards. A staff member with no history at all (added by
// mistake, or a PIN account nobody ever used) deletes cleanly.
router.delete('/staff/:id', requireEditorApi, async (req, res) => {
  const { rows: target } = await pool.query('select id, role, branch_id from staff where id = $1', [req.params.id]);
  if (!target[0]) return res.status(404).json({ error: 'Staff member not found.' });
  if (req.branchId && (target[0].role === 'owner' || target[0].branch_id !== req.branchId)) {
    return res.status(403).json({ error: 'You can only manage staff in your own branch.' });
  }
  try {
    await pool.query('delete from staff where id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({ error: 'This staff member has order/activity history and can’t be deleted -- disable them instead.' });
    }
    throw err;
  }
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

// Separate from handover-alerts above -- Chidera, 2026-09-16: "a staff
// number should be able to get a confirmed order after paystack has
// automatically confirmed payment on their whatsapp." Same phone-number
// requirement and branch scoping as handover-alerts, for the same reasons.
router.post('/staff/:id/order-alerts', requireEditorApi, async (req, res) => {
  const { rows: existing } = await pool.query('select phone_number, branch_id from staff where id = $1', [req.params.id]);
  if (!existing[0]) return res.status(404).json({ error: 'Staff member not found.' });
  if (req.branchId && existing[0].branch_id !== req.branchId) {
    return res.status(403).json({ error: 'You can only manage staff in your own branch.' });
  }
  if (req.body.order_alerts && !existing[0].phone_number) {
    return res.status(400).json({ error: 'Add a phone number for this staff member first.' });
  }
  const { rows } = await pool.query('update staff set order_alerts = $1 where id = $2 returning id, order_alerts', [
    !!req.body.order_alerts,
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
  const { name, pin, work_area } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
  if (!/^\d{4}$/.test(pin || '')) return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });
  if (work_area && !['online', 'in_house'].includes(work_area)) return res.status(400).json({ error: 'Invalid work area.' });
  const pinHash = await hashPin(pin);
  const { rows } = await pool.query(
    `insert into staff (name, role, branch_id, auth_type, pin_hash, created_by_staff_id, work_area)
     values ($1, 'staff', $2, 'pin', $3, $4, $5)
     returning id, name, role, status, branch_id, auth_type, work_area`,
    [name.trim(), req.branchId, pinHash, req.staff.id, work_area || null]
  );
  await logActivity(req, 'staff_pin_created', { entityType: 'staff', entityId: rows[0].id, detail: { name: rows[0].name, work_area: rows[0].work_area } });
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

// "Receipt" means the real payment-proof photo a customer sent, not a
// system-generated document -- Chidera 2026-09-11: "receipts on dashboard
// are the actual payment proofs that the customers send that they confirm
// not ai generated pdf." generated_document (and engine/documents.js's
// createReceipt, which used to populate it) is gone entirely now -- see
// that commit's message for why it existed and why nothing reads it
// anymore.
router.get('/documents', async (req, res) => {
  const { rows } = await pool.query(
    `select p.id, p.data_url, p.created_at, o.id as order_id, o.reference, c.name as customer_name, c.phone_number as customer_phone
     from order_payment_proof p
     join "order" o on o.id = p.order_id
     join customers c on c.id = o.customer_id
     order by p.created_at desc limit 200`
  );
  res.json(rows);
});

// --- Settings (the single business row) --------------------------------

router.get('/business', requireFullAccessApi, async (req, res) => {
  const { rows } = await pool.query(
    'select id, name, type, phone_number, address, operating_hours, delivery_enabled, whatsapp_connection, handover_number, bank_name, bank_account_number, bank_account_name, logo_data_url, brand_color, cover_photo_data_url from business limit 1'
  );
  res.json(rows[0] || null);
});

// Opening hours -- stored on the primary branch's own opening_hours column
// (engine/hours.js checks it on every inbound message), not a new business-
// level column. For the common single-branch business this is
// indistinguishable from "the business's hours"; a multi-branch business
// wanting different hours per location sets them from Branches instead --
// not built here, since nobody's asked for it yet (see hours.js's own
// comment on not building ahead of a real need).
router.get('/business-hours', requireFullAccessApi, async (req, res) => {
  const { rows } = await pool.query(`select opening_hours from branch where is_primary = true limit 1`);
  res.json({ opening_hours: rows[0]?.opening_hours || null });
});

router.post('/business-hours', requireEditorApi, async (req, res) => {
  const { open, close } = req.body;
  // Either both set (a real {open, close} pair) or both cleared (back to
  // "always open", the same "not configured" state a business starts in).
  const openingHours = open && close ? { open, close } : null;
  const { rows } = await pool.query(
    `update branch set opening_hours = $1 where is_primary = true returning opening_hours`,
    [openingHours ? JSON.stringify(openingHours) : null]
  );
  res.json({ opening_hours: rows[0]?.opening_hours || null });
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
       logo_data_url = $10, brand_color = $11, cover_photo_data_url = $12
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
      f.cover_photo_data_url || null,
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
