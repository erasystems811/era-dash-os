import express from 'express';
import { pool } from '../lib/db.js';
import { esc, layout } from '../lib/render.js';
import { findStaffByEmail, verifyPassword, requireStaff } from '../lib/auth.js';
import { encryptPaymentValue } from '../lib/payment-crypto.js';

export const router = express.Router();

function canEdit(staff) {
  return staff.role === 'owner' || staff.role === 'manager';
}

router.get('/login', (req, res) => {
  res.send(
    layout({
      title: 'Log in',
      staff: null,
      body: `
    <form method="post" action="/login">
      <label>Email</label><input type="email" name="email" required autofocus>
      <label>Password</label><input type="password" name="password" required>
      <button type="submit">Log in</button>
    </form>
    ${req.query.error ? `<p class="danger">${esc(req.query.error)}</p>` : ''}`,
    })
  );
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const staff = email && (await findStaffByEmail(email));
  if (!staff || !(await verifyPassword(staff, password || ''))) {
    return res.redirect('/login?error=' + encodeURIComponent('Incorrect email or password.'));
  }
  req.session.staff = { id: staff.id, businessId: staff.business_id, name: staff.name, role: staff.role };
  res.redirect(`/businesses/${staff.business_id}`);
});

router.get('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

router.get('/', requireStaff, (req, res) => {
  res.redirect(`/businesses/${req.staff.businessId}`);
});

async function loadOwnBusiness(req, res, next) {
  if (req.params.id !== req.staff.businessId) return res.status(403).send('Not your business.');
  const { rows } = await pool.query('select * from business where id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).send('Business not found.');
  req.business = rows[0];
  next();
}

router.get('/businesses/:id', requireStaff, loadOwnBusiness, (req, res) => {
  const b = req.business;
  res.send(
    layout({
      title: b.name,
      staff: req.staff,
      body: `
    <p><strong>Type:</strong> ${esc(b.type)}</p>
    <p><strong>Address:</strong> ${esc(b.address) || '(not set)'}</p>
    <p><strong>Delivery:</strong> ${b.delivery_enabled ? 'enabled' : 'not enabled'}</p>
    <p><a href="/businesses/${b.id}/catalogue">Manage catalogue</a></p>
    ${canEdit(req.staff) ? `<p><a href="/businesses/${b.id}/settings">Business settings</a></p>` : ''}`,
    })
  );
});

router.get('/businesses/:id/settings', requireStaff, loadOwnBusiness, (req, res) => {
  if (!canEdit(req.staff)) return res.status(403).send('Only an owner or manager can edit business settings.');
  const b = req.business;
  res.send(
    layout({
      title: `${b.name} — Settings`,
      staff: req.staff,
      body: `
    <form method="post" action="/businesses/${b.id}/settings">
      <label>Name</label><input name="name" value="${esc(b.name)}" required>
      <label>Address</label><input name="address" value="${esc(b.address)}">
      <label>Phone number</label><input name="phone_number" value="${esc(b.phone_number)}">
      <label><input type="checkbox" name="delivery_enabled" style="width:auto" ${b.delivery_enabled ? 'checked' : ''}> Delivery enabled</label>
      <label>WhatsApp connection</label>
      <select name="whatsapp_connection">
        <option value="">Not set</option>
        <option value="coexistence" ${b.whatsapp_connection === 'coexistence' ? 'selected' : ''}>Coexistence (staff can reply from their phone)</option>
        <option value="api_only" ${b.whatsapp_connection === 'api_only' ? 'selected' : ''}>API only</option>
      </select>
      <label>Handover number</label><input name="handover_number" value="${esc(b.handover_number)}">
      <h4>Payment (Section 3.4)</h4>
      <label>Bank name</label><input name="bank_name" value="${esc(b.bank_name)}">
      <label>Account number</label><input name="bank_account_number" value="${esc(b.bank_account_number)}">
      <label>Account name</label><input name="bank_account_name" value="${esc(b.bank_account_name)}">
      <label>Paystack secret key ${b.payment_secret_key_encrypted ? '(already set — leave blank to keep)' : ''}</label><input name="payment_secret_key" type="password">
      <label>Paystack public key ${b.payment_public_key_encrypted ? '(already set — leave blank to keep)' : ''}</label><input name="payment_public_key" type="password">
      <button type="submit">Save</button>
    </form>`,
    })
  );
});

router.post('/businesses/:id/settings', requireStaff, loadOwnBusiness, async (req, res) => {
  if (!canEdit(req.staff)) return res.status(403).send('Only an owner or manager can edit business settings.');
  const f = req.body;
  const secretKeyEnc = f.payment_secret_key ? await encryptPaymentValue(f.payment_secret_key) : undefined;
  const publicKeyEnc = f.payment_public_key ? await encryptPaymentValue(f.payment_public_key) : undefined;
  await pool.query(
    `update business set
       name = $1, address = $2, phone_number = $3, delivery_enabled = $4,
       whatsapp_connection = $5, handover_number = $6,
       bank_name = $7, bank_account_number = $8, bank_account_name = $9,
       payment_provider = case when $10::bytea is not null or $11::bytea is not null then 'paystack' else payment_provider end,
       payment_secret_key_encrypted = coalesce($10, payment_secret_key_encrypted),
       payment_public_key_encrypted = coalesce($11, payment_public_key_encrypted)
     where id = $12`,
    [
      f.name,
      f.address || null,
      f.phone_number || null,
      f.delivery_enabled === 'on',
      f.whatsapp_connection || null,
      f.handover_number || null,
      f.bank_name || null,
      f.bank_account_number || null,
      f.bank_account_name || null,
      secretKeyEnc ?? null,
      publicKeyEnc ?? null,
      req.params.id,
    ]
  );
  res.redirect(`/businesses/${req.params.id}`);
});

function catalogueRow(p, canEditCatalogue) {
  return `<tr>
    <td>${esc(p.name)}</td>
    <td>${esc(p.description)}</td>
    <td>${Number(p.price).toFixed(2)}</td>
    <td>${esc(p.availability_type)}</td>
    <td>${p.duration_minutes ?? ''}</td>
    <td>${p.availability ? 'yes' : 'no'}</td>
    ${
      canEditCatalogue
        ? `<td>
      <form method="post" action="/businesses/${p.business_id}/catalogue/${p.id}/toggle" style="display:inline">
        <button type="submit">${p.availability ? 'Mark unavailable' : 'Mark available'}</button>
      </form>
      <form method="post" action="/businesses/${p.business_id}/catalogue/${p.id}/delete" style="display:inline">
        <button type="submit" class="danger">Delete</button>
      </form>
    </td>`
        : ''
    }
  </tr>`;
}

router.get('/businesses/:id/catalogue', requireStaff, loadOwnBusiness, async (req, res) => {
  const { rows } = await pool.query('select * from product where business_id = $1 order by created_at desc', [req.params.id]);
  const editable = canEdit(req.staff);
  res.send(
    layout({
      title: `${req.business.name} — Catalogue`,
      staff: req.staff,
      body: `
    <table>
      <tr><th>Name</th><th>Description</th><th>Price</th><th>Availability rule</th><th>Duration (min)</th><th>Available</th>${editable ? '<th></th>' : ''}</tr>
      ${rows.map((p) => catalogueRow(p, editable)).join('') || `<tr><td colspan="${editable ? 7 : 6}">No items yet.</td></tr>`}
    </table>
    ${
      editable
        ? `<fieldset>
      <legend>Add item</legend>
      <form method="post" action="/businesses/${req.params.id}/catalogue">
        <label>Name</label><input name="name" required>
        <label>Description</label><input name="description">
        <label>Price</label><input name="price" type="number" step="0.01" min="0" required>
        <label>Availability rule</label>
        <select name="availability_type">
          <option value="stock">By stock</option>
          <option value="time_slot">By time slot</option>
          <option value="date">By date</option>
        </select>
        <label>Slot duration in minutes (only if time slot)</label><input name="duration_minutes" type="number" min="1">
        <button type="submit">Add item</button>
      </form>
    </fieldset>`
        : ''
    }`,
    })
  );
});

router.post('/businesses/:id/catalogue', requireStaff, loadOwnBusiness, async (req, res) => {
  if (!canEdit(req.staff)) return res.status(403).send('Only an owner or manager can edit the catalogue.');
  const f = req.body;
  await pool.query(
    `insert into product (business_id, name, description, price, availability_type, duration_minutes)
     values ($1, $2, $3, $4, $5, $6)`,
    [req.params.id, f.name, f.description || null, f.price, f.availability_type, f.duration_minutes || null]
  );
  res.redirect(`/businesses/${req.params.id}/catalogue`);
});

router.post('/businesses/:id/catalogue/:productId/toggle', requireStaff, loadOwnBusiness, async (req, res) => {
  if (!canEdit(req.staff)) return res.status(403).send('Only an owner or manager can edit the catalogue.');
  await pool.query('update product set availability = not availability where id = $1 and business_id = $2', [req.params.productId, req.params.id]);
  res.redirect(`/businesses/${req.params.id}/catalogue`);
});

router.post('/businesses/:id/catalogue/:productId/delete', requireStaff, loadOwnBusiness, async (req, res) => {
  if (!canEdit(req.staff)) return res.status(403).send('Only an owner or manager can edit the catalogue.');
  await pool.query('delete from product where id = $1 and business_id = $2', [req.params.productId, req.params.id]);
  res.redirect(`/businesses/${req.params.id}/catalogue`);
});
