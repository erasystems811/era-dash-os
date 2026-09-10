// The reliable "View menu" experience -- a WhatsApp List Message the bot
// builds and sends itself, straight from the product table. Unlike the
// Meta-native catalogue (engine/whatsapp-catalog.js), this needs no
// external indexing/propagation step and cannot fail with "product not
// found" -- everything it references is checked live, in this same call.
// Deliberately kept separate from whatsapp-catalog.js: that module still
// runs in the background (so a business's WhatsApp profile "View catalog"
// tab keeps working too), this one is what actually answers "what do you
// have" reliably in-chat.
//
// Tapping a real product row really orders it (see webhook-whatsapp.js /
// flow.js's handleMenuItemTap) -- one at a time, since WhatsApp's list
// message has no multi-select or quantity picker, but a second tap or a
// typed "make it 3" both work as real modifications once it's in the
// order. No AI call needed to know what a tap meant, unlike a typed order.
import { pool } from '../lib/db.js';
import { resolveMenu } from './fields.js';

const GRAPH_VERSION = 'v20.0';
// WhatsApp's own hard limit for a list message: 10 rows TOTAL across every
// section combined, not 10 per section. One row is always reserved for
// "More..." once a list has to be paginated, so a real page holds 9 items.
const MAX_ROWS_TOTAL = 10;
const PAGE_SIZE = MAX_ROWS_TOTAL - 1;
const CATEGORY_PREFIX = 'cat::'; // show a category's items, page 0
const CATEGORY_PAGE_PREFIX = 'catpage::'; // show another page of the top-level category list
const ITEM_PAGE_PREFIX = 'itempage::'; // show another page of one category's items
const UNCATEGORIZED = 'Menu';

function creds() {
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) throw new Error('META_PHONE_NUMBER_ID / META_ACCESS_TOKEN not set -- WhatsApp is not connected yet.');
  return { phoneNumberId, accessToken };
}

export async function sendListMessage(to, { bodyText, buttonText, sectionTitle, rows }) {
  const { phoneNumberId, accessToken } = creds();
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText.slice(0, 1024) },
        action: { button: buttonText.slice(0, 20), sections: [{ title: sectionTitle.slice(0, 24), rows }] },
      },
    }),
  });
  if (!res.ok) throw new Error(`WhatsApp list message failed ${res.status}: ${await res.text()}`);
  return res.json();
}

// Never queries product directly -- resolveMenu (engine/fields.js) is the
// one place that reads the menu, so this stays correct as soon as
// sharing_mode/branch scoping is actually in use, with no change here.
// Previously excluded import_status = 'removed' here specifically, which
// this drops: per schema.sql's own comment on product.import_status, a
// 'removed'-flagged item's real name/price stay live and it keeps serving
// customers until a human actually confirms the removal from the Catalogue
// page -- excluding it here was inconsistent with every other menu read
// (fields.js's extractOrderItems/extractOrderModifications never excluded
// it either) and let a still-orderable item silently vanish from the "View
// menu" button before staff had approved anything.
async function liveProducts(branchId) {
  return resolveMenu(branchId);
}

function toProductRow(product) {
  return {
    id: product.id,
    title: product.name.slice(0, 24),
    description: `NGN ${Number(product.price).toLocaleString()}${product.description ? ` – ${product.description}` : ''}`.slice(0, 72),
  };
}

// Splits a page out of a longer list, with a trailing "More..." row when
// there's a next page -- the one real pattern behind every paginated list
// this module sends, so pagination behaves identically everywhere.
function paginate(items, page, toRow, moreRow) {
  const start = page * PAGE_SIZE;
  const slice = items.slice(start, start + PAGE_SIZE);
  const hasMore = start + PAGE_SIZE < items.length;
  const rows = slice.map(toRow);
  if (hasMore) rows.push(moreRow(page + 1));
  return rows;
}

function groupByCategory(products) {
  const byCategory = new Map();
  for (const p of products) {
    const key = p.category || UNCATEGORIZED;
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(p);
  }
  return byCategory;
}

async function sendCategoryPage(to, page, branchId) {
  const products = await liveProducts(branchId);
  const byCategory = groupByCategory(products);
  const categories = [...byCategory.keys()];
  const rows = paginate(
    categories,
    page,
    (c) => ({
      id: `${CATEGORY_PREFIX}${c}`,
      title: c.slice(0, 24),
      description: `${byCategory.get(c).length} item${byCategory.get(c).length === 1 ? '' : 's'}`,
    }),
    (nextPage) => ({ id: `${CATEGORY_PAGE_PREFIX}${nextPage}`, title: 'More categories', description: 'See more of the menu' })
  );
  await sendListMessage(to, {
    bodyText: 'Here is our menu. Please choose a category to see what is available.',
    buttonText: 'View menu',
    sectionTitle: 'Categories',
    rows,
  });
}

async function sendCategoryItemsPage(to, category, page, branchId) {
  const products = (await liveProducts(branchId)).filter((p) => (p.category || UNCATEGORIZED) === category);
  if (!products.length) return false;
  const rows = paginate(products, page, toProductRow, (nextPage) => ({
    id: `${ITEM_PAGE_PREFIX}${category}::${nextPage}`,
    title: 'More items',
    description: `See more of ${category}`,
  }));
  await sendListMessage(to, {
    bodyText: `${category}. Please tell me what you would like once you have had a look.`,
    buttonText: 'View items',
    sectionTitle: category,
    rows,
  });
  return true;
}

// Sends the real, current menu as a WhatsApp List Message. Picks the right
// shape automatically: 9 items or fewer overall -> one flat list of the
// actual items; more than that -> a list of categories first (tapping one
// shows that category's items). Either level pages itself automatically
// past 9 rows, so a menu of any real size (10, 40, or 160 items) is fully
// reachable, never silently cut off. Returns false only when the
// catalogue is genuinely empty -- caller falls back to text.
export async function sendMenuList(to, bodyText, branchId) {
  const products = await liveProducts(branchId);
  if (!products.length) return false;

  if (products.length <= PAGE_SIZE) {
    const rows = products.map(toProductRow);
    await sendListMessage(to, { bodyText, buttonText: 'View menu', sectionTitle: UNCATEGORIZED, rows });
    return true;
  }

  await sendCategoryPage(to, 0, branchId);
  return true;
}

export function menuRowKind(id) {
  if (typeof id !== 'string') return 'product';
  if (id.startsWith(CATEGORY_PAGE_PREFIX)) return 'category_page';
  if (id.startsWith(ITEM_PAGE_PREFIX)) return 'item_page';
  if (id.startsWith(CATEGORY_PREFIX)) return 'category';
  return 'product';
}

// Routes a tapped row that isn't a product straight to the right page --
// used by the webhook for every menu-navigation row (category, or either
// "More..." row). A tapped product row is handled separately by the
// webhook (see productNameForRowId below) -- that one's just an
// acknowledgement, not a page to send.
export async function handleMenuNavigation(to, rowId, branchId) {
  const kind = menuRowKind(rowId);
  if (kind === 'category_page') {
    await sendCategoryPage(to, Number(rowId.slice(CATEGORY_PAGE_PREFIX.length)), branchId);
    return;
  }
  if (kind === 'category') {
    await sendCategoryItemsPage(to, rowId.slice(CATEGORY_PREFIX.length), 0, branchId);
    return;
  }
  if (kind === 'item_page') {
    const rest = rowId.slice(ITEM_PAGE_PREFIX.length);
    const sep = rest.lastIndexOf('::');
    await sendCategoryItemsPage(to, rest.slice(0, sep), Number(rest.slice(sep + 2)), branchId);
  }
}

// Looks up a tapped product row back to the real, current product -- the
// webhook uses this to actually add it to the order (see flow.js's
// handleMenuItemTap), never a name/price the customer might be shown from
// a stale render.
export async function productForRowId(productId) {
  const { rows } = await pool.query('select id, name, price from product where id = $1 and availability = true', [productId]);
  return rows[0] || null;
}
