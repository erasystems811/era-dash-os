// Shared HTML for the web menu page -- used by both routes/dinein-menu.js
// (table-scoped, GET /t/:qrToken) and routes/menu-page.js (general
// ordering, GET /m/:token). Same page either way, just a different way of
// knowing who's looking at it and where "Place order" posts to. Styling
// matches the reference demo (Downloads/EBOS-Web-Menu-Demo.html,
// Chidera 2026-09-10) -- Fraunces/Inter, warm paper background, pill
// buttons -- not the plainer first pass this replaced.
//
// coverPhotoVersion: an md5 of business.cover_photo_data_url (Settings >
// Branding), or null/undefined when none is set (falls back to the plain
// dark header, same as before this existed). Appended to /photo/cover as
// ?v= -- Chidera 2026-09-11: "when i changed cover photo why didnt it
// reflect?" /photo/cover was the same URL forever, so a browser (or
// WhatsApp's own longer-lived media cache) kept the OLD photo it had
// already cached there; a new photo now means a genuinely different URL,
// which can't collide with a stale cache entry for the old one.
// waNumber: the business's own WhatsApp number (digits only, no leading
// zero/plus) -- after a successful order this page redirects to
// https://wa.me/<waNumber>, which WhatsApp's in-app browser intercepts and
// hands straight back to that chat thread instead of leaving the guest
// stranded on a "site". Chidera 2026-09-10: "it should automatically take
// them back to the chat, why is it staying in the site?"
//
// App-shell layout (Chidera 2026-09-10: "it shouldn't feel like a website
// sef... keep the headers stiff... let that under website feel footer
// with the < and > and share and restart sign stop coming up and down on
// scroll"): html/body never scroll -- only the inner #scroll div does.
// WhatsApp's in-app browser shows/hides its own nav chrome in response to
// the DOCUMENT scrolling, so pinning the document itself and moving all
// scrolling into one inner div is what stops that chrome from animating,
// and incidentally is also what makes the header and basket bar truly
// static instead of just "sticky" (which still lets the page itself move).
//
// Everything renders synchronously from data embedded right here in the
// HTML (categories, the current grid, any pending order) -- no fetch, no
// "Loading menu..." placeholder. Chidera 2026-09-10, after an earlier pass
// fetched this after first paint to keep photos out of the HTML: "i want
// it to open straight like an image already there". The two goals aren't
// actually in tension: `products` below carries hasPhoto (a boolean), not
// the photo itself -- an item's actual picture is a real <img src> to
// routes/product-photo.js, a genuinely separate, genuinely deferrable
// request (`loading="lazy"`), unlike a data: URI, which has no separate
// request to defer and would have downloaded as part of this same HTML
// regardless of the attribute. So the page paints instantly AND stays
// light no matter how many photos a business has.
// askFulfilment/deliveryMode/deliveryZones/deliveryQuotePath: Chidera,
// 2026-09-17: "the extra penne or spagetti... could be on the site right?
// ... lets keep thinking but keep that" -- the same reasoning extended to
// delivery/pickup, address and (own_riders businesses only) which zone.
// Dine-in never passes any of these (routes/dinein-menu.js) -- a table
// order is always at_table payment, and handleCollectFulfilment
// (engine/flow.js) never even asks delivery/pickup for one, so asking here
// too would be a real, unwanted new question. Only routes/menu-page.js
// (general ordering) passes askFulfilment: true.
export function renderMenuPage({ reviewPath, pollPath, birthdayPath, showBirthdayPrompt, namePath, showNamePrompt, businessName, subtitle, coverPhotoVersion, waNumber, products, pendingOrder, initialCategory, askFulfilment, deliveryMode, deliveryZones, deliveryQuotePath }) {
  const waDigits = String(waNumber || '').replace(/\D/g, '');
  const lightProducts = products.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    price: p.price,
    category: p.category,
    availability: p.availability,
    hasPhoto: Boolean(p.image_data_url),
    // Chidera, 2026-09-17: "what if the whole order is taken on the site"
    // -- the same per-item question the bot used to only ask afterward in
    // chat (penne or spaghetti, room temp or cold), now asked right here
    // when the item's added. Empty for the (common) case a product has
    // none -- those items keep the exact same plain +/- stepper as before
    // this existed.
    questions: p.questions || [],
  }));
  // /photo/cover, not the raw data: URI -- same reasoning as a product's
  // own photo (routes/product-photo.js): a real, separate image request
  // instead of a blob embedded straight into this page's HTML. ?v= busts
  // any cache holding an older photo under this same path (see
  // coverPhotoVersion's own comment above).
  const headerStyle = coverPhotoVersion
    ? `position:relative;background-image:linear-gradient(180deg,rgba(28,24,21,.1),rgba(28,24,21,.88)),url('/photo/cover?v=${coverPhotoVersion}');background-size:cover;background-position:center`
    : 'position:relative';
  return `<!doctype html>
<html style="background:#F6F1E8"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>${escapeHtml(businessName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<!-- A normal stylesheet <link> blocks the very first paint until Google
     Fonts responds -- on a slow connection that's exactly the blank white
     flash Chidera 2026-09-10 flagged ("i have that 1 seconds first blank
     white load"). media="print" makes the browser fetch it in the
     background instead of blocking on it; the onload swap applies it the
     moment it's ready. Content already paints instantly on the system
     font either way (every element below has a real fallback stack), so
     nothing is ever left invisible waiting on this. -->
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap"></noscript>
<style>
  /* Paper, not white -- Chidera 2026-09-11: "i dont want to see any white
     atall" (a bad connection means the customer's own browser is what
     paints the gap before this page's content shows, e.g. WhatsApp's
     in-app browser's own blank tab while the page is still loading -- no
     amount of app-level loading state can cover that moment). The <html>
     tag's own inline style above sets this before even THIS stylesheet
     parses, so the very first paint is never plain white either. */
  :root{--paper:#F6F1E8;--ink:#1C1815;--mid:#6E6156;--line:#E2D9CB;--hot:#C5452B;--wa:#0F7A5A}
  *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
  html,body{height:100%;overflow:hidden;overscroll-behavior:none;background:#F6F1E8}
  body{display:flex;flex-direction:column;height:100vh;height:100dvh;font-family:"Inter",system-ui,sans-serif;background:#F6F1E8;color:var(--ink);line-height:1.5}
  .mtop{flex:0 0 auto;background:var(--ink);color:var(--paper);padding:12px 16px 10px;min-height:52px}
  .mtop.photo{padding:38px 16px 12px;min-height:120px;display:flex;flex-direction:column;justify-content:flex-end}
  .mtop .nm{font-family:"Fraunces",serif;font-size:19px;font-weight:700;line-height:1}
  .mtop .mt{font-size:11.5px;color:#B3A597;margin-top:3px}
  .scroll{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior-y:contain}
  .cats{position:sticky;top:0;background:#fff;display:flex;gap:7px;padding:11px 14px;overflow-x:auto;border-bottom:1px solid var(--line);z-index:3;-webkit-overflow-scrolling:touch}
  .cats::-webkit-scrollbar{display:none}
  .cats button{border:1px solid var(--line);background:#fff;color:var(--mid);font-family:inherit;font-size:12.5px;font-weight:500;white-space:nowrap;padding:6px 14px;border-radius:999px;touch-action:manipulation}
  .cats button.active{background:var(--ink);color:#fff;border-color:var(--ink)}
  .sec{padding:16px 14px 4px}
  .sec h2{font-family:"Fraunces",serif;font-size:17px;font-weight:600}
  .sec p{font-size:13px;color:var(--mid)}
  .grid{padding:8px 14px 20px}
  .item{border-bottom:1px solid #F0EBE2;padding-bottom:16px;margin-bottom:16px}
  .item:last-child{border-bottom:0}
  /* Chidera, 2026-09-16: "make photo size square" -- was a fixed 168px-tall
     WIDE box (roughly 2.4:1 on a phone), nowhere close to a typical food
     photo's own shape, so object-fit:cover had to crop away most of the
     frame to fill it -- a square source photo lost most of its top/bottom
     to fit. aspect-ratio:1/1 (a real square, matching what product photo
     uploads now crop to in imageUpload.js) instead of a fixed height means
     the box's actual size still scales with the card width, but the SHAPE
     always matches the shape the photo was actually cropped to. */
  .shot{width:100%;aspect-ratio:1/1;border-radius:10px;position:relative;overflow:hidden;display:grid;place-items:center;margin-bottom:10px;background-color:#8E5220}
  .shot img{width:100%;height:100%;object-fit:cover;display:block}
  .shot span{color:rgba(255,255,255,.75);font-size:10.5px;letter-spacing:.16em;border:1px solid rgba(255,255,255,.35);padding:4px 10px;border-radius:999px}
  .item h3{font-family:"Fraunces",serif;font-size:17px;font-weight:600;margin-bottom:3px}
  .item .d{font-size:13px;color:var(--mid);margin-bottom:9px;line-height:1.45}
  .ln{display:flex;align-items:center;gap:12px}
  .pr{font-weight:600;font-size:15.5px}
  .add{margin-left:auto;border:1px solid var(--hot);color:var(--hot);background:#fff;font-family:inherit;font-size:13px;font-weight:600;padding:7px 16px;border-radius:999px;touch-action:manipulation}
  .gone{margin-left:auto;font-size:12px;color:var(--mid);font-style:italic}
  .qty{margin-left:auto;display:flex;align-items:center;border:1px solid var(--hot);border-radius:999px;overflow:hidden}
  .qty button{background:#fff;color:var(--hot);border:0;font-family:inherit;font-size:16px;font-weight:700;width:32px;height:30px;line-height:1;touch-action:manipulation}
  .qty button:active{background:#f7e7e3}
  .qty .qn{min-width:22px;text-align:center;font-size:13px;font-weight:600;color:var(--ink)}
  .bask{flex:0 0 auto;background:var(--ink);color:#fff;padding:13px 15px;display:flex;align-items:center;gap:10px;font-size:13.5px}
  .bask .go{margin-left:auto;background:var(--wa);color:#fff;border:0;font-family:inherit;font-weight:600;font-size:13px;padding:9px 16px;border-radius:999px;touch-action:manipulation}
  .bask #bc{touch-action:manipulation;text-decoration:underline;text-decoration-color:rgba(255,255,255,.35);text-underline-offset:3px}
  .backdrop{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:8}
  .sheet{position:fixed;left:0;right:0;bottom:0;background:#fff;border-radius:16px 16px 0 0;max-height:70vh;overflow-y:auto;z-index:9;padding:16px 16px calc(16px + env(safe-area-inset-bottom));box-shadow:0 -8px 24px rgba(0,0,0,.18)}
  .sheetHead{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
  .sheetHead h3{font-family:"Fraunces",serif;font-size:17px;font-weight:600}
  .sheetClose{background:none;border:0;font-size:22px;line-height:1;color:var(--mid);width:28px;height:28px;touch-action:manipulation}
  .sheetRow{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #F0EBE2}
  .sheetRow:last-child{border-bottom:0}
  .sheetRow .nm{flex:1;font-size:14px}
  .sheetRow .pr{font-size:13px;color:var(--mid);min-width:70px;text-align:right}
  .sheetEmpty{padding:24px 0;text-align:center;color:var(--mid);font-size:13px}
  .sheetGroupHead{font-family:"Fraunces",serif;font-size:13.5px;font-weight:600;color:var(--mid);padding:14px 0 4px}
  .sheetGroupHead:first-child{padding-top:2px}
  .fulToggle{flex:1;padding:12px;border-radius:10px;border:1px solid var(--line);background:#fff;font-family:inherit;font-size:14px;font-weight:600;color:var(--ink);touch-action:manipulation}
  .fulToggle.active{border-color:var(--hot);color:var(--hot)}
  .fld label{display:block;font-size:13px;color:var(--mid);margin-bottom:4px}
  .fld select,.fld textarea{width:100%;padding:12px;border-radius:10px;border:1px solid #E4DCCF;font-size:15px;box-sizing:border-box;font-family:inherit}
  /* Chidera, 2026-09-20: "that button that has confirm order at the
     bottom is too thin, i need it slightly bigger" -- every primary
     sheet button (Confirm order, Continue, Add to order, Save) was
     relying on the bare browser default button box, no real padding or
     font-size of its own. One shared class instead of four separate
     inline styles quietly drifting apart. */
  .primaryBtn{width:100%;padding:14px;border-radius:10px;border:0;background:var(--ink);color:#fff;font-family:inherit;font-size:15.5px;font-weight:600;touch-action:manipulation}
</style></head>
<body>
<div class="mtop${coverPhotoVersion ? ' photo' : ''}" style="${headerStyle}"><div class="nm">${escapeHtml(businessName)}</div><div class="mt">${escapeHtml(subtitle)}</div></div>
<div class="scroll">
  <div id="cats" class="cats"></div>
  <div id="sec" class="sec"></div>
  <div id="grid" class="grid"></div>
</div>
<div class="bask"><span id="bc">Nothing added yet</span><button class="go" id="go">Place order</button></div>
<div id="backdrop" class="backdrop" hidden></div>
<div id="sheet" class="sheet" hidden>
  <div class="sheetHead"><h3>Your order</h3><button id="sheetClose" class="sheetClose" aria-label="Close">&times;</button></div>
  <div id="sheetList"></div>
  <div id="sheetFulfil" hidden style="margin-top:14px;padding-top:14px;border-top:1px solid #F0EBE2;font-size:13.5px;color:var(--mid)"></div>
  <button id="sheetConfirm" class="primaryBtn" hidden style="margin-top:14px">Confirm order</button>
</div>
<div id="qSheet" class="sheet" hidden>
  <div class="sheetHead"><h3 id="qSheetTitle"></h3><button id="qSheetClose" class="sheetClose" aria-label="Close">&times;</button></div>
  <div id="qSheetBody"></div>
  <button id="qSheetAdd" class="primaryBtn" style="margin-top:12px">Add to order</button>
</div>
<div id="fulfilSheet" class="sheet" hidden>
  <div class="sheetHead"><h3>Delivery or pickup?</h3><button id="fulSheetClose" class="sheetClose" aria-label="Close">&times;</button></div>
  <div style="display:flex;gap:8px;margin-bottom:14px">
    <button id="fulPickup" class="fulToggle">Pickup</button>
    <button id="fulDelivery" class="fulToggle">Delivery</button>
  </div>
  <div id="fulDeliveryFields" hidden>
    <div id="fulZoneField" class="fld" hidden>
      <label>Delivery area</label>
      <select id="fulZone" style="margin-bottom:12px"></select>
    </div>
    <div class="fld">
      <label>Delivery address</label>
      <textarea id="fulAddress" rows="2"></textarea>
    </div>
    <div id="fulFeeCheckField" hidden>
      <button id="fulCheckFee" style="width:100%;margin-top:8px">Check delivery fee</button>
      <p id="fulFeeResult" style="font-size:13px;color:var(--mid);margin-top:8px"></p>
    </div>
  </div>
  <button id="fulContinue" class="primaryBtn" style="margin-top:12px">Continue</button>
</div>
<div id="nameSheet" class="sheet" hidden>
  <div class="sheetHead"><h3>What should we call you?</h3><button id="nameSheetClose" class="sheetClose" aria-label="Close">&times;</button></div>
  <p style="color:var(--mid);font-size:13px;margin:0 0 14px">So we can greet you by name next time.</p>
  <input id="nameInput" type="text" maxlength="100" placeholder="Your name" style="width:100%;padding:12px;border-radius:10px;border:1px solid #E4DCCF;font-size:15px;box-sizing:border-box">
  <p id="nameError" style="color:#C0392B;font-size:13px;margin:8px 0 0;display:none"></p>
  <button id="nameSave" class="primaryBtn" style="margin-top:12px">Save</button>
  <button id="nameSkip" style="width:100%;margin-top:8px;background:none;border:0;color:var(--mid);font-size:13px;padding:8px">Not now</button>
</div>
<div id="bdaySheet" class="sheet" hidden>
  <div class="sheetHead"><h3>When's your birthday?</h3><button id="bdaySheetClose" class="sheetClose" aria-label="Close">&times;</button></div>
  <p style="color:var(--mid);font-size:13px;margin:0 0 14px">We like to make it a little special when it comes around.</p>
  <input id="bdayInput" type="date" style="width:100%;padding:12px;border-radius:10px;border:1px solid #E4DCCF;font-size:15px;box-sizing:border-box">
  <p id="bdayError" style="color:#C0392B;font-size:13px;margin:8px 0 0;display:none"></p>
  <button id="bdaySave" class="primaryBtn" style="margin-top:12px">Save</button>
  <button id="bdaySkip" style="width:100%;margin-top:8px;background:none;border:0;color:var(--mid);font-size:13px;padding:8px">Not now</button>
</div>
<script>
const PRODUCTS = ${JSON.stringify(lightProducts)};
const INITIAL_CATEGORY = ${JSON.stringify(initialCategory || null)};
const PENDING_ORDER = ${JSON.stringify(pendingOrder)};
const REVIEW_PATH = ${JSON.stringify(reviewPath)};
// Joint dine-in, Stage 1: only ever set on the table-scoped page
// (routes/dinein-menu.js) -- POLL_PATH doubling as the "is this a shared
// table order" flag instead of a separate boolean, since the two are
// always the same fact (routes/menu-page.js's own /m/ page never passes
// either).
const POLL_PATH = ${JSON.stringify(pollPath || null)};
const BIRTHDAY_PATH = ${JSON.stringify(birthdayPath || null)};
const SHOW_BIRTHDAY_PROMPT = ${JSON.stringify(Boolean(showBirthdayPrompt))};
const NAME_PATH = ${JSON.stringify(namePath || null)};
const SHOW_NAME_PROMPT = ${JSON.stringify(Boolean(showNamePrompt))};
const WA_DIGITS = ${JSON.stringify(waDigits)};
const ASK_FULFILMENT = ${JSON.stringify(Boolean(askFulfilment))};
const DELIVERY_MODE = ${JSON.stringify(deliveryMode || null)};
const DELIVERY_ZONES = ${JSON.stringify(deliveryZones || [])};
const DELIVERY_QUOTE_PATH = ${JSON.stringify(deliveryQuotePath || null)};
// Restored from a reopened link exactly like the basket itself is above --
// same "how are they aware it's already decided, how do they change it"
// reasoning (Chidera 2026-09-10), just applied to delivery/pickup now.
let fulfilment = (PENDING_ORDER && PENDING_ORDER.fulfilment) || null;
// Chidera, 2026-09-17: "so if a person is pick 2 pasta itll have to ask
// for each + and if they picked 2 different a - will have to know for
// which" -- basket is keyed by product+answers together (JSON.stringify
// of the answers object as part of the key), not just product id. Two
// Pasta Alfredo with the SAME answer (both penne) land on the same key
// and just increment quantity, same as any plain item; two with
// DIFFERENT answers get two genuinely separate keys, each with its own
// quantity and its own "-" -- no ambiguity about which one a tap on "-"
// means, because there's no shared line to be ambiguous about. Items
// with no questions at all get answers: {} always, so they behave
// exactly as the single-line-per-product basket did before this existed.
function lineKey(productId, answers) { return productId + '::' + JSON.stringify(answers || {}); }
let basket = {}; // key -> { productId, quantity, answers, addedBy?, addedByLabel? }
// A guest reopening this link may already have an order sitting with us --
// pre-load it into the basket (steppers and all) instead of a page with no
// memory of it, so adjusting or removing something already pending is as
// direct as adding something new. Chidera 2026-09-10: "how are they aware
// that the first one is still pending... how can they remove as well?"
// Pulled out into its own function -- joint dine-in, Stage 1's poll (below)
// reuses this exact same load, not a second copy of it.
function loadPendingIntoBasket(pending) {
  const next = {};
  (pending && pending.items || []).forEach(function (i) {
    const answers = i.answers || {};
    next[lineKey(i.productId, answers)] = { productId: i.productId, quantity: i.quantity, answers: answers, addedBy: i.addedBy || null, addedByLabel: i.addedByLabel || null };
  });
  return next;
}
basket = loadPendingIntoBasket(PENDING_ORDER);
// Snapshot of the last basket state that actually came FROM the server --
// joint dine-in, Stage 1's poll only ever overwrites basket when it
// still matches this (i.e. nothing's been added/changed locally since),
// so another guest's own not-yet-submitted edits never get silently wiped
// by this guest's poll picking up what's already been confirmed.
let lastSyncedBasketJSON = JSON.stringify(basket);
// Opens straight on the requested category (the "Special offers" button
// links here with ?cat=) when the catalogue actually has it right now --
// falls back to the first category exactly as before otherwise, so a
// stale or mistyped link never lands on a blank tab.
let cur = (INITIAL_CATEGORY && PRODUCTS.some(function (p) { return (p.category || 'Menu') === INITIAL_CATEGORY; }))
  ? INITIAL_CATEGORY
  : ((PRODUCTS[0] && (PRODUCTS[0].category || 'Menu')) || 'Menu');

function naira(n) { return 'NGN ' + Number(n).toLocaleString(); }

function categories() {
  const set = [];
  for (const p of PRODUCTS) { const c = p.category || 'Menu'; if (!set.includes(c)) set.push(c); }
  return set;
}

function renderCats() {
  const cats = categories();
  document.getElementById('cats').innerHTML = cats.map(c =>
    '<button data-c="' + c + '" class="' + (c === cur ? 'active' : '') + '">' + c + '</button>'
  ).join('');
  document.querySelectorAll('#cats button').forEach(b => b.onclick = () => { cur = b.dataset.c; renderCats(); render(); });
}

function changeQty(key, delta, productId, answers) {
  const existing = basket[key];
  const nextQty = (existing ? existing.quantity : 0) + delta;
  if (nextQty <= 0) delete basket[key];
  // A brand-new line (no existing entry) has to take its answers from
  // whoever's calling this, not from a line that doesn't exist yet --
  // this used to silently drop them (always fell back to {}), so a
  // question-having item's real answers never actually reached the
  // server even though the basket KEY was already answer-aware.
  // addedBy/addedByLabel carried over from an existing line (a "+" on
  // something another guest already added stays theirs, not silently
  // reattributed) -- dropped entirely for a genuinely new line, since
  // there's no real attribution yet until the server assigns one on submit.
  else basket[key] = { productId: productId || (existing && existing.productId), quantity: nextQty, answers: existing ? existing.answers : (answers || {}), addedBy: existing ? existing.addedBy : null, addedByLabel: existing ? existing.addedByLabel : null };
  render();
  updateBasket();
  if (!document.getElementById('sheet').hidden) renderSheet();
}

function totalQtyFor(productId) {
  return Object.values(basket).filter(l => l.productId === productId).reduce((sum, l) => sum + l.quantity, 0);
}

// Chidera, 2026-09-17: "what if the whole order is taken on the site" --
// a product with real customization questions always opens qSheet to ask
// them (below), whether this is the first one added or another one --
// never a plain +/- stepper for these, since a bare "+" tap has no way to
// ask what this specific extra one should be. A product with no
// questions at all keeps the exact same +/- stepper as before any of
// this existed.
function render() {
  const list = PRODUCTS.filter(p => (p.category || 'Menu') === cur);
  document.getElementById('sec').innerHTML = '<h2>' + cur + '</h2>';
  document.getElementById('grid').innerHTML = list.map(p => {
    const shot = p.hasPhoto
      ? '<div class="shot"><img loading="lazy" decoding="async" src="/photo/' + p.id + '" alt=""></div>'
      : '<div class="shot"><span>' + p.name.toUpperCase() + '</span></div>';
    const hasQuestions = p.questions && p.questions.length > 0;
    // Chidera, 2026-09-20: "im tapping - to remove an already selected
    // order but its not removing it only wants me to add ... not working
    // for [items with a question], only drinks" -- a question-having
    // product only ever showed "Add"/"Add another" here, never a way to
    // remove one -- the only place that worked was the review sheet.
    // Exactly one distinct answer-line for this product is unambiguous
    // (there's only one thing "-" could possibly mean), so that case gets
    // a real minus right here too; two+ distinct lines stays "Add another"
    // only -- genuinely ambiguous which one "-" would mean without opening
    // the review sheet and picking the actual line.
    const ownLines = Object.keys(basket).filter(function (k) { return basket[k].productId === p.id; });
    const qty = hasQuestions ? totalQtyFor(p.id) : (basket[lineKey(p.id, {})] ? basket[lineKey(p.id, {})].quantity : 0);
    let control;
    if (!p.availability) {
      control = '<span class="gone">Out of stock</span>';
    } else if (hasQuestions && qty > 0 && ownLines.length === 1) {
      control = '<div class="qty"><button class="qm" data-key="' + escapeAttr(ownLines[0]) + '">\\u2212</button><span class="qn">' + qty + '</span><button class="add qask" data-id="' + p.id + '">+</button></div>';
    } else if (hasQuestions) {
      control = '<button class="add qask" data-id="' + p.id + '">' + (qty > 0 ? qty + ' added \\u00b7 Add another' : 'Add') + '</button>';
    } else {
      control = qty > 0
        ? '<div class="qty"><button class="qm" data-id="' + p.id + '">\\u2212</button><span class="qn">' + qty + '</span><button class="qp" data-id="' + p.id + '">+</button></div>'
        : '<button class="add" data-id="' + p.id + '">Add</button>';
    }
    return '<div class="item">' + shot +
      '<h3>' + p.name + '</h3>' +
      (p.description ? '<p class="d">' + p.description + '</p>' : '') +
      '<div class="ln"><span class="pr">' + naira(p.price) + '</span>' + control + '</div></div>';
  }).join('');
  document.querySelectorAll('.add:not(.qask)').forEach(b => b.onclick = () => changeQty(lineKey(b.dataset.id, {}), 1, b.dataset.id));
  document.querySelectorAll('.qask').forEach(b => b.onclick = () => openQuestionSheet(b.dataset.id));
  document.querySelectorAll('.grid .qp').forEach(b => b.onclick = () => changeQty(lineKey(b.dataset.id, {}), 1, b.dataset.id));
  // A question-having product's own single-line minus carries its real
  // lineKey directly (data-key) -- a no-question item's still carries a
  // bare product id (data-id), resolved to its lineKey(id, {}) same as
  // always.
  document.querySelectorAll('.grid .qm[data-key]').forEach(b => b.onclick = () => changeQty(b.dataset.key, -1));
  document.querySelectorAll('.grid .qm[data-id]').forEach(b => b.onclick = () => changeQty(lineKey(b.dataset.id, {}), -1));
}

function updateBasket() {
  const lines = Object.values(basket);
  const count = lines.reduce((a, l) => a + l.quantity, 0);
  const total = lines.reduce((sum, l) => {
    const p = PRODUCTS.find(p => p.id === l.productId);
    return sum + (p ? Number(p.price) * l.quantity : 0);
  }, 0);
  document.getElementById('bc').textContent = count ? count + ' item' + (count > 1 ? 's' : '') + ' \\u00b7 ' + naira(total) : 'Nothing added yet';
}

function escapeAttr(s) {
  return String(s || '').replace(/[&"<>]/g, function (c) { return { '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]; });
}

// Chidera, 2026-09-20: "let delivery/pickup details processing and details
// of food specification eg. cold or room temp be processes in the flow on
// the website to save cost" -- a customer who ordered by typing in the
// chat can already have a real basket line sitting here with NO answers
// yet (flow.js sends this same page's link instead of asking one Meta
// message per question now). true only when this product genuinely has
// questions this line hasn't answered yet -- never true for a plain item,
// and never true once every question's been answered.
function lineNeedsAnswer(line) {
  const p = PRODUCTS.find(function (pr) { return pr.id === line.productId; });
  if (!p || !p.questions.length) return false;
  return p.questions.some(function (q) { return !(line.answers && line.answers[q.id]); });
}
function firstUnansweredKey() {
  for (const key of Object.keys(basket)) {
    if (lineNeedsAnswer(basket[key])) return key;
  }
  return null;
}

// One question sheet, reused for whichever product's "Add"/"Add another"
// was just tapped -- collects a plain text answer per question (same
// free-text shape the bot's own AI extraction already accepts in chat,
// not a fixed multiple-choice list the product_question table has no
// structured options for), then adds (or merges into an identical
// existing line -- see lineKey's own comment) one unit.
// editingKey: set only when completing an EXISTING line that's missing its
// answer(s) (see lineNeedsAnswer above) -- Submit then replaces that same
// line in place (same quantity, its key changes to match the real
// answers) instead of adding a brand-new unit on top of it.
let qSheetProductId = null;
let qSheetEditingKey = null;
function openQuestionSheet(productId, editingKey) {
  hideAllSheets();
  qSheetProductId = productId;
  qSheetEditingKey = editingKey || null;
  const p = PRODUCTS.find(p => p.id === productId);
  if (!p) return;
  const existingAnswers = (editingKey && basket[editingKey] && basket[editingKey].answers) || {};
  document.getElementById('qSheetTitle').textContent = p.name;
  // Chidera, 2026-09-20: "should not be a text thing they should pick
  // from dropdown and still be able to write extra note(optional), so it
  // can be faster" -- a question with real options (set in Catalogue) now
  // gets a select plus a separate optional note field instead of one
  // free-text box; a question with none keeps the exact same free-text
  // input it always had. The stored answer is still just one plain
  // string either way (order_item_answer.answer) -- "Cold (extra ice)"
  // when a note was added, just the picked option when it wasn't.
  document.getElementById('qSheetBody').innerHTML = p.questions.map(function (q) {
    const existing = existingAnswers[q.id] || '';
    if (q.options && q.options.length) {
      // Best-effort split of a previously-saved "Option (note)" back into
      // its two fields when reopening an already-answered line -- a
      // stored answer that doesn't match this shape (e.g. saved back when
      // this question had no options yet) just leaves the note blank and
      // the dropdown unselected rather than guessing wrong.
      let selected = '';
      let note = '';
      const match = q.options.find(function (opt) { return existing === opt || existing.indexOf(opt + ' (') === 0; });
      if (match) {
        selected = match;
        note = existing.length > match.length ? existing.slice(match.length + 2, -1) : '';
      }
      const optionsHtml = '<option value="">Choose...</option>' + q.options.map(function (opt) {
        return '<option value="' + escapeAttr(opt) + '"' + (opt === selected ? ' selected' : '') + '>' + opt + '</option>';
      }).join('');
      return '<div style="margin-bottom:12px">' +
        '<label style="display:block;font-size:13px;color:var(--mid);margin-bottom:4px">' + q.question + '</label>' +
        '<select data-qid="' + q.id + '" style="width:100%;padding:10px;border-radius:8px;border:1px solid #E4DCCF;font-size:15px;box-sizing:border-box;margin-bottom:6px">' + optionsHtml + '</select>' +
        '<input data-note-qid="' + q.id + '" value="' + escapeAttr(note) + '" placeholder="Extra note (optional)" style="width:100%;padding:10px;border-radius:8px;border:1px solid #E4DCCF;font-size:14px;box-sizing:border-box">' +
        '</div>';
    }
    return '<div style="margin-bottom:12px">' +
      '<label style="display:block;font-size:13px;color:var(--mid);margin-bottom:4px">' + q.question + '</label>' +
      '<input data-qid="' + q.id + '" value="' + escapeAttr(existing) + '" style="width:100%;padding:10px;border-radius:8px;border:1px solid #E4DCCF;font-size:15px;box-sizing:border-box">' +
      '</div>';
  }).join('');
  document.getElementById('backdrop').hidden = false;
  document.getElementById('qSheet').hidden = false;
}
function closeQuestionSheet() {
  document.getElementById('backdrop').hidden = true;
  document.getElementById('qSheet').hidden = true;
  qSheetProductId = null;
  qSheetEditingKey = null;
}
document.getElementById('qSheetClose').onclick = closeQuestionSheet;
document.getElementById('qSheetAdd').onclick = () => {
  if (!qSheetProductId) return;
  const fields = document.querySelectorAll('#qSheetBody [data-qid]');
  const answers = {};
  for (const field of fields) {
    const val = field.value.trim();
    if (!val) { field.focus(); return; } // every question needs an answer before adding, same as the bot would insist on in chat
    const noteField = document.querySelector('[data-note-qid="' + field.dataset.qid + '"]');
    const note = noteField ? noteField.value.trim() : '';
    answers[field.dataset.qid] = note ? (val + ' (' + note + ')') : val;
  }
  if (qSheetEditingKey) {
    const existing = basket[qSheetEditingKey];
    const key = lineKey(qSheetProductId, answers);
    delete basket[qSheetEditingKey];
    basket[key] = { productId: qSheetProductId, quantity: existing ? existing.quantity : 1, answers: answers, addedBy: existing ? existing.addedBy : null, addedByLabel: existing ? existing.addedByLabel : null };
    render();
    updateBasket();
    if (!document.getElementById('sheet').hidden) renderSheet();
  } else {
    changeQty(lineKey(qSheetProductId, answers), 1, qSheetProductId, answers);
  }
  closeQuestionSheet();
};

// Delivery/pickup step -- opened by "Place order" itself (below) the first
// time, not shown inline on the page, same "sheet, not permanent page
// clutter" pattern as the basket review and question sheets above. Own-
// riders businesses get a real dropdown of actual zone names/fees (no
// guessing, unlike the WhatsApp path's text match) ON TOP OF the address
// field, not instead of it -- the zone only decides the area/price, a
// rider still needs the actual street/house address to find, same as
// engine/delivery.js's ownRidersDelivery, which stores customer.address
// as the delivery's own destination regardless of provider. Found via a
// real run-through, 2026-09-17: picking a zone alone left customer.address
// null, so missingFulfilmentFields (fields.js) kept seeing "delivery_
// address" as outstanding and re-asked for it anyway -- silently
// re-opening exactly the WhatsApp gate this feature exists to close.
// Everyone else (chowdeck/manual) just gets the address field with a live
// fee check, no zone dropdown at all.
function openFulfilSheet() {
  hideAllSheets();
  const isDelivery = fulfilment && fulfilment.type === 'delivery';
  document.getElementById('fulPickup').classList.toggle('active', fulfilment && fulfilment.type === 'pickup');
  document.getElementById('fulDelivery').classList.toggle('active', isDelivery);
  document.getElementById('fulDeliveryFields').hidden = !isDelivery;
  document.getElementById('fulAddress').value = (isDelivery && fulfilment.address) || '';
  if (DELIVERY_MODE === 'own_riders') {
    document.getElementById('fulZoneField').hidden = false;
    document.getElementById('fulFeeCheckField').hidden = true;
    const zoneSelect = document.getElementById('fulZone');
    if (!zoneSelect.options.length) {
      zoneSelect.innerHTML = '<option value="">Choose your area...</option>' +
        DELIVERY_ZONES.map(function (z) { return '<option value="' + z.id + '">' + z.name + ' \\u00b7 ' + naira(z.customer_fee) + '</option>'; }).join('');
    }
    zoneSelect.value = (isDelivery && fulfilment.zoneId) || '';
  } else {
    document.getElementById('fulZoneField').hidden = true;
    document.getElementById('fulFeeCheckField').hidden = false;
    document.getElementById('fulFeeResult').textContent = '';
  }
  document.getElementById('backdrop').hidden = false;
  document.getElementById('fulfilSheet').hidden = false;
}
function closeFulfilSheet() {
  document.getElementById('backdrop').hidden = true;
  document.getElementById('fulfilSheet').hidden = true;
}
document.getElementById('fulSheetClose').onclick = closeFulfilSheet;
document.getElementById('fulPickup').onclick = function () {
  fulfilment = { type: 'pickup' };
  document.getElementById('fulPickup').classList.add('active');
  document.getElementById('fulDelivery').classList.remove('active');
  document.getElementById('fulDeliveryFields').hidden = true;
};
document.getElementById('fulDelivery').onclick = function () {
  fulfilment = { type: 'delivery' };
  document.getElementById('fulDelivery').classList.add('active');
  document.getElementById('fulPickup').classList.remove('active');
  document.getElementById('fulDeliveryFields').hidden = false;
};
document.getElementById('fulCheckFee').onclick = async function () {
  const address = document.getElementById('fulAddress').value.trim();
  if (!address) { document.getElementById('fulFeeResult').textContent = 'Please enter an address first.'; return; }
  const btn = document.getElementById('fulCheckFee');
  btn.textContent = 'Checking...';
  try {
    const res = await fetch(DELIVERY_QUOTE_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: address }) });
    const data = await res.json();
    const fee = Number(data.fee) || 0;
    document.getElementById('fulFeeResult').textContent = fee > 0 ? ('Delivery fee: ' + naira(fee)) : 'Delivery fee will be confirmed with you.';
  } catch (err) {
    document.getElementById('fulFeeResult').textContent = 'Could not check the fee right now. You can still continue.';
  }
  btn.textContent = 'Check delivery fee';
};
// Whichever function was waiting on this decision (submitOrder, below) --
// set right before openFulfilSheet() opens, run once Continue is tapped.
let afterFulfilment = null;
document.getElementById('fulContinue').onclick = function () {
  if (!fulfilment || !fulfilment.type) { alert('Please choose delivery or pickup.'); return; }
  if (fulfilment.type === 'delivery') {
    const address = document.getElementById('fulAddress').value.trim();
    if (!address) { alert('Please enter your delivery address.'); return; }
    if (DELIVERY_MODE === 'own_riders') {
      const zoneId = document.getElementById('fulZone').value;
      if (!zoneId) { alert('Please choose your delivery area.'); return; }
      fulfilment = { type: 'delivery', zoneId: zoneId, address: address };
    } else {
      fulfilment = { type: 'delivery', address: address };
    }
  }
  fulfilmentConfirmed = true;
  closeFulfilSheet();
  const run = afterFulfilment;
  afterFulfilment = null;
  if (run) run();
};

// A full itemized list lives here, opened by tapping the basket summary,
// instead of inline on the page -- Chidera 2026-09-10: "if it list that
// will only make that bulky, let there be like a footer they can tap to
// see the list and adjust it directly from there". Reuses changeQty, so
// adjusting a quantity here and adjusting it in the main grid are the
// exact same action either way -- always in sync, nothing to reconcile.
// Each distinct answer combination is its own row here now, labelled with
// its own answers, so "which one does - remove" is never ambiguous --
// every row only ever affects itself.
function sheetRowHtml(key, line) {
  const p = PRODUCTS.find(p => p.id === line.productId);
  if (!p) return '';
  const needsAnswer = lineNeedsAnswer(line);
  const answerText = Object.values(line.answers || {}).join(', ');
  // needsAnswer -- Chidera, 2026-09-20: a line that arrived here already
  // in the basket but never answered (typed in chat, then sent here to
  // finish up) gets a clear "needs an answer" callout instead of looking
  // like any other already-settled line -- tapping it reopens its own
  // question sheet, pre-filled with whatever it already has.
  const label = p.name + (needsAnswer ? ' \\u2014 needs an answer' : (answerText ? ' (' + answerText + ')' : ''));
  const rowStyle = needsAnswer ? ' style="color:var(--hot);cursor:pointer"' : '';
  return '<div class="sheetRow"' + (needsAnswer ? ' data-needs-answer-key="' + escapeAttr(key) + '"' : '') + '>' +
    '<span class="nm"' + rowStyle + '>' + label + '</span>' +
    '<div class="qty"><button class="qm" data-key="' + escapeAttr(key) + '">\\u2212</button><span class="qn">' + line.quantity + '</span><button class="qp" data-key="' + escapeAttr(key) + '">+</button></div>' +
    '<span class="pr">' + naira(p.price * line.quantity) + '</span></div>';
}

function renderSheet() {
  const entries = Object.entries(basket);
  const list = document.getElementById('sheetList');
  if (!entries.length) {
    list.innerHTML = '<p class="sheetEmpty">Nothing added yet.</p>';
    renderSheetFulfil();
    return;
  }
  // Joint dine-in, Stage 1 (only ever true on the shared table page,
  // POLL_PATH is set): Chidera, 2026-09-20: "the meals there are meant to
  // show and be classified by the names of people on the table and what
  // they picked" -- grouped by who added each line, not a flat list with
  // a name tagged onto each row. 'You' always sorts first; a line this
  // guest just added locally has no addedByLabel synced from the server
  // yet, which also correctly falls under 'You' (it's obviously theirs).
  // The general (non-dine-in) page keeps the exact same flat list as
  // always -- there's only ever one person's own order there, nothing to
  // group by.
  if (POLL_PATH) {
    const groups = new Map();
    for (const [key, line] of entries) {
      const label = line.addedByLabel || 'You';
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push([key, line]);
    }
    const orderedLabels = [...groups.keys()].sort((a, b) => (a === 'You' ? -1 : b === 'You' ? 1 : a.localeCompare(b)));
    list.innerHTML = orderedLabels.map((label) =>
      '<div class="sheetGroupHead">' + label + '</div>' + groups.get(label).map(([key, line]) => sheetRowHtml(key, line)).join('')
    ).join('');
  } else {
    list.innerHTML = entries.map(([key, line]) => sheetRowHtml(key, line)).join('');
  }
  list.querySelectorAll('.qp').forEach(b => b.onclick = () => changeQty(b.dataset.key, 1));
  list.querySelectorAll('.qm').forEach(b => b.onclick = () => changeQty(b.dataset.key, -1));
  list.querySelectorAll('[data-needs-answer-key]').forEach(function (el) {
    el.onclick = function () {
      const key = el.dataset.needsAnswerKey;
      const line = basket[key];
      if (line) openQuestionSheet(line.productId, key);
    };
  });
  renderSheetFulfil();
}

// Chidera, 2026-09-17: "lets think, ... could be on the site right? ...
// lets keep thinking but keep that" -- the same basket sheet doubles as
// the final review now: delivery/pickup (or a prompt to choose it, if
// this sheet was opened before that) plus a real Confirm button, so
// tapping Confirm here really is the informed final word this feature
// was meant to make WhatsApp's own yes/no gate unnecessary for. Only
// shown at all on the general-ordering route (ASK_FULFILMENT) -- dine-in
// never had a confirm gate to replace in the first place (payment_mode
// 'at_table' places the order immediately either way, see flow.js's
// handleCollectFulfilment), so its own basket sheet stays exactly what it
// always was: a plain editable list, no fulfilment section, no button.
function renderSheetFulfil() {
  const fulEl = document.getElementById('sheetFulfil');
  const confirmBtn = document.getElementById('sheetConfirm');
  if (!ASK_FULFILMENT) { fulEl.hidden = true; confirmBtn.hidden = true; return; }
  fulEl.hidden = false;
  confirmBtn.hidden = false;
  if (!fulfilment || !fulfilment.type) {
    fulEl.innerHTML = '<button id="sheetFulfilEdit" class="add">Choose delivery or pickup</button>';
    document.getElementById('sheetFulfilEdit').onclick = function () { afterFulfilment = openSheet; openFulfilSheet(); };
    return;
  }
  let line;
  if (fulfilment.type === 'pickup') {
    line = 'Pickup';
  } else if (DELIVERY_MODE === 'own_riders' && fulfilment.zoneId) {
    const zone = DELIVERY_ZONES.find(function (z) { return z.id === fulfilment.zoneId; });
    const zoneLine = zone ? (zone.name + ' \\u00b7 ' + naira(zone.customer_fee)) : 'Delivery';
    line = 'Delivery to ' + zoneLine + (fulfilment.address ? (' (' + fulfilment.address + ')') : '');
  } else {
    line = fulfilment.address ? ('Delivery to: ' + fulfilment.address) : 'Delivery';
  }
  fulEl.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px">' +
    '<span>' + line + '</span>' +
    '<button id="sheetFulfilEdit" style="background:none;border:0;color:var(--hot);font-family:inherit;font-size:13px;font-weight:600;padding:4px 0;flex:0 0 auto">Change</button></div>';
  document.getElementById('sheetFulfilEdit').onclick = function () { afterFulfilment = openSheet; openFulfilSheet(); };
}

function hideAllSheets() {
  ['sheet', 'qSheet', 'fulfilSheet', 'bdaySheet', 'nameSheet'].forEach(function (id) { document.getElementById(id).hidden = true; });
}

function openSheet() {
  hideAllSheets();
  renderSheet();
  document.getElementById('backdrop').hidden = false;
  document.getElementById('sheet').hidden = false;
}
function closeSheet() {
  document.getElementById('backdrop').hidden = true;
  document.getElementById('sheet').hidden = true;
}
document.getElementById('bc').onclick = openSheet;
document.getElementById('sheetClose').onclick = closeSheet;
document.getElementById('sheetConfirm').onclick = submitOrder;

// Chidera, 2026-09-17: "the birthday pop up is meant to be on the
// customers website they place others not the staff dashboard" -- schema.sql's
// own crm_config migration already said this ("filled in via the...
// popup on an order's own page"), so it lives here, not on the staff
// dashboard's order detail page. Reuses the same #backdrop/.sheet
// pattern as the basket review above for one consistent visual
// language, not a second kind of popup on the same page.
function openBdaySheet() {
  hideAllSheets();
  document.getElementById('backdrop').hidden = false;
  document.getElementById('bdaySheet').hidden = false;
}
function closeBdaySheet() {
  document.getElementById('backdrop').hidden = true;
  document.getElementById('bdaySheet').hidden = true;
}
document.getElementById('bdaySheetClose').onclick = closeBdaySheet;
document.getElementById('bdaySkip').onclick = closeBdaySheet;
// Chidera, 2026-09-20: "if a person has put their birthday before, why
// does it keep asking over and over" -- this used to silently close the
// sheet either way, so a failed save (or a date input that never got a
// value -- some WhatsApp in-app browsers don't render the native date
// picker) looked identical to a real one: no error, sheet just closed,
// customer.birthday stayed null, and SHOW_BIRTHDAY_PROMPT (server-side,
// !customer.birthday) asked again next visit with no way to tell why.
document.getElementById('bdaySave').onclick = async () => {
  const errEl = document.getElementById('bdayError');
  errEl.style.display = 'none';
  const value = document.getElementById('bdayInput').value;
  if (!value) { errEl.textContent = 'Please pick a date.'; errEl.style.display = 'block'; return; }
  try {
    const res = await fetch(BIRTHDAY_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ birthday: value }) });
    if (!res.ok) throw new Error('save failed');
    closeBdaySheet();
  } catch (err) {
    errEl.textContent = "Couldn't save that. Please try again.";
    errEl.style.display = 'block';
  }
};

// Chidera, 2026-09-20: "we agreed a name so bot can refer to customer" --
// same shape as the birthday popup just above (own error handling per
// the same "why does it keep asking" lesson, applied from the start
// rather than found live a second time). afterNamePrompt (set just
// before this opens, in the sequencing block at the bottom) is what runs
// next -- the birthday prompt when that's also due, otherwise nothing.
let afterNamePrompt = null;
function openNameSheet() {
  hideAllSheets();
  document.getElementById('backdrop').hidden = false;
  document.getElementById('nameSheet').hidden = false;
}
function closeNameSheet() {
  document.getElementById('backdrop').hidden = true;
  document.getElementById('nameSheet').hidden = true;
  if (afterNamePrompt) { const next = afterNamePrompt; afterNamePrompt = null; next(); }
}
document.getElementById('nameSheetClose').onclick = closeNameSheet;
document.getElementById('nameSkip').onclick = closeNameSheet;
document.getElementById('nameSave').onclick = async () => {
  const errEl = document.getElementById('nameError');
  errEl.style.display = 'none';
  const value = document.getElementById('nameInput').value.trim();
  if (!value) { errEl.textContent = 'Please enter a name.'; errEl.style.display = 'block'; return; }
  try {
    const res = await fetch(NAME_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: value }) });
    if (!res.ok) throw new Error('save failed');
    closeNameSheet();
  } catch (err) {
    errEl.textContent = "Couldn't save that. Please try again.";
    errEl.style.display = 'block';
  }
};

document.getElementById('backdrop').onclick = () => {
  if (!document.getElementById('nameSheet').hidden) closeNameSheet();
  else if (!document.getElementById('bdaySheet').hidden) closeBdaySheet();
  else if (!document.getElementById('qSheet').hidden) closeQuestionSheet();
  else if (!document.getElementById('fulfilSheet').hidden) closeFulfilSheet();
  else closeSheet();
};

async function submitOrder() {
  const items = Object.values(basket).map(function (l) { return { productId: l.productId, quantity: l.quantity, answers: l.answers || {}, addedBy: l.addedBy || null }; });
  if (!items.length) { document.getElementById('bc').textContent = 'Add something first'; return; }
  // Whichever button is actually visible right now -- the bottom bar for
  // dine-in's own unchanged one-tap flow, the sheet's own Confirm button
  // for the general-ordering review flow above.
  const goBtn = ASK_FULFILMENT ? document.getElementById('sheetConfirm') : document.getElementById('go');
  const originalLabel = goBtn.textContent;
  goBtn.textContent = 'Sending...';
  const payload = { items: items };
  if (ASK_FULFILMENT && fulfilment) payload.fulfilment = fulfilment;
  // A dropped connection right at the tap (Chidera 2026-09-11, right after
  // a "just white on bad network" complaint) used to fail this fetch with
  // nothing shown at all -- no alert, button just sitting there looking
  // unresponsive. Always ends in either the "Order sent!" screen below or a
  // visible alert now, never silence.
  let res, data;
  try {
    res = await fetch(REVIEW_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    data = await res.json();
  } catch (err) {
    goBtn.textContent = originalLabel;
    alert('Could not reach the connection. Please check your network and try again.');
    return;
  }
  if (!res.ok) { goBtn.textContent = originalLabel; alert(data.error || 'Something went wrong.'); return; }
  document.body.innerHTML = '<div style="padding:60px 20px;text-align:center;font-family:Inter,sans-serif;"><h2 style="font-family:Fraunces,serif;">Order sent!</h2><p style="color:#6E6156;margin-top:8px;">Taking you back to the chat\\u2026</p></div>';
  // Hands the guest straight back to the WhatsApp thread instead of
  // leaving them stranded on this page -- wa.me is what WhatsApp's own
  // in-app browser intercepts and swaps back to the chat for.
  if (WA_DIGITS) setTimeout(function () { window.location.href = 'https://wa.me/' + WA_DIGITS; }, 900);
}

// Chidera, 2026-09-17: "why is it restoring previous delivery choice? it
// can only ask if theya re using same deliver or like an auto fill thing
// cause people may have different delivery" -- a reopened link's old
// fulfilment pre-fills the sheet (openFulfilSheet already does this) so a
// repeat choice is a single tap, but it must never be silently reused
// without a real chance to change it, since a different order can
// genuinely go somewhere else. fulfilmentConfirmed (not the fulfilment
// value itself) is what actually gates the sheet -- true only once THIS page
// load has been through it once, so a pre-loaded fulfilment from
// PENDING_ORDER still shows the sheet the first time "Place order" is
// tapped, pre-filled, editable. Only skips on a second tap within the
// same load, after they've already confirmed or changed it once.
let fulfilmentConfirmed = false;
// Chidera, 2026-09-17: "full review before submit... making the WhatsApp
// confirm yes/no unnecessary." "Place order" no longer submits directly
// on the general-ordering route -- it opens the same itemized sheet the
// basket bar always opened, now also showing the delivery/pickup choice
// and ending in a real "Confirm order" button (renderSheetFulfil,
// above), so submitOrder only ever runs after the customer has actually
// seen everything: items, answers, delivery/pickup, and (implicitly, via
// the basket total) the price. flow.js's finishItemsCollection then skips
// the WhatsApp yes/no ask for exactly this reason. Dine-in (ASK_FULFILMENT
// false) never had a yes/no gate to replace -- ordering stays the
// original single tap, unchanged.
document.getElementById('go').onclick = () => {
  if (!Object.keys(basket).length) { document.getElementById('bc').textContent = 'Add something first'; return; }
  if (!ASK_FULFILMENT) { submitOrder(); return; }
  if (!fulfilmentConfirmed) {
    afterFulfilment = openSheet;
    openFulfilSheet();
    return;
  }
  openSheet();
};

renderCats();
render();
updateBasket();
// Chidera, 2026-09-20: name prompt takes priority over birthday (asked
// first, "so bot can refer to customer" is the more fundamental of the
// two), which in turn takes priority over the unanswered-question/
// pending-order sheet -- same ambient-signal reasoning as before, just a
// three-deep queue now instead of two. Only one sheet is ever on screen
// at once (hideAllSheets), so each prompt closing (Save or Not now) is
// what hands off to the next one due, via afterNamePrompt.
function showAfterPrompts() {
  if (SHOW_BIRTHDAY_PROMPT) {
    openBdaySheet();
    // A guest reopening this link may already have an order sitting with
    // us -- basket is already pre-loaded from it above, and the basket
    // bar itself (never "Nothing added yet" when that's true) is the
    // ambient signal; opening the sheet once, right away, is what
    // actually answers "how do I know" and "how do I remove it" without
    // any always-on inline list.
    return;
  }
  // Chidera, 2026-09-20: a chat-originated order sent here specifically to
  // finish up (flow.js's finishItemsCollection now links here instead of
  // asking one item-question at a time in chat) needs that question
  // actually surfaced the moment the page opens, not left sitting as an
  // easy-to-miss line in a sheet nobody necessarily opens -- same ambient-
  // signal reasoning as the birthday prompt and the pending-order sheet
  // just above, just higher priority than the plain review (an unanswered
  // question is the one thing actively blocking the order from going
  // anywhere).
  const unansweredKey = firstUnansweredKey();
  if (unansweredKey) {
    openQuestionSheet(basket[unansweredKey].productId, unansweredKey);
  } else if (PENDING_ORDER && PENDING_ORDER.items && PENDING_ORDER.items.length) {
    openSheet();
  }
}
if (SHOW_NAME_PROMPT) {
  afterNamePrompt = showAfterPrompts;
  openNameSheet();
} else {
  showAfterPrompts();
}

// Joint dine-in, Stage 1: "let everyone on that table... see each other."
// 15s poll (same interval InHouse.jsx/Delivery.jsx already use, no new
// infra) picking up what OTHER guests have added -- but only applied when
// this guest's own basket still matches lastSyncedBasketJSON, i.e. they
// haven't added or changed anything locally since the last sync. A guest
// mid-add always wins their own screen; the next poll (15s later, likely
// after they've submitted) picks up cleanly once they're back in sync.
if (POLL_PATH) {
  setInterval(async function () {
    let data;
    try {
      const res = await fetch(POLL_PATH);
      if (!res.ok) return;
      data = await res.json();
    } catch (err) {
      return; // a dropped connection here is silently skipped, same as any other poll -- there's always another one in 15s
    }
    if (JSON.stringify(basket) !== lastSyncedBasketJSON) return; // local unsynced edits in progress -- don't clobber them
    basket = loadPendingIntoBasket(data.pendingOrder);
    lastSyncedBasketJSON = JSON.stringify(basket);
    render();
    updateBasket();
    if (!document.getElementById('sheet').hidden) renderSheet();
  }, 15000);
}
</script>
</body></html>`;
}

export function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Joint dine-in, Stage 2-3: where the "Ready to pay" WhatsApp button
// (flow.js's notifyGuestsReadyToPay) actually lands -- deliberately a
// separate, simpler page from renderMenuPage above, not a mode of it: no
// ordering grid, no basket to build, just "here's the bill, here's who
// owes what, here's how to settle it." Same visual language (paper
// background, Fraunces/Inter, --hot accent) so it doesn't feel like a
// different app mid-flow.
//
// Stage 3: "they can choose pay together or split payment so each pay
// their own... they can pick whose bill too can be joint" -- the tapping
// guest checks off who they're paying for (themselves always included,
// pre-checked and locked), sees a live subtotal as they check others,
// and requests a POS amount for exactly that group. No Paystack link
// anywhere here -- the guest pays a real POS terminal, and Moniepoint's
// webhook (engine/webhook-moniepoint.js, matchPosTransactionToPayment)
// auto-confirms the match; this page polls every 15s (same pattern as
// the shared order page's own poll) so "Payment confirmed!" shows up
// live without a manual refresh. The existing dashboard "Mark paid"
// button stays as a real fallback (cash, or anything that doesn't
// reconcile automatically) -- never removed.
export function renderPayPage({ businessName, tableLabel, coverPhotoVersion, status, statusPath, createPath, posTransfer = null }) {
  const headerStyle = coverPhotoVersion
    ? `position:relative;background-image:linear-gradient(180deg,rgba(28,24,21,.1),rgba(28,24,21,.88)),url('/photo/cover?v=${coverPhotoVersion}');background-size:cover;background-position:center`
    : 'position:relative';
  return `<!doctype html>
<html style="background:#F6F1E8"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>${escapeHtml(businessName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap"></noscript>
<style>
  :root{--paper:#F6F1E8;--ink:#1C1815;--mid:#6E6156;--line:#E2D9CB;--hot:#C5452B;--ok:#0F7A5A}
  *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
  html,body{height:100%;background:#F6F1E8}
  body{font-family:"Inter",system-ui,sans-serif;color:var(--ink);line-height:1.5;padding-bottom:calc(24px + env(safe-area-inset-bottom))}
  .top{background:var(--ink);color:var(--paper);padding:38px 20px 20px;${headerStyle}}
  .top .nm{font-family:"Fraunces",serif;font-size:21px;font-weight:700}
  .top .mt{font-size:12.5px;color:#B3A597;margin-top:4px}
  .card{margin:16px;background:#fff;border-radius:14px;padding:18px;border:1px solid var(--line)}
  .card h3{font-family:"Fraunces",serif;font-size:15px;font-weight:600;margin-bottom:10px}
  .row{display:flex;justify-content:space-between;gap:12px;font-size:14px;padding:7px 0;border-bottom:1px solid #F0EBE2}
  .row:last-child{border-bottom:0}
  .row .who{color:var(--mid);font-size:12px}
  .itemGroupHead{font-family:"Fraunces",serif;font-size:13px;font-weight:600;color:var(--mid);padding:10px 0 2px}
  .itemGroupHead:first-child{padding-top:0}
  .tot{display:flex;justify-content:space-between;margin-top:10px;padding-top:10px;border-top:2px solid var(--ink);font-family:"Fraunces",serif;font-size:19px;font-weight:700}
  .guest{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #F0EBE2;font-size:14px}
  .guest:last-child{border-bottom:0}
  .guest input{width:18px;height:18px;accent-color:var(--hot)}
  .sub{display:flex;justify-content:space-between;margin-top:12px;padding-top:10px;border-top:1px solid var(--line);font-size:14.5px;font-weight:600}
  .primaryBtn{width:100%;margin-top:12px;background:var(--hot);color:#fff;border:0;font-family:inherit;font-weight:600;font-size:14.5px;padding:12px;border-radius:999px;touch-action:manipulation}
  .secondaryBtn{width:100%;margin-top:10px;background:#fff;color:var(--ink);border:1px solid var(--line);font-family:inherit;font-weight:600;font-size:14.5px;padding:12px;border-radius:999px;touch-action:manipulation}
  .payChoice{display:flex;gap:10px;margin-top:14px}
  .payChoice button{flex:1;margin-top:0}
  .transferBox{text-align:left;margin-top:14px;background:#F6F1E8;border-radius:10px;padding:14px;font-size:13.5px}
  .transferBox .row{border-bottom:0;padding:4px 0}
  .payAmount{text-align:center;margin:16px;background:#fff;border-radius:14px;padding:20px;border:1px solid var(--line)}
  .payAmount .big{font-family:"Fraunces",serif;font-size:28px;font-weight:700;margin:6px 0}
  .badge{font-size:11.5px;font-weight:600;padding:3px 9px;border-radius:999px}
  .badge.pending{background:#FBEFE3;color:#B5651D}
  .badge.confirmed{background:#E1F3EA;color:var(--ok)}
  .note{margin:0 16px 16px;background:#fff;border-radius:14px;padding:16px;border:1px solid var(--line);font-size:13.5px;color:var(--mid);line-height:1.55}
  .note b{color:var(--ink)}
  .done{margin:16px;background:var(--ok);color:#fff;border-radius:14px;padding:18px;text-align:center;font-family:"Fraunces",serif;font-size:17px;font-weight:700}
</style></head>
<body>
<div class="top">
  <div class="nm">${escapeHtml(businessName)}</div>
  <div class="mt">Table ${escapeHtml(tableLabel)} · Ready to pay</div>
</div>
<div id="doneBanner" class="done" hidden>All paid up. Thank you!</div>
<div id="mainContent">
  <div class="card" id="itemsCard"></div>
  <div class="card" id="guestsCard">
    <h3>Who are you paying for?</h3>
    <div id="guestList"></div>
    <div class="sub"><span>Selected subtotal</span><span id="subtotal"></span></div>
    <button id="requestBtn" class="primaryBtn">Request payment amount</button>
  </div>
  <div id="amountCard" class="payAmount" hidden>
    <div style="color:var(--mid);font-size:13px" id="amountHint">Please pay this amount at the counter or on the POS terminal</div>
    <div class="big" id="amountValue"></div>
    <div style="color:var(--mid);font-size:12.5px" id="amountSub">We'll confirm automatically the moment it clears.</div>
    <div class="payChoice" id="payChoice" hidden>
      <button id="payTransferBtn" class="secondaryBtn">Transfer</button>
      <button id="payCardBtn" class="secondaryBtn">Tap card</button>
    </div>
    <div class="transferBox" id="transferBox" hidden></div>
  </div>
  <div class="card" id="paymentsCard" hidden>
    <h3>Payments so far</h3>
    <div id="paymentsList"></div>
  </div>
</div>
<div class="note"><b>Already paid for something else?</b> If you'd like to add more before paying, just message us on WhatsApp.</div>
<script>
const STATUS_PATH = ${JSON.stringify(statusPath)};
const CREATE_PATH = ${JSON.stringify(createPath)};
const POS_TRANSFER = ${JSON.stringify(posTransfer)};
let status = ${JSON.stringify(status)};
let selected = new Set([status.selfId]);

function naira(n) { return 'NGN ' + Number(n).toLocaleString(); }

function render() {
  if (status.completed) {
    document.getElementById('doneBanner').hidden = false;
    document.getElementById('mainContent').hidden = true;
    return;
  }
  // Chidera, 2026-09-20: "let that web only show all they have ordered
  // so far per person name not menu" -- grouped under each guest's own
  // name (You first), same as the ordering page's own review sheet, not
  // a flat list with a name tagged onto each row.
  const itemGroups = new Map();
  for (const i of status.items) {
    const label = i.addedByLabel || 'a guest';
    if (!itemGroups.has(label)) itemGroups.set(label, []);
    itemGroups.get(label).push(i);
  }
  const orderedItemLabels = [...itemGroups.keys()].sort((a, b) => (a === 'You' ? -1 : b === 'You' ? 1 : a.localeCompare(b)));
  document.getElementById('itemsCard').innerHTML = orderedItemLabels.map(function (label) {
    return '<div class="itemGroupHead">' + label + '</div>' + itemGroups.get(label).map(function (i) {
      return '<div class="row"><span>' + i.quantity + 'x ' + i.name + '</span><span>' + naira(i.price * i.quantity) + '</span></div>';
    }).join('');
  }).join('') + '<div class="tot"><span>Table total</span><span>' + naira(status.total) + '</span></div>';

  document.getElementById('guestList').innerHTML = status.guests.map(function (g) {
    const isSelf = g.id === status.selfId;
    return '<label class="guest"><input type="checkbox" data-guest="' + g.id + '" ' + (selected.has(g.id) ? 'checked' : '') + ' ' + (isSelf ? 'disabled' : '') + '>' + g.label + '</label>';
  }).join('');
  document.querySelectorAll('[data-guest]').forEach(function (el) {
    el.onchange = function () {
      if (el.checked) selected.add(el.dataset.guest); else selected.delete(el.dataset.guest);
      updateSubtotal();
    };
  });
  updateSubtotal();

  if (status.payments.length) {
    document.getElementById('paymentsCard').hidden = false;
    document.getElementById('paymentsList').innerHTML = status.payments.map(function (p) {
      return '<div class="row"><span>' + p.coversLabel + '</span><span><span class="badge ' + p.status + '">' + (p.status === 'confirmed' ? 'Paid' : 'Pending') + '</span> ' + naira(p.amount) + '</span></div>';
    }).join('');
  }
}

function updateSubtotal() {
  const sum = status.items.filter(function (i) { return selected.has(i.addedBy); }).reduce(function (s, i) { return s + i.price * i.quantity; }, 0);
  document.getElementById('subtotal').textContent = naira(sum);
}

document.getElementById('requestBtn').onclick = async () => {
  const btn = document.getElementById('requestBtn');
  const original = btn.textContent;
  btn.textContent = 'Requesting...';
  try {
    const res = await fetch(CREATE_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ guestIds: [...selected] }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    document.getElementById('amountValue').textContent = naira(data.amount);
    document.getElementById('amountCard').hidden = false;
    document.getElementById('guestsCard').hidden = true;
    // Chidera, 2026-09-20: "i want them to be able to pick transfer or
    // card, transfer will give them number on pos while card the bot just
    // waits to auto confirm payment" -- both land as the same real
    // Moniepoint transaction either way (createOrderPayment already made
    // one pending amount to match against), this choice only changes
    // which instructions the guest sees.
    if (POS_TRANSFER) {
      document.getElementById('amountHint').textContent = 'How would you like to pay?';
      document.getElementById('amountSub').hidden = true;
      document.getElementById('payChoice').hidden = false;
    }
  } catch (err) {
    alert(err.message || 'Could not request a payment amount. Please try again.');
  } finally {
    btn.textContent = original;
  }
};

if (POS_TRANSFER) {
  document.getElementById('payTransferBtn').onclick = () => {
    document.getElementById('payChoice').hidden = true;
    document.getElementById('transferBox').hidden = false;
    document.getElementById('transferBox').innerHTML =
      '<div class="row"><span>Bank</span><span>' + POS_TRANSFER.bankName + '</span></div>' +
      '<div class="row"><span>Account number</span><span>' + POS_TRANSFER.accountNumber + '</span></div>' +
      '<div class="row"><span>Account name</span><span>' + POS_TRANSFER.accountName + '</span></div>';
    document.getElementById('amountSub').hidden = false;
    document.getElementById('amountSub').textContent = "We'll confirm automatically the moment it clears. No need to send proof.";
  };
  document.getElementById('payCardBtn').onclick = () => {
    document.getElementById('payChoice').hidden = true;
    document.getElementById('transferBox').hidden = false;
    document.getElementById('transferBox').innerHTML = '<div class="row"><span>Tap your card on our POS terminal for this amount.</span></div>';
    document.getElementById('amountSub').hidden = false;
    document.getElementById('amountSub').textContent = "We'll confirm automatically the moment it clears.";
  };
}

render();

// Same 15s-poll pattern as the shared order page (Stage 1) -- so
// "Payment confirmed!" (or another guest's own payment showing up) never
// needs a manual refresh to notice.
setInterval(async function () {
  try {
    const res = await fetch(STATUS_PATH);
    if (!res.ok) return;
    status = await res.json();
    render();
  } catch (err) {
    // a dropped connection here is silently skipped -- there's always another poll in 15s
  }
}, 15000);
</script>
</body></html>`;
}

// Chidera, 2026-09-20: "when pos is selected the whole thing will still be
// inside the web na, for dine in it can be where the shared order ready to
// pay lives... make it 'ready to pay? click here'." A single online order
// never needs the guest-selection step renderPayPage has (there's only
// ever one customer paying, for the whole order) -- straight to the
// Transfer/Card choice instead. Same visual language, same auto-confirm
// mechanism (order_payment + matchPosTransactionToPayment), reached via
// routes/menu-page.js's /:token/pay.
export function renderSingleOrderPayPage({ businessName, amount, confirmed, posTransfer, statusPath }) {
  return `<!doctype html>
<html style="background:#F6F1E8"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>${escapeHtml(businessName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap"></noscript>
<style>
  :root{--paper:#F6F1E8;--ink:#1C1815;--mid:#6E6156;--line:#E2D9CB;--hot:#C5452B;--ok:#0F7A5A}
  *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
  html,body{height:100%;background:#F6F1E8}
  body{font-family:"Inter",system-ui,sans-serif;color:var(--ink);line-height:1.5;padding-bottom:calc(24px + env(safe-area-inset-bottom))}
  .top{background:var(--ink);color:var(--paper);padding:38px 20px 20px}
  .top .nm{font-family:"Fraunces",serif;font-size:21px;font-weight:700}
  .top .mt{font-size:12.5px;color:#B3A597;margin-top:4px}
  .payAmount{text-align:center;margin:16px;background:#fff;border-radius:14px;padding:20px;border:1px solid var(--line)}
  .payAmount .big{font-family:"Fraunces",serif;font-size:28px;font-weight:700;margin:6px 0}
  .secondaryBtn{width:100%;margin-top:10px;background:#fff;color:var(--ink);border:1px solid var(--line);font-family:inherit;font-weight:600;font-size:14.5px;padding:12px;border-radius:999px;touch-action:manipulation}
  .payChoice{display:flex;gap:10px;margin-top:14px}
  .payChoice button{flex:1;margin-top:0}
  .transferBox{text-align:left;margin-top:14px;background:#F6F1E8;border-radius:10px;padding:14px;font-size:13.5px}
  .transferBox .row{display:flex;justify-content:space-between;gap:12px;padding:4px 0}
  .done{margin:16px;background:var(--ok);color:#fff;border-radius:14px;padding:18px;text-align:center;font-family:"Fraunces",serif;font-size:17px;font-weight:700}
</style></head>
<body>
<div class="top">
  <div class="nm">${escapeHtml(businessName)}</div>
  <div class="mt">Ready to pay</div>
</div>
<div id="doneBanner" class="done" ${confirmed ? '' : 'hidden'}>Payment confirmed. Thank you!</div>
<div id="amountCard" class="payAmount" ${confirmed ? 'hidden' : ''}>
  <div style="color:var(--mid);font-size:13px" id="amountHint">${posTransfer ? 'How would you like to pay?' : 'Please pay this amount at the counter or on the POS terminal'}</div>
  <div class="big">NGN ${Number(amount).toLocaleString()}</div>
  <div style="color:var(--mid);font-size:12.5px" id="amountSub" ${posTransfer ? 'hidden' : ''}>We'll confirm automatically the moment it clears.</div>
  ${posTransfer ? `<div class="payChoice" id="payChoice"><button id="payTransferBtn" class="secondaryBtn">Transfer</button><button id="payCardBtn" class="secondaryBtn">Tap card</button></div>` : ''}
  <div class="transferBox" id="transferBox" hidden></div>
</div>
<script>
const STATUS_PATH = ${JSON.stringify(statusPath)};
const POS_TRANSFER = ${JSON.stringify(posTransfer)};

if (POS_TRANSFER) {
  document.getElementById('payTransferBtn').onclick = function () {
    document.getElementById('payChoice').hidden = true;
    document.getElementById('transferBox').hidden = false;
    document.getElementById('transferBox').innerHTML =
      '<div class="row"><span>Bank</span><span>' + POS_TRANSFER.bankName + '</span></div>' +
      '<div class="row"><span>Account number</span><span>' + POS_TRANSFER.accountNumber + '</span></div>' +
      '<div class="row"><span>Account name</span><span>' + POS_TRANSFER.accountName + '</span></div>';
    document.getElementById('amountSub').hidden = false;
    document.getElementById('amountSub').textContent = "We'll confirm automatically the moment it clears. No need to send proof.";
  };
  document.getElementById('payCardBtn').onclick = function () {
    document.getElementById('payChoice').hidden = true;
    document.getElementById('transferBox').hidden = false;
    document.getElementById('transferBox').innerHTML = '<div class="row"><span>Tap your card on our POS terminal for this amount.</span></div>';
    document.getElementById('amountSub').hidden = false;
    document.getElementById('amountSub').textContent = "We'll confirm automatically the moment it clears.";
  };
}

// Same 15s-poll pattern as dine-in's own pay page -- "Payment confirmed!"
// never needs a manual refresh to notice.
setInterval(async function () {
  try {
    const res = await fetch(STATUS_PATH);
    if (!res.ok) return;
    const status = await res.json();
    if (status.confirmed) {
      document.getElementById('doneBanner').hidden = false;
      document.getElementById('amountCard').hidden = true;
    }
  } catch (err) {
    // a dropped connection here is silently skipped -- there's always another poll in 15s
  }
}, 15000);
</script>
</body></html>`;
}
