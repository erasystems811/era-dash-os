// What the bot asks for and extracts, driven by the bot_field table (see
// schema.sql) instead of one hand-written prompt per field -- the standing
// "one reusable extractor" rule. Which fields matter right now for a given
// order, and where an extracted value gets written, is centralized here so
// there's exactly one place that knows the mapping.
import { pool } from '../lib/db.js';
import { defineField, extractField } from '../bot-engine/index.js';
import { askJson } from './claude.js';

// bot-engine/extract.js's prompt never states the actual choices list, and
// never tells the AI a boolean field needs a real JSON true/false rather
// than the word "yes" -- it only checks the answer against field.choices or
// typeof afterward. So both have to be spelled out in `description` itself,
// or a correct-sounding answer ("jollof rice" vs the catalogue's "Jollof
// Rice and Chicken", or the word "yes" for a boolean) gets silently
// rejected by that after-the-fact check. Found via the sandbox fixtures --
// shared here since every choice/boolean field needs the same fix, not
// just the ones sourced from bot_field.
export function describeForExtraction(question, { type, choices } = {}) {
  if (choices?.length) {
    return `${question} Reply with the value copied exactly (same spelling and capitalisation) from this list: ${choices.join(', ')}. If nothing in the message clearly matches one of these, return null rather than guessing.`;
  }
  if (type === 'boolean') {
    return `${question} Reply with a real JSON boolean, true or false (not the words "yes"/"no") -- true if they are affirming/agreeing, false if they are declining/refusing. If it's genuinely unclear which, return null.`;
  }
  return question;
}

export async function loadBotFields() {
  const { rows } = await pool.query('select * from bot_field order by key');
  return rows.map((r) =>
    defineField({
      key: r.key,
      label: r.label,
      question: r.question,
      description: describeForExtraction(r.question, { type: r.type, choices: r.choices }),
      type: r.type,
      choices: r.choices || undefined,
      examples: r.examples || undefined,
    })
  );
}

// Most businesses are single-location and never touch this -- zero or one
// row means no question ever gets asked (one row is auto-assigned, silently,
// so downstream address lookups have one consistent place to check
// regardless of whether the business happens to have branches). Two or more
// rows is the only case that adds a real question to the flow.
export async function branchOptions() {
  const { rows } = await pool.query('select id, name, address from branch order by name');
  return rows;
}

export async function getSharingMode() {
  const { rows } = await pool.query('select sharing_mode from business limit 1');
  return rows[0]?.sharing_mode || 'independent';
}

// The one place the menu is ever read from for a live conversation --
// "never query the products table directly from a feature" (branch
// addendum section 4). `branchId` is the conversation's already-resolved
// branch (order.branch_id, or null/unknown before that's settled).
//
// merged, or branchId not yet known: the full catalogue, unscoped -- this
// is also what every business gets today (nobody has branch-scoped
// products yet), so it's a no-op until sharing_mode is actually switched to
// 'independent' AND a real branch is known.
//
// independent, with a known branch: that branch's own items, PLUS any item
// nobody's assigned to a specific branch yet. Not a transitional shim --
// a permanent rule. The moment a business adds its second branch, every
// existing product still has branch_id = null; treating "unassigned" as
// "visible everywhere" means the menu never silently goes empty just
// because nobody's gone through and split up 300 items yet. Assigning an
// item to one branch is opt-in, from the Catalogue page.
export async function resolveMenu(branchId) {
  const base = `select id, name, description, price, category from product where availability = true and import_status is distinct from 'new'`;
  const sharingMode = branchId ? await getSharingMode() : 'merged';
  if (sharingMode === 'merged') {
    const { rows } = await pool.query(`${base} order by category nulls last, name`);
    return rows;
  }
  const { rows } = await pool.query(`${base} and (branch_id = $1 or branch_id is null) order by category nulls last, name`, [branchId]);
  return rows;
}

// A whole order in one message ("2 jollof rice, 1 suya wrap, 3 chapman")
// is the normal case, not an edge case -- so item collection is one AI call
// that pulls out every item+quantity pair it can match against the real
// catalogue, not a single choice field asked once per item. No quantity
// stated for a matched item defaults to 1 rather than rejecting it, since
// "I want jollof rice" plainly means one.
// Returns { matched, ambiguous } -- a vague mention that could genuinely be
// more than one real catalogue item ("rice" when both "Fried rice and
// turkey" and "Jollof rice with chicken" are on the menu) used to just get
// silently skipped, since it isn't a "clear match" to any ONE item -- the
// customer got a generic re-ask instead of the real, relevant options.
// `ambiguous` surfaces exactly which real items a vague term could mean, so
// the caller can ask a specific clarifying question grounded in what's
// actually available, not guess or fall back to a blanket "what would you
// like" -- always driven by the real catalogue, never invented options.
export async function extractOrderItems(message, branchId) {
  const products = await resolveMenu(branchId);
  if (!products.length) return { matched: [], ambiguous: [] };
  // Asking for a catalogue INDEX rather than a copied-out name closes a
  // real failure mode found in testing: with a comma-separated catalogue
  // and a comma-separated multi-item order in the same prompt, the model
  // sometimes ran the two together and returned a garbled name that was
  // actually a fragment of several catalogue entries pasted together
  // (reproduced with "2 jollof rice, 1 suya wrap and 3 chapman" -- the
  // third item's "name" came back as three catalogue entries concatenated).
  // A numbered list, one item per line, plus asking for the number instead
  // of the string, means matching is exact by construction -- no string
  // comparison, no ambiguity for the model to garble.
  const numbered = products.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
  const system = `Extract every menu item and quantity the customer is ordering from their message. For each one, give the catalogue NUMBER it matches (each match must clearly refer to one specific catalogue item). If no quantity is stated for a matched item, use 1.\n\nIf a mention is vague enough that it could genuinely mean more than one catalogue item (e.g. "rice" when both a jollof rice and a fried rice dish exist), do NOT guess which one and do NOT skip it silently -- list it separately with every catalogue number it could plausibly mean, so the customer can be asked to pick between the real options.\n\nCatalogue:\n${numbered}\n\nReply ONLY with JSON: {"items": [{"index": <catalogue number>, "quantity": <number>}], "ambiguous": [{"term": "<what they said>", "indexes": [<catalogue numbers it could mean>]}]}. Empty arrays if nothing matches or nothing is ambiguous.`;
  const result = await askJson(system, message);
  const requested = Array.isArray(result?.items) ? result.items : [];
  const matched = [];
  for (const item of requested) {
    const idx = parseInt(item?.index, 10);
    const product = Number.isInteger(idx) ? products[idx - 1] : undefined;
    if (!product) continue;
    const qty = parseInt(item.quantity, 10);
    matched.push({ productId: product.id, name: product.name, price: product.price, quantity: qty > 0 ? qty : 1 });
  }
  const ambiguousRequested = Array.isArray(result?.ambiguous) ? result.ambiguous : [];
  const ambiguous = [];
  for (const item of ambiguousRequested) {
    const options = (Array.isArray(item?.indexes) ? item.indexes : [])
      .map((idx) => products[parseInt(idx, 10) - 1])
      .filter(Boolean);
    if (options.length > 1) ambiguous.push({ term: item.term, options: options.map((p) => p.name) });
  }
  return { matched, ambiguous };
}

// Order review isn't a one-shot thing -- a customer can come back with "add
// a chapman" or "remove the suya wrap" any time before they've actually
// paid. Same index-based matching as extractOrderItems, but distinguishing
// add / remove / set-exact-quantity, and returning null (not an empty
// object) when the message isn't actually about changing the order at all
// -- callers need to tell "nothing to change" from "explicitly asked to
// change nothing", so a normal reply doesn't get misread as a modification.
export async function extractOrderModifications(message, currentItems, branchId) {
  const products = await resolveMenu(branchId);
  if (!products.length) return null;
  const numbered = products.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
  const currentList = currentItems.length ? currentItems.map((i) => `${i.quantity}x ${i.name}`).join(', ') : '(nothing yet)';
  const system = `The customer's order currently has: ${currentList}.\n\nRead their message and decide if they're asking to change their order (add something new, remove something, or change a quantity to an exact new number). If the message is not about changing the order -- a question, a greeting, confirming yes/no, answering something else -- reply with exactly {"has_changes": false}.\n\nIf it IS a change request, reply with the catalogue NUMBER for each item involved (must clearly match one specific catalogue item):\n{"has_changes": true, "adds": [{"index": <number>, "quantity": <number, default 1>}], "removes": [{"index": <number>}], "sets": [{"index": <number>, "quantity": <exact new number>}]}\n"adds" is for something not already in the order, or explicitly adding more of something ("add 2 more X"). "sets" is for stating an exact new total quantity for something already in the order ("make it 3 suya wrap"). "removes" is for taking something out entirely.\n\nCatalogue:\n${numbered}`;
  const result = await askJson(system, message);
  if (!result?.has_changes) return null;

  const resolve = (list) =>
    (Array.isArray(list) ? list : [])
      .map((item) => {
        const idx = parseInt(item?.index, 10);
        const product = Number.isInteger(idx) ? products[idx - 1] : undefined;
        if (!product) return null;
        const qty = parseInt(item?.quantity, 10);
        return { productId: product.id, name: product.name, price: product.price, quantity: qty > 0 ? qty : 1 };
      })
      .filter(Boolean);

  const adds = resolve(result.adds);
  const removes = resolve(result.removes);
  const sets = resolve(result.sets);
  if (!adds.length && !removes.length && !sets.length) return null;
  return { adds, removes, sets };
}

// A customer changing their mind about delivery vs pickup is allowed any
// time before payment is made -- same "before payment, anything goes" rule
// as item changes above. Only relevant once fulfilment_type is already set
// (nothing to "change" before that -- it's still the normal first-time
// question), which the caller is expected to check before calling this.
export async function extractFulfilmentChange(order, message) {
  const system = `The customer already chose "${order.fulfilment_type}" for how they'll get their order (delivery = a rider brings it to them, pickup = they collect it themselves). Does this message ask to switch to the OTHER option? Reply ONLY with JSON: {"change_to": "delivery" or "pickup" or null}. Use null if this message isn't about changing delivery vs pickup at all.`;
  const result = await askJson(system, message);
  const choice = result?.change_to;
  if (choice !== 'delivery' && choice !== 'pickup') return null;
  if (choice === order.fulfilment_type) return null;
  return choice;
}

// Restaurant-mode only for this build (Section 7.1 of the build schema).
// Extending to other business types means adding their sequence here --
// still one file, not one flow per type.
export async function missingFieldsForOrder(order, orderItems) {
  const missing = [];
  if (!orderItems.length) {
    missing.push('items');
    return missing;
  }
  if (!order.branch_id) {
    const branches = await branchOptions();
    if (branches.length > 1) {
      missing.push('branch');
      return missing;
    }
    if (branches.length === 1) {
      await pool.query('update "order" set branch_id = $1 where id = $2', [branches[0].id, order.id]);
      order.branch_id = branches[0].id; // caller's copy, so the next check below sees it applied
    }
  }
  return missing;
}

// Fulfilment (delivery vs pickup, and the address if delivery) is asked
// AFTER the customer has confirmed what they want and seen the price, not
// before -- knowing where to send it has nothing to do with what it costs,
// and asking for it earlier just delays the one thing they actually asked
// for: how much and do you want it.
export async function missingFulfilmentFields(order) {
  const missing = [];
  if (!order.fulfilment_type) {
    missing.push('fulfilment_type');
    return missing;
  }
  if (order.fulfilment_type === 'delivery') {
    const { rows } = await pool.query('select address from customers where id = $1', [order.customer_id]);
    if (!rows[0]?.address) missing.push('delivery_address');
  }
  return missing;
}

// Not a bot_field row (nothing to configure per-business here, it's just
// "which of the real branch rows did they mean") -- built fresh each time
// from whatever's actually in the branch table right now.
export async function branchQuestionField() {
  const branches = await branchOptions();
  const question = 'Which branch would you like to order from?';
  return defineField({
    key: 'branch',
    label: 'branch',
    question,
    type: 'choice',
    choices: branches.map((b) => b.name),
    description: describeForExtraction(question, { type: 'choice', choices: branches.map((b) => b.name) }),
  });
}

export async function extractAndApply({ fieldKey, message, contextQuestion, order }) {
  if (fieldKey === 'branch') {
    const field = await branchQuestionField();
    const value = await extractField(field, message, { askJson, contextQuestion });
    if (value === null) return null;
    await applyField(fieldKey, value, order);
    return value;
  }

  const fields = await loadBotFields();
  const field = fields.find((f) => f.key === fieldKey);
  if (!field) return null;

  const value = await extractField(field, message, { askJson, contextQuestion });
  if (value === null) return null;
  await applyField(fieldKey, value, order);
  return value;
}

async function applyField(fieldKey, value, order) {
  if (fieldKey === 'fulfilment_type') {
    if (!['delivery', 'pickup'].includes(value)) return;
    await pool.query('update "order" set fulfilment_type = $1 where id = $2', [value, order.id]);
    return;
  }
  if (fieldKey === 'delivery_address') {
    await pool.query('update customers set address = $1 where id = $2', [value, order.customer_id]);
    return;
  }
  if (fieldKey === 'branch') {
    const { rows } = await pool.query('select id from branch where lower(name) = lower($1)', [value]);
    if (!rows[0]) return;
    await pool.query('update "order" set branch_id = $1 where id = $2', [rows[0].id, order.id]);
  }
}
