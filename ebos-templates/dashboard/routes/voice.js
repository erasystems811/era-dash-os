// Voice ordering add-on -- the callback queue's own staff actions. Mounted
// under /api/voice in routes/api.js, after requireStaffApi/scopeToBranch,
// same as routes/delivery.js.
import express from 'express';
import { pool } from '../lib/db.js';
import { requireEditorApi } from '../lib/auth.js';

export const router = express.Router();

// --- Calls ------------------------------------------------------------

router.get('/calls', async (req, res) => {
  const { rows } = await pool.query(
    `select vc.id, vc.caller_number, vc.direction, vc.started_at, vc.answered_at, vc.ended_at,
            vc.duration_seconds, vc.outcome, vc.transport, vc.order_id, vc.cost_estimate,
            c.name as customer_name, o.reference as order_reference
     from voice_call vc
     left join customers c on c.id = vc.customer_id
     left join "order" o on o.id = vc.order_id
     where ($1::uuid is null or vc.branch_id = $1)
     order by vc.started_at desc
     limit 100`,
    [req.branchId]
  );
  res.json(rows);
});

router.get('/calls/:id', async (req, res) => {
  const { rows: callRows } = await pool.query(
    `select vc.*, c.name as customer_name, o.reference as order_reference
     from voice_call vc
     left join customers c on c.id = vc.customer_id
     left join "order" o on o.id = vc.order_id
     where vc.id = $1 and ($2::uuid is null or vc.branch_id = $2)`,
    [req.params.id, req.branchId]
  );
  if (!callRows[0]) return res.status(404).json({ error: 'Call not found.' });
  const { rows: turns } = await pool.query(
    `select seq, speaker, transcript, confidence, started_at from call_turn where call_id = $1 order by seq`,
    [req.params.id]
  );
  res.json({ call: callRows[0], turns });
});

// A10: usage is visible from day one, before the first invoice, not after
// it -- an unexpected bill is a renewal lost (0.5). `cost_estimate` isn't
// computed or summed here yet: nothing has picked a real telephony/STT/TTS
// provider with real per-minute pricing yet (Stage 6+), and guessing a
// number would be worse than admitting it isn't known -- see
// engine/payout-providers.js's own Moniepoint stub for the same principle
// applied to money. Minutes/call counts are real numbers today, computed
// from whatever calls have actually run and ended.
router.get('/usage', async (req, res) => {
  const { rows } = await pool.query(
    `select
       count(*) filter (where started_at >= date_trunc('month', now())) as calls_this_month,
       coalesce(sum(duration_seconds) filter (where started_at >= date_trunc('month', now())), 0) as seconds_this_month,
       count(*) filter (where started_at >= date_trunc('month', now() - interval '1 month') and started_at < date_trunc('month', now())) as calls_last_month,
       coalesce(sum(duration_seconds) filter (where started_at >= date_trunc('month', now() - interval '1 month') and started_at < date_trunc('month', now())), 0) as seconds_last_month
     from voice_call
     where ($1::uuid is null or branch_id = $1)`,
    [req.branchId]
  );
  const r = rows[0];
  res.json({
    callsThisMonth: Number(r.calls_this_month),
    minutesThisMonth: Math.round(Number(r.seconds_this_month) / 60),
    callsLastMonth: Number(r.calls_last_month),
    minutesLastMonth: Math.round(Number(r.seconds_last_month) / 60),
    costEstimateAvailable: false,
  });
});

// Claims a callback so two staff don't both call the same person back --
// same spirit as delivery's atomic offer claim, but a phone callback has no
// race to worry about (only one person picks up their own follow-up task),
// so a plain conditional update is enough here, no transaction needed.
router.post('/callbacks/:id/claim', requireEditorApi, async (req, res) => {
  const { rows } = await pool.query(
    `update callback_task set status = 'in_progress', claimed_by = $1 where id = $2 and status = 'open' returning *`,
    [req.staff.id, req.params.id]
  );
  if (!rows[0]) return res.status(409).json({ error: 'This callback is not open.' });
  res.json(rows[0]);
});

router.post('/callbacks/:id/resolve', requireEditorApi, async (req, res) => {
  const { rows } = await pool.query(
    `update callback_task set status = 'done', resolved_at = now() where id = $1 and status in ('open', 'in_progress') returning *`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(409).json({ error: 'This callback is already resolved.' });
  res.json(rows[0]);
});
