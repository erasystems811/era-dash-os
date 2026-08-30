// alert_route CRUD -- JSON API for client/src/pages/AlertRoutes.jsx. Where
// each kind of alert goes (build schema v2.0 section 3.9/section 8) --
// without this screen, alert_route only had a raw SQL insert as its
// interface, which defeats the whole "no code per client" premise for the
// one thing every business needs configured on day one (who gets told when
// something's wrong).
import express from 'express';
import { pool } from '../lib/db.js';
import { requireOwner } from '../lib/auth.js';

export const router = express.Router();
router.use(requireOwner);

const EVENTS = ['problem', 'blocked', 'missing', 'late', 'variance', 'daily_summary'];
const CHANNELS = ['whatsapp', 'email', 'dashboard'];

router.get('/', async (req, res) => {
  const { rows } = await pool.query(`select * from alert_route order by event`);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { event, channel, target, quiet_hours } = req.body;
  if (!EVENTS.includes(event)) return res.status(400).json({ error: `Event must be one of: ${EVENTS.join(', ')}` });
  if (!CHANNELS.includes(channel)) return res.status(400).json({ error: `Channel must be one of: ${CHANNELS.join(', ')}` });
  if (!target?.trim()) return res.status(400).json({ error: 'A target (phone or email) is required.' });
  const { rows } = await pool.query(
    `insert into alert_route (event, channel, target, quiet_hours) values ($1, $2, $3, $4) returning id`,
    [event, channel, target.trim(), quiet_hours?.trim() || null]
  );
  res.json({ id: rows[0].id });
});

router.delete('/:id', async (req, res) => {
  await pool.query(`delete from alert_route where id = $1`, [req.params.id]);
  res.json({ ok: true });
});
