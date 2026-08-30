// Bulk catalogue entry: staff paste their menu however it's already
// written, or upload photo(s) of it, instead of typing every item into a
// form one at a time. One AI call turns it into structured rows -- same
// "let AI understand messy input" principle the engine already applies to
// customer messages, just pointed at the owner's own menu instead.
import { askJson, askJsonWithImages } from './claude.js';

const SYSTEM = `Extract every menu/service/catalogue item you can find into JSON. For each item, capture: name (string), description (string, empty if none given), price (number, in the currency's smallest whole unit as written -- e.g. "4,500" becomes 4500, "N2000" becomes 2000), category (string or null -- the section heading this item appeared under, e.g. "Drinks", "Rice", "Starters", exactly as written; null if the source has no section headings at all -- never invent one). A section heading itself (e.g. "STARTERS", a currency symbol alone) is not a priced item -- skip it as an item, but use it as the category for the items under it. If a price is genuinely missing for an item, use null for that item's price and it will be skipped. Reply ONLY with JSON: {"items": [{"name": "...", "description": "...", "price": <number or null>, "category": "..." or null}]}`;

function cleanItems(items) {
  return (Array.isArray(items) ? items : [])
    .filter((i) => i && i.name && typeof i.price === 'number' && i.price > 0)
    .map((i) => ({
      name: String(i.name).trim(),
      description: i.description ? String(i.description).trim() : null,
      price: i.price,
      category: i.category ? String(i.category).trim() : null,
    }));
}

export async function parseMenuText(text) {
  const result = await askJson(SYSTEM, text);
  return cleanItems(result?.items);
}

// images: [{ mediaType, base64 }] -- one or more photos of a physical/
// printed menu (e.g. a multi-page menu shot as separate photos). All pages
// read together in one call so an item continued across pages, or repeated
// on more than one page, doesn't get double-counted or split.
export async function parseMenuImages(images) {
  const result = await askJsonWithImages(SYSTEM, 'These are photo(s) of a menu, possibly multiple pages of the same menu. Extract every item exactly once.', images);
  return cleanItems(result?.items);
}

// Reconciles a freshly-extracted menu against what's already live, so a
// re-uploaded menu updates the catalogue instead of duplicating it.
// `existing` is the current live product rows (id, name, price, category);
// `extracted` is this upload's cleaned items. AI-matched (not
// string-matched) because a re-typed or re-photographed menu rarely spells
// an item identically to what's already on file ("Jollof Rice" vs "Jollof
// rice (large)") -- same "let AI understand messy real-world input"
// principle as everywhere else this engine reads a business's own data.
// Returns the three buckets a human then reviews: matches (existing item
// found again, possibly with a changed name/description/price/category),
// genuinely new items, and existing items not found in this upload at all
// (candidates for removal).
export async function reconcileMenu(existing, extracted) {
  if (!existing.length) return { matches: [], newItems: extracted, removedIds: [] };
  if (!extracted.length) return { matches: [], newItems: [], removedIds: existing.map((e) => e.id) };

  const numberedExisting = existing.map((e, i) => `${i + 1}. ${e.name} -- ${e.price}`).join('\n');
  const numberedExtracted = extracted.map((e, i) => `${i + 1}. ${e.name}${e.description ? ` (${e.description})` : ''} -- ${e.price}`).join('\n');
  const system = `You're comparing a business's current menu against a freshly re-extracted version of what should be the same menu (re-typed or re-photographed, so wording/formatting may differ even for the same real item). For each EXISTING item, decide: does it still appear in the NEW list (even if renamed, re-described, or re-priced)?\n\nReply ONLY with JSON:\n{"matches": [{"existingNumber": <1-based number from EXISTING>, "newNumber": <1-based number from NEW>}], "removedNumbers": [<1-based numbers from EXISTING not found in NEW at all>]}\n\nEvery EXISTING item must appear in exactly one of "matches" or "removedNumbers". Any NEW item not referenced by any match is implicitly a brand-new item -- don't list those separately.\n\nEXISTING:\n${numberedExisting}\n\nNEW:\n${numberedExtracted}`;

  const result = await askJson(system, 'Compare the two lists as described.');
  const matchedNewIndexes = new Set();
  const matches = [];
  for (const m of Array.isArray(result?.matches) ? result.matches : []) {
    const existingItem = existing[m.existingNumber - 1];
    const newItem = extracted[m.newNumber - 1];
    if (!existingItem || !newItem) continue;
    matchedNewIndexes.add(m.newNumber - 1);
    matches.push({ existingId: existingItem.id, name: newItem.name, description: newItem.description, price: newItem.price, category: newItem.category });
  }
  const removedIds = (Array.isArray(result?.removedNumbers) ? result.removedNumbers : [])
    .map((n) => existing[n - 1]?.id)
    .filter(Boolean);
  const newItems = extracted.filter((_, i) => !matchedNewIndexes.has(i));
  return { matches, newItems, removedIds };
}
