// Chidera, 2026-09-24: "now feedback can have a fill a complaint form kind
// of thing" -- a real form (not free chat text) for a customer to lay a
// complaint, reached either from routes/web-chat.js's first-choice bubble
// ("Give feedback") or its own ?ctx=complaint entry (flow.js's
// sendComplaintLink). Submitting logs their words as a real inbound
// message (so handover()'s own transcript summary includes it) then calls
// the SAME handover() every other complaint/handover path already uses --
// no new staff-alert mechanism, just a nicer front end for the same
// underlying action. Public, token-authenticated like /wa and /f.
import express from 'express';
import { pool } from '../lib/db.js';
import { renderComplaintFormPage } from '../engine/complaint-form-template.js';
import { resolveMenuBranding } from './dinein-menu.js';
import { logInboundWebsiteMessage, handover, currentDineinSession } from '../engine/flow.js';

export const router = express.Router();

async function resolveCustomer(token) {
  const { rows } = await pool.query('select * from customers where menu_token = $1', [token]);
  return rows[0] || null;
}

router.get('/:token', async (req, res) => {
  const customer = await resolveCustomer(req.params.token);
  if (!customer) return res.status(404).send('Link not found.');
  const branding = await resolveMenuBranding();
  // Chidera, 2026-09-25: "the feedback web page and complaint web page
  // should have the back to chat thing too." Table-scoped for a dine-in
  // guest currently mid a real table session, same as feedback's own fix
  // -- otherwise this would hand them back to the generic online thread
  // instead of their own table's separate one.
  const dineinSession = await currentDineinSession(customer);
  let chatUrl = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}/wa/${req.params.token}` : null;
  if (chatUrl && dineinSession) chatUrl += `?table=${dineinSession.qr_token}`;
  res.set('Content-Type', 'text/html').send(
    renderComplaintFormPage({
      businessName: branding.business_name || '',
      submitted: false,
      submitPath: `/c/${req.params.token}/submit`,
      chatUrl,
    })
  );
});

router.post('/:token/submit', async (req, res) => {
  const customer = await resolveCustomer(req.params.token);
  if (!customer) return res.status(404).json({ error: 'Link not found.' });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Please tell us what happened first.' });
  customer.channel = 'website';
  await logInboundWebsiteMessage(customer, text);
  // Chidera, 2026-09-24: "there is also nowhere for complaint to go to,
  // there is no database table." handover() alone (the real WhatsApp ping
  // to whichever staff have handover_alerts on) never left a persistent
  // record anywhere -- this is the one, so the dashboard's own Complaints
  // tab has something real to list and reply to.
  await pool.query(
    `insert into complaint (customer_id, branch_id, message) values ($1, $2, $3)`,
    [customer.id, customer.branch_id, text]
  );
  await handover(
    customer,
    'Customer submitted a complaint via the complaint form',
    null,
    `Thanks, we've received your message and will get back to you shortly.`
  );
  res.json({ ok: true });
});
