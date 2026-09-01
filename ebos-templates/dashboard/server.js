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
import { router as whatsappWebhook } from './engine/webhook-whatsapp.js';
import { router as instagramWebhook } from './engine/webhook-instagram.js';
import { router as paystackWebhook } from './engine/webhook-paystack.js';
import { recoverPendingMessages, closeStaleOrders } from './engine/flow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.join(__dirname, 'client', 'dist');

const app = express();

// Paystack's webhook needs the raw, unparsed body to verify its HMAC
// signature (engine/payment.js's verifyPaystackSignature), so it's mounted
// before the global express.json() below and parses its own body with
// express.raw() -- everything else gets normal parsed JSON/form bodies.
app.use('/webhook/paystack', paystackWebhook);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Public webhooks -- Meta and Paystack call these directly, no session.
app.use('/webhook/whatsapp', whatsappWebhook);
app.use('/webhook/instagram', instagramWebhook);
// Public documents -- the invoice/receipt link sent to a customer over
// WhatsApp has to open without a dashboard login.
app.use('/documents', documentRoutes);

app.use(
  cookieSession({
    name: 'ebos_session',
    secret: process.env.SESSION_SECRET,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
  })
);
app.use(loadStaff);
app.use('/api', apiRoutes);

app.get('/healthz', (req, res) => res.json({ ok: true }));

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
});
