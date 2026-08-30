// Staff CRUD -- JSON API consumed by client/src/pages/Staff.jsx. The
// roster a task's "assign to" picker (routes/tasks.js) also reads from.
// Staff never log in here (build schema v2.0 section 3.2's own rule) --
// this is the owner managing who's on the roster, not a staff-facing
// screen.
import express from 'express';
import { pool } from '../lib/db.js';
import { requireOwner } from '../lib/auth.js';

export const router = express.Router();
router.use(requireOwner);

router.get('/', async (req, res) => {
  const { rows } = await pool.query(`select id, name, phone, role, shift_start, shift_end, active from staff order by active desc, name`);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { name, phone, role, shift_start, shift_end } = req.body;
  if (!name || !phone || !role) return res.status(400).json({ error: 'Name, phone, and role are all required.' });
  try {
    const { rows } = await pool.query(
      `insert into staff (name, phone, role, shift_start, shift_end) values ($1, $2, $3, $4, $5) returning id`,
      [name.trim(), phone.trim(), role.trim(), shift_start || null, shift_end || null]
    );
    res.json({ id: rows[0].id });
  } catch (err) {
    // unique_violation on phone -- the one thing this table enforces (build
    // schema v2.0 section 3.2).
    if (err.code === '23505') return res.status(400).json({ error: 'That phone number is already registered to a staff member.' });
    throw err;
  }
});

router.post('/:id/toggle-active', async (req, res) => {
  await pool.query(`update staff set active = not active where id = $1`, [req.params.id]);
  res.json({ ok: true });
});
