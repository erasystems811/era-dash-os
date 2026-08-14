import express from 'express';
import cookieSession from 'cookie-session';
import { loadStaff } from './lib/auth.js';
import { router as dashboardRoutes } from './routes/dashboard.js';
import { router as adminApiRoutes } from './routes/admin-api.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Token-authenticated, no staff session -- must come before the session
// middleware below since it's a machine-to-machine door (the panel), not a
// browser login.
app.use('/admin/api', adminApiRoutes);

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
app.use('/', dashboardRoutes);

app.get('/healthz', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`EBOS dashboard listening on ${port}`));
