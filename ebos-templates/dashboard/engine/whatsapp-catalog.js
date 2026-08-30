// Meta's native WhatsApp Catalogue (the shop icon customers see in-chat) --
// separate from the product table's own use in the bot's order flow. This
// module makes the product table the one source of truth: every add/edit/
// toggle/delete on the Catalogue page best-effort mirrors here, so an owner
// never maintains two lists. Same per-business env-var/sandbox pattern as
// whatsapp-send.js and whatsapp-profile.js.
import { pool } from '../lib/db.js';

const GRAPH_VERSION = 'v20.0';

function creds() {
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) throw new Error('META_PHONE_NUMBER_ID / META_ACCESS_TOKEN not set -- WhatsApp is not connected yet.');
  return { phoneNumberId, accessToken };
}

async function graphFetch(path, accessToken, init = {}) {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${accessToken}`, ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`Graph API ${path} failed ${res.status}: ${await res.text()}`);
  return res.json();
}

// Every business's WABA lives under this one Business Manager (ERA
// Systems) -- confirmed directly in Business Settings, not guessed.
// Hardcoded rather than looked up: /me/businesses returns an empty list for
// a SYSTEM_USER-type token no matter what permissions it has (confirmed
// live, 2026-08-30) -- that endpoint only works for a personal user token,
// so there's no working API call to discover this dynamically here.
const ERA_BUSINESS_MANAGER_ID = '28170337689266268';

// Idempotent: creates the catalog and turns on catalog visibility on this
// number only the first time. Every later call (every product sync) is a
// cheap read of the already-stored id.
export async function ensureCatalog() {
  if (process.env.EBOS_SANDBOX === '1') return { catalogId: 'sandbox', created: false };
  const { phoneNumberId, accessToken } = creds();
  const { rows } = await pool.query('select whatsapp_catalog_id, name from business limit 1');
  const business = rows[0];
  if (business?.whatsapp_catalog_id) return { catalogId: business.whatsapp_catalog_id, created: false };

  const catalog = await graphFetch(`${ERA_BUSINESS_MANAGER_ID}/owned_product_catalogs`, accessToken, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `${business?.name || 'EBOS'} Catalogue`, vertical: 'commerce' }),
  });
  await pool.query('update business set whatsapp_catalog_id = $1 where id = (select id from business limit 1)', [catalog.id]);
  // Cart deliberately off -- orders still go through the bot's own flow, not
  // WhatsApp's native cart/order webhook (not built), so turning cart on
  // would just give customers a second, silently-ignored way to order.
  await graphFetch(`${phoneNumberId}/whatsapp_commerce_settings?is_catalog_visible=true&is_cart_enabled=false`, accessToken, { method: 'POST' });
  return { catalogId: catalog.id, created: true };
}

export async function getCatalogStatus() {
  const { rows } = await pool.query('select whatsapp_catalog_id, whatsapp_catalog_connected from business limit 1');
  return {
    catalogId: rows[0]?.whatsapp_catalog_id || null,
    connected: Boolean(rows[0]?.whatsapp_catalog_connected),
  };
}

export async function markCatalogConnected() {
  await pool.query('update business set whatsapp_catalog_connected = true where id = (select id from business limit 1)');
}

function toBatchItem(product, businessName) {
  return {
    method: 'UPDATE', // paired with allow_upsert below -- covers create and update in one path, no need to track existence
    data: {
      id: product.id,
      title: product.name.slice(0, 100),
      description: (product.description || product.name).slice(0, 5000),
      price: `${Number(product.price).toFixed(2)} NGN`,
      currency: 'NGN',
      availability: product.availability ? 'in stock' : 'out of stock',
      condition: 'new',
      brand: businessName,
      link: process.env.PUBLIC_URL || 'https://erasystems.com.ng',
      image: [{ url: `${process.env.PUBLIC_URL}/documents/product-image/${product.id}` }],
    },
  };
}

// Syncs every live, photographed product to the catalog in one batch call.
// Items without a photo are skipped (reported back, never silently dropped)
// -- an item with no image would either fail Meta's own validation or show
// up broken, worse than just not being in the catalogue yet.
//
// requireEnabled (default true) refuses to run unless the business already
// has a catalog -- i.e. unless they've explicitly clicked "Enable WhatsApp
// Catalogue" at least once. Only the enable route itself passes false. This
// is what stops the background best-effort hooks below (fired on every
// ordinary catalogue edit) from silently opting a business into a Meta
// integration they never asked for.
export async function syncAllProducts({ requireEnabled = true } = {}) {
  if (process.env.EBOS_SANDBOX === '1') return { synced: 0, skippedNoPhoto: 0 };
  const status = await getCatalogStatus();
  if (requireEnabled && !status.catalogId) return { synced: 0, skippedNoPhoto: 0, notEnabled: true };
  if (!process.env.PUBLIC_URL) throw new Error('PUBLIC_URL not set -- product photos need a real public URL for Meta to fetch.');
  const { catalogId } = await ensureCatalog();
  const { accessToken } = creds();
  const { rows: business } = await pool.query('select name from business limit 1');
  const businessName = business[0]?.name || '';
  const { rows: products } = await pool.query(
    `select * from product where import_status is distinct from 'new' and import_status is distinct from 'removed' order by name`
  );
  const withPhoto = products.filter((p) => p.image_data_url);
  const skippedNoPhoto = products.length - withPhoto.length;
  if (!withPhoto.length) return { synced: 0, skippedNoPhoto };

  const requests = withPhoto.map((p) => toBatchItem(p, businessName));
  await graphFetch(`${catalogId}/items_batch`, accessToken, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ item_type: 'PRODUCT_ITEM', allow_upsert: true, requests }),
  });
  return { synced: withPhoto.length, skippedNoPhoto };
}

// Fire-and-forget from the Catalogue routes on every add/edit/toggle/import
// -- a sync failure (Meta down, catalog not enabled yet) must never break
// the actual save the owner is doing on their own product list.
export function syncBestEffort() {
  syncAllProducts().catch((err) => console.error('WhatsApp catalog sync failed:', err.message));
}

export async function deleteFromCatalog(productId) {
  if (process.env.EBOS_SANDBOX === '1') return;
  const { catalogId, created } = await ensureCatalog().catch(() => ({ catalogId: null }));
  if (!catalogId) return; // Catalogue never enabled for this business -- nothing to delete.
  const { accessToken } = creds();
  await graphFetch(`${catalogId}/items_batch`, accessToken, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ item_type: 'PRODUCT_ITEM', requests: [{ method: 'DELETE', data: { id: productId } }] }),
  });
}

export function deleteBestEffort(productId) {
  deleteFromCatalog(productId).catch((err) => console.error('WhatsApp catalog delete failed:', err.message));
}

// The "View menu" interactive button -- opens the whole connected catalog
// inside WhatsApp instead of the bot listing items as text. Needs one real
// product to show as the thumbnail; picking any synced item is fine, this
// is just the preview shown on the button itself, not a filter on what's
// browsable once opened.
export async function sendCatalogMessage(to, bodyText, footerText) {
  const { phoneNumberId, accessToken } = creds();
  const { rows } = await pool.query(
    `select id from product where availability = true and image_data_url is not null and import_status is distinct from 'new' order by name limit 1`
  );
  if (!rows.length) return false; // Nothing synced yet -- caller falls back to the old text/photo behaviour.
  try {
    await graphFetch(`${phoneNumberId}/messages`, accessToken, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'catalog_message',
          body: { text: bodyText },
          action: { name: 'catalog_message', parameters: { thumbnail_product_retailer_id: rows[0].id } },
          ...(footerText ? { footer: { text: footerText } } : {}),
        },
      }),
    });
    return true;
  } catch (err) {
    // A real failure here (Meta not yet indexing this item, an item
    // dropped from the catalog, a transient API error) must never crash
    // the whole message pipeline -- found live: this exact case, and with
    // no catch here, it took the customer's entire message down with it,
    // including the handover alert meant to cover for it. Fall back to the
    // caller's plain-text answer instead; log it so a real, repeated
    // failure still shows up in Bot Monitoring rather than going silent.
    console.error('sendCatalogMessage failed:', err.message);
    await pool.query(`insert into ai_errors (message) values ($1)`, [`WhatsApp catalog message failed: ${err.message}`.slice(0, 500)]).catch(() => {});
    return false;
  }
}
