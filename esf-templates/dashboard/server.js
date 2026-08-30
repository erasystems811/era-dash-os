// Patches every router's async handlers to actually forward errors to
// Express's error handling -- must be imported before any route is
// defined. Same fix EBOS carries (see ebos-templates/dashboard/server.js's
// own comment for the incident that made this non-optional).
import 'express-async-errors';
import express from 'express';
import cookieSession from 'cookie-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './lib/db.js';
import { findOwnerByEmail, verifyPassword, loadOwner, requireOwner } from './lib/auth.js';
import { router as whatsappWebhook } from './engine/webhook-whatsapp.js';
import { router as staffRoutes } from './routes/staff.js';
import { router as taskRoutes } from './routes/tasks.js';
import { router as alertRoutes } from './routes/alerts.js';
import { router as formRoutes } from './routes/form.js';
import { startScheduler } from './engine/scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.join(__dirname, 'client', 'dist');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Public webhook -- Meta calls this directly, no session. Mounted after the
// body parsers (WhatsApp's webhook signature check, unlike Paystack's, does
// not need the raw body -- see EBOS's own server.js for the one case that
// does).
app.use('/webhook/whatsapp', whatsappWebhook);

app.use(
  cookieSession({
    name: 'esf_session',
    secret: process.env.SESSION_SECRET,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
  })
);
app.use(loadOwner);

app.get('/healthz', (req, res) => res.json({ ok: true }));

const api = express.Router();

api.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const owner = email && (await findOwnerByEmail(email));
  if (!owner || !(await verifyPassword(owner, password || ''))) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  req.session.owner = { id: owner.id, email: owner.email, role: owner.role, can_override: owner.can_override };
  res.json({ owner: req.session.owner });
});

api.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

api.get('/me', (req, res) => {
  res.json({ owner: req.owner || null });
});

api.get('/business', requireOwner, async (req, res) => {
  const { rows } = await pool.query(`select name from business limit 1`);
  res.json(rows[0] || null);
});

api.get('/today', requireOwner, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `select run.status, run.current_seq, task.name as task_name, staff.name as staff_name
     from run
     join task on task.id = run.task_id
     join staff on staff.id = run.staff_id
     where run.run_date = $1
     order by task.seq, staff.name`,
    [today]
  );
  res.json(rows);
});

api.use('/staff', staffRoutes);
api.use('/tasks', taskRoutes);
api.use('/alert-routes', alertRoutes);
app.use('/api', api);

// Public, no-login form-mode fill-out page (build schema v2.0 section 6) --
// scoped by run.form_token, not owner_user auth. Mounted before the SPA
// static/fallback block below, or the React app's catch-all route would
// intercept it first.
app.use('/form', formRoutes);

// The React dashboard (client/) -- built at image-build time (see
// Dockerfile), served as static files with an SPA fallback so client-side
// routes (e.g. /tasks/:id) work on a hard refresh. No React client yet
// until build order stage 9 is complete would have said "starter" here --
// this is the real thing now, matching ebos-templates/dashboard/client/'s
// pattern exactly.
app.use(express.static(CLIENT_DIST));
app.get('*', (req, res) => {
  res.sendFile(path.join(CLIENT_DIST, 'index.html'));
});

// Last resort -- every route that can reasonably fail should already handle
// its own errors. This exists so an unexpected one still gets a real
// response instead of silently hanging or crashing the whole process.
app.use((err, req, res, next) => {
  console.error('Unhandled route error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`ESF dashboard listening on ${port}`);
  startScheduler();
});
