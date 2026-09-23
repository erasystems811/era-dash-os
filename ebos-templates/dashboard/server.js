// Express 4's async route handlers don't forward a rejected promise to
// Express's error handling on their own -- an uncaught rejection there
// (a slow/down dependency like Gotenberg, a bad query, anything) crashes
// the whole Node process by default (Node 15+), taking the dashboard down
// for the entire business over one bad request, not just failing that one
// request. Found live: a single Gotenberg timeout in routes/documents.js
// killed the container. Patches every router's async handlers to actually
// forward errors -- must be imported before any route is defined.
import 'express-async-errors';
import express from 'express';
import cookieSession from 'cookie-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStaff } from './lib/auth.js';
import { router as apiRoutes } from './routes/api.js';
import { router as documentRoutes } from './routes/documents.js';
import { router as trackingRoutes } from './routes/tracking.js';
import { router as dineinMenuRoutes } from './routes/dinein-menu.js';
import { router as menuPageRoutes } from './routes/menu-page.js';
import { router as feedbackFormRoutes } from './routes/feedback-form.js';
import { router as productPhotoRoutes } from './routes/product-photo.js';
import { router as riderApiRoutes } from './routes/rider.js';
import { router as whatsappWebhook } from './engine/webhook-whatsapp.js';
import { router as instagramWebhook } from './engine/webhook-instagram.js';
import { router as paystackWebhook } from './engine/webhook-paystack.js';
import { router as moniepointWebhook } from './engine/webhook-moniepoint.js';
import { router as monnifyWebhook } from './engine/webhook-monnify.js';
import { recoverPendingMessages, closeStaleOrders, sweepOpeningNotifications } from './engine/flow.js';
import { sweepOfferEscalation } from './engine/delivery-dispatch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.join(__dirname, 'client', 'dist');
const RIDER_PWA_DIST = path.join(__dirname, 'rider-pwa', 'dist');

const app = express();

// Paystack's webhook needs the raw, unparsed body to verify its HMAC
// signature (engine/payment.js's verifyPaystackSignature), so it's mounted
// before the global express.json() below and parses its own body with
// express.raw() -- everything else gets normal parsed JSON/form bodies.
app.use('/webhook/paystack', paystackWebhook);
// Chidera, 2026-09-20: same reasoning as Paystack above -- Moniepoint's
// real webhook subscription (created through their own Settings UI, not
// the API-key system) signs each delivery with HMAC-SHA256 over the raw
// body (moniepoint-webhook-signature header), so this needs to move above
// the global JSON parser too, same as Paystack's. Was below it, parsed by
// express.json(), back when this route only checked Basic auth -- moved
// once the real mechanism was confirmed.
app.use('/webhook/moniepoint', moniepointWebhook);
// Chidera, 2026-09-23: same reasoning as Paystack/Moniepoint above --
// Monnify signs each webhook with HMAC-SHA512 over the raw body
// (monnify-signature header), so this needs the raw body too.
app.use('/webhook/monnify', monnifyWebhook);

// Express's own default JSON body limit is 100kb -- far too small for any
// of the data: URI image uploads this app already does (business logo,
// cover photo, product photos in Catalogue.jsx), which arrive as regular
// JSON bodies through this same middleware. A phone photo easily runs a
// few MB before base64 even adds its ~33% overhead. Found live,
// 2026-09-10: a cover photo upload was silently rejected (413) and just
// never saved, with nothing in the UI to explain why.
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: false, limit: '20mb' }));

// Public webhooks -- Meta and Paystack call these directly, no session.
app.use('/webhook/whatsapp', whatsappWebhook);
app.use('/webhook/instagram', instagramWebhook);
// Public documents -- the invoice/receipt link sent to a customer over
// WhatsApp has to open without a dashboard login.
app.use('/documents', documentRoutes);
// Public delivery tracking (own_riders mode) -- same reasoning as
// /documents above, and the tracking_url stored on `delivery` (see
// routes/rider.js's /offers/:id/accept) already points here.
app.use('/track', trackingRoutes);
// Public dine-in menu page (EBOS-Addon-Schema-Dine-In.md section 4) -- a
// guest opens this from a WhatsApp button, never logged in.
app.use('/t', dineinMenuRoutes);
// Public web menu page for regular (non-dine-in) ordering -- same page,
// resolved by a per-customer token instead of a table.
app.use('/m', menuPageRoutes);
// The rating form sent by engine/flow.js's sendFeedbackRequest -- public,
// no login, order_feedback.id itself is the link's token.
app.use('/f', feedbackFormRoutes);
// A product's photo, served as a real image response instead of the raw
// data: URI -- see routes/product-photo.js for why.
app.use('/photo', productPhotoRoutes);

// Scoped to /api, not global -- the rider session below needs its own,
// completely separate cookie-session instance on its own path (/rider), and
// two cookie-session middlewares both touching req.session on overlapping
// paths would each try to persist whichever session was assigned last back
// into their own cookie, silently cross-writing rider data into the staff
// cookie or vice versa. Scoping each to its own path prefix means they
// never run on the same request at all.
app.use(
  '/api',
  cookieSession({
    name: 'ebos_session',
    secret: process.env.SESSION_SECRET,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
  }),
  loadStaff,
  apiRoutes
);

app.get('/healthz', (req, res) => res.json({ ok: true }));

// The rider PWA (rider-pwa/) -- own session, own static bundle, own SPA
// fallback, all under /rider so none of it ever shares a request with the
// staff dashboard's own session/routes above. Delivery add-on only
// (own_riders mode) -- with mode='none' these files still exist (built into
// every image, per the addon spec's "code present and inert, not absent"
// rule) but are simply never linked to from the staff dashboard's nav.
app.use(
  '/rider/api',
  cookieSession({
    name: 'ebos_rider_session',
    secret: process.env.SESSION_SECRET,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
  }),
  riderApiRoutes
);
app.use('/rider', express.static(RIDER_PWA_DIST));
app.get('/rider/*', (req, res) => {
  res.sendFile(path.join(RIDER_PWA_DIST, 'index.html'));
});

// The React dashboard (client/) -- built at image-build time (see
// Dockerfile), served as static files with an SPA fallback so client-side
// routes (e.g. /orders/:id) work on a hard refresh.
app.use(express.static(CLIENT_DIST));
app.get('*', (req, res) => {
  res.sendFile(path.join(CLIENT_DIST, 'index.html'));
});

// Last resort, not the normal path -- every route that can reasonably fail
// should already handle its own errors. This exists so an unexpected one
// still gets a real response instead of silently hanging or (pre
// express-async-errors above) crashing the whole process.
app.use((err, req, res, next) => {
  console.error('Unhandled route error:', err);
  if (res.headersSent) return next(err);
  // Client-side compression (imageUpload.js) is the real fix for this --
  // this is just defense in depth so a payload that somehow still gets
  // through too large fails with a message that actually explains why,
  // instead of the generic one below. Found live, 2026-09-10: a raw,
  // uncompressed cover photo upload failed as an opaque 500, which looked
  // exactly like the upload had silently done nothing at all.
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That file is too large. Please try a smaller photo.' });
  }
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// Backstop for anything outside a request/response cycle (background work
// like flow.js's debounced processing already catches its own errors, but
// this covers whatever doesn't) -- log and keep running instead of taking
// the whole business's bot down over one unexpected failure.
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

const port = process.env.PORT || 3000;

// EBOS_TEST_PGLITE's database is in-process and per-process -- a separate
// seed script can't reach it, so seeding has to happen in this same
// process on startup. Never runs against a real deployment.
if (process.env.EBOS_TEST_PGLITE === '1') {
  const { seedSampleRestaurant } = await import('./sandbox/seed-sample-restaurant.mjs');
  await seedSampleRestaurant();
  console.log('Seeded sample restaurant for local testing.');
}

app.listen(port, () => {
  console.log(`EBOS dashboard listening on ${port}`);
  recoverPendingMessages().catch((err) => console.error('Startup recovery failed:', err));
  // Checked hourly, not on every message -- a 24h threshold doesn't need
  // tighter polling than that. Runs once immediately too, so a long-running
  // server doesn't wait a full hour after startup before the first sweep.
  closeStaleOrders().catch((err) => console.error('closeStaleOrders failed:', err));
  setInterval(() => {
    closeStaleOrders().catch((err) => console.error('closeStaleOrders failed:', err));
  }, 60 * 60 * 1000);
  // Delivery add-on (own_riders mode) escalation sweep -- spec B4's 90s/
  // 180s timeouts need a much shorter tick than closeStaleOrders' hourly
  // one to mean anything. sweepOfferEscalation itself is a single cheap
  // row read and returns immediately when mode != 'own_riders' (same
  // "scheduled but genuinely inert until switched on" shape as
  // closeStaleOrders already is for every business regardless of any
  // toggle -- this has to run unconditionally so a business that flips the
  // toggle on mid-uptime is covered without a redeploy).
  setInterval(() => {
    sweepOfferEscalation().catch((err) => console.error('sweepOfferEscalation failed:', err));
  }, 15_000);
  // "Let them know immediately they open" (Chidera, 2026-09-16) -- a minute
  // is frequent enough that nobody notices the delay, and the sweep itself
  // is a no-op read whenever no branch has both opening_hours set and a
  // customer actually waiting, which is most minutes for most businesses.
  setInterval(() => {
    sweepOpeningNotifications().catch((err) => console.error('sweepOpeningNotifications failed:', err));
  }, 60_000);
});
