// Serves a product's photo as a real image response instead of the raw
// data: URI -- Chidera 2026-09-10: "i want it to open straight like an
// image already there", after "the menu is still kind of loading" showed
// up again once photos were embedded back into the page. A data: URI has
// to download as part of the HTML itself (there's no separate request to
// defer), so `loading="lazy"` on it saves nothing -- an <img src> pointing
// here is a REAL network request the browser can genuinely put off until
// the guest scrolls near it, which is what actually keeps the initial
// page light regardless of how many photos a business has. Public, no
// auth -- a product photo isn't sensitive, and this only ever serves the
// same bytes a guest could already see via the page's own embedded data.
import express from 'express';
import { pool } from '../lib/db.js';

export const router = express.Router();

router.get('/:productId', async (req, res) => {
  const { rows } = await pool.query('select image_data_url from product where id = $1', [req.params.productId]);
  const dataUrl = rows[0]?.image_data_url;
  const match = dataUrl && /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return res.status(404).end();
  res.set('Content-Type', match[1]);
  // Not "immutable" -- a business can re-upload a product's photo in
  // Catalogue.jsx and a customer opening the menu an hour later should
  // see the new one, not one cached from before the change.
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(Buffer.from(match[2], 'base64'));
});
