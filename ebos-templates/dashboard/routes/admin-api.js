// Called only by the ERA Dash OS panel, authenticated with a shared bearer
// token (EBOS_ADMIN_TOKEN) generated once when this EBOS deployment was
// provisioned -- see create-client.mjs. This is the "onboard a business"
// door: creating a business here is a plain DB write, not an infra job, so
// it completes in one request, no job-log polling needed.
import express from 'express';
import { pool } from '../lib/db.js';
import { hashPassword } from '../lib/auth.js';
import { randomPassword } from '../lib/random.js';

export const router = express.Router();

router.use((req, res, next) => {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!process.env.EBOS_ADMIN_TOKEN || token !== process.env.EBOS_ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

const BUSINESS_TYPES = ['restaurant', 'apartment', 'car_rental', 'lashes_nails'];

router.get('/businesses', async (req, res) => {
  const { rows } = await pool.query(
    `select b.id, b.name, b.type, b.created_at, s.email as owner_email
     from business b
     left join staff s on s.business_id = b.id and s.role = 'owner'
     order by b.created_at desc`
  );
  res.json(rows);
});

router.post('/businesses', async (req, res) => {
  const { name, type, address, phoneNumber, ownerName, ownerEmail } = req.body;
  if (!name || !type || !ownerName || !ownerEmail) {
    return res.status(400).json({ error: 'name, type, ownerName and ownerEmail are required' });
  }
  if (!BUSINESS_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${BUSINESS_TYPES.join(', ')}` });
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows: businessRows } = await client.query(
      `insert into business (name, type, address, phone_number) values ($1, $2, $3, $4) returning *`,
      [name, type, address || null, phoneNumber || null]
    );
    const business = businessRows[0];

    const password = randomPassword();
    const passwordHash = await hashPassword(password);
    await client.query(
      `insert into staff (business_id, name, email, password_hash, role) values ($1, $2, $3, $4, 'owner')`,
      [business.id, ownerName, ownerEmail.trim().toLowerCase(), passwordHash]
    );

    await client.query('commit');
    res.status(201).json({
      business: { id: business.id, name: business.name, type: business.type },
      ownerLogin: { email: ownerEmail.trim().toLowerCase(), password },
    });
  } catch (err) {
    await client.query('rollback');
    if (err.code === '23505') return res.status(409).json({ error: 'That owner email is already in use on this EBOS deployment.' });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
