// The customer-facing rating form (engine/feedback-form-template.js) --
// public, no login, same trust boundary as routes/tracking.js and
// routes/documents.js. order_feedback.id doubles as this link's own token
// (a real gen_random_uuid, unguessable enough, same "the row's own id is
// the token" shortcut menu_token/qr_token use their own separate columns
// for -- no separate token column needed here since nothing about this
// link is ever regenerated the way a QR code's token is).
import express from 'express';
import { pool } from '../lib/db.js';
import { renderFeedbackFormPage } from '../engine/feedback-form-template.js';

export const router = express.Router();

router.get('/:id', async (req, res) => {
  const { rows } = await pool.query(
    `select f.status, o.reference, biz.name as business_name
     from order_feedback f
     join "order" o on o.id = f.order_id
     cross join (select name from business limit 1) biz
     where f.id = $1`,
    [req.params.id]
  );
  const fb = rows[0];
  if (!fb) return res.status(404).send('Not found.');
  res.set('Content-Type', 'text/html').send(
    renderFeedbackFormPage({
      businessName: fb.business_name || '',
      reference: fb.reference,
      submitted: fb.status === 'answered',
      submitPath: `/f/${req.params.id}/submit`,
    })
  );
});

function validRating(n) {
  return Number.isInteger(n) && n >= 1 && n <= 5;
}

router.post('/:id/submit', async (req, res) => {
  const { experience, food, service, comment } = req.body || {};
  if (!validRating(experience) || !validRating(food) || !validRating(service)) {
    return res.status(400).json({ error: 'Please rate all three from 1 to 5.' });
  }
  const { rows } = await pool.query(
    `update order_feedback set experience_rating = $1, food_rating = $2, service_rating = $3, comment = $4,
       status = 'answered', answered_at = now()
     where id = $5 and status != 'answered' returning id`,
    [experience, food, service, (comment || '').trim() || null, req.params.id]
  );
  if (!rows.length) return res.status(409).json({ error: 'This has already been submitted.' });
  res.json({ ok: true });
});
