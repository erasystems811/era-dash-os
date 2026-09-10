// The real web menu page for REGULAR (non-dine-in) ordering -- Chidera
// 2026-09-10: "the menu is meant to be like a site now... not just in
// dine in[,] the normal conversation flow". Same page as dine-in's
// table-scoped version (engine/menu-page-template.js), just resolved by
// customer.menu_token instead of a table's qr_token, since there's no
// table here -- public, no login, mounted at /m in server.js.
import express from 'express';
import { pool } from '../lib/db.js';
import { renderMenuPage } from '../engine/menu-page-template.js';
import { menuForBranch, resolveMenuBranding } from './dinein-menu.js';
import { handleWebMenuOrder, getOpenOrder } from '../engine/flow.js';

export const router = express.Router();

async function resolveCustomer(token) {
  const { rows } = await pool.query('select * from customers where menu_token = $1', [token]);
  return rows[0] || null;
}

router.get('/:token/menu.json', async (req, res) => {
  const customer = await resolveCustomer(req.params.token);
  if (!customer) return res.status(404).json({ error: 'Link not found.' });
  const { rows: bizRows } = await pool.query('select name from business limit 1');
  const products = await menuForBranch(customer.branch_id);
  const pendingOrder = await pendingOrderPayload(customer.id);
  res.json({ business_name: bizRows[0]?.name, products, pendingOrder });
});

// So a guest who reopens "View menu" sees (and can edit) what's already
// pending instead of a page with no memory of it -- Chidera 2026-09-10:
// "how are they aware that the first one is still pending... how can they
// remove as well?" getOpenOrder is the same lookup the actual order
// engine uses (flow.js), so this always agrees with what a chat message
// would say.
async function pendingOrderPayload(customerId) {
  const order = await getOpenOrder(customerId);
  if (!order) return null;
  const { rows: items } = await pool.query('select product_id, quantity from order_item where order_id = $1', [order.id]);
  if (!items.length) return null;
  return {
    items: items.map((i) => ({ productId: i.product_id, quantity: i.quantity })),
    total: Number(order.total) || 0,
  };
}

router.post('/:token/review', async (req, res) => {
  const customer = await resolveCustomer(req.params.token);
  if (!customer) return res.status(404).json({ error: 'Link not found.' });
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Your basket is empty.' });

  const products = await menuForBranch(customer.branch_id);
  const byId = new Map(products.map((p) => [p.id, p]));
  const resolved = [];
  for (const item of items) {
    const p = byId.get(item.productId);
    if (!p || !p.availability) continue; // never trust the client's own price/availability claim
    const qty = Number(item.quantity) > 0 ? Number(item.quantity) : 1;
    resolved.push({ productId: p.id, name: p.name, price: p.price, quantity: qty });
  }
  if (!resolved.length) return res.status(400).json({ error: 'Sorry, nothing in your basket is available right now.' });

  await handleWebMenuOrder(customer, resolved);
  res.json({ ok: true });
});

router.get('/:token', async (req, res) => {
  const customer = await resolveCustomer(req.params.token);
  if (!customer) return res.status(404).send('Link not found.');
  const branding = await resolveMenuBranding(customer.branch_id);
  res.set('Content-Type', 'text/html').send(
    renderMenuPage({
      reviewPath: `/m/${req.params.token}/review`,
      businessName: branding.business_name || '',
      subtitle: 'Pick what you would like, then review your order.',
      coverPhotoUrl: branding.cover_photo_data_url,
      waNumber: branding.wa_number,
    })
  );
});
