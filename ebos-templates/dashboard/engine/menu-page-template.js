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
export function renderMenuPage({ reviewPath, birthdayPath, showBirthdayPrompt, businessName, subtitle, coverPhotoVersion, waNumber, products, pendingOrder, initialCategory }) {
  const waDigits = String(waNumber || '').replace(/\D/g, '');
  const lightProducts = products.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    price: p.price,
    category: p.category,
    availability: p.availability,
    hasPhoto: Boolean(p.image_data_url),
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
</div>
<div id="bdaySheet" class="sheet" hidden>
  <div class="sheetHead"><h3>When's your birthday?</h3><button id="bdaySheetClose" class="sheetClose" aria-label="Close">&times;</button></div>
  <p style="color:var(--mid);font-size:13px;margin:0 0 14px">We like to make it a little special when it comes around.</p>
  <input id="bdayInput" type="date" style="width:100%;padding:12px;border-radius:10px;border:1px solid #E4DCCF;font-size:15px;box-sizing:border-box">
  <button id="bdaySave" style="width:100%;margin-top:12px">Save</button>
  <button id="bdaySkip" style="width:100%;margin-top:8px;background:none;border:0;color:var(--mid);font-size:13px;padding:8px">Not now</button>
</div>
<script>
const PRODUCTS = ${JSON.stringify(lightProducts)};
const INITIAL_CATEGORY = ${JSON.stringify(initialCategory || null)};
const PENDING_ORDER = ${JSON.stringify(pendingOrder)};
const REVIEW_PATH = ${JSON.stringify(reviewPath)};
const BIRTHDAY_PATH = ${JSON.stringify(birthdayPath || null)};
const SHOW_BIRTHDAY_PROMPT = ${JSON.stringify(Boolean(showBirthdayPrompt))};
const WA_DIGITS = ${JSON.stringify(waDigits)};
let basket = {};
if (PENDING_ORDER && PENDING_ORDER.items) {
  // A guest reopening this link may already have an order sitting with us
  // -- pre-load it into the basket (steppers and all) instead of a page
  // with no memory of it, so adjusting or removing something already
  // pending is as direct as adding something new. Chidera 2026-09-10:
  // "how are they aware that the first one is still pending... how can
  // they remove as well?"
  PENDING_ORDER.items.forEach(function (i) { basket[i.productId] = i.quantity; });
}
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

function changeQty(id, delta) {
  const next = (basket[id] || 0) + delta;
  if (next <= 0) delete basket[id]; else basket[id] = next;
  render();
  updateBasket();
  if (!document.getElementById('sheet').hidden) renderSheet();
}

function render() {
  const list = PRODUCTS.filter(p => (p.category || 'Menu') === cur);
  document.getElementById('sec').innerHTML = '<h2>' + cur + '</h2>';
  document.getElementById('grid').innerHTML = list.map(p => {
    const shot = p.hasPhoto
      ? '<div class="shot"><img loading="lazy" decoding="async" src="/photo/' + p.id + '" alt=""></div>'
      : '<div class="shot"><span>' + p.name.toUpperCase() + '</span></div>';
    const qty = basket[p.id] || 0;
    const control = !p.availability
      ? '<span class="gone">Out of stock</span>'
      : qty > 0
        ? '<div class="qty"><button class="qm" data-id="' + p.id + '">\\u2212</button><span class="qn">' + qty + '</span><button class="qp" data-id="' + p.id + '">+</button></div>'
        : '<button class="add" data-id="' + p.id + '">Add</button>';
    return '<div class="item">' + shot +
      '<h3>' + p.name + '</h3>' +
      (p.description ? '<p class="d">' + p.description + '</p>' : '') +
      '<div class="ln"><span class="pr">' + naira(p.price) + '</span>' + control + '</div></div>';
  }).join('');
  document.querySelectorAll('.add').forEach(b => b.onclick = () => changeQty(b.dataset.id, 1));
  document.querySelectorAll('.qp').forEach(b => b.onclick = () => changeQty(b.dataset.id, 1));
  document.querySelectorAll('.qm').forEach(b => b.onclick = () => changeQty(b.dataset.id, -1));
}

function updateBasket() {
  const count = Object.values(basket).reduce((a, b) => a + b, 0);
  const total = Object.entries(basket).reduce((sum, [id, qty]) => {
    const p = PRODUCTS.find(p => p.id === id);
    return sum + (p ? Number(p.price) * qty : 0);
  }, 0);
  document.getElementById('bc').textContent = count ? count + ' item' + (count > 1 ? 's' : '') + ' \\u00b7 ' + naira(total) : 'Nothing added yet';
}

// A full itemized list lives here, opened by tapping the basket summary,
// instead of inline on the page -- Chidera 2026-09-10: "if it list that
// will only make that bulky, let there be like a footer they can tap to
// see the list and adjust it directly from there". Reuses changeQty, so
// adjusting a quantity here and adjusting it in the main grid are the
// exact same action either way -- always in sync, nothing to reconcile.
function renderSheet() {
  const entries = Object.entries(basket);
  const list = document.getElementById('sheetList');
  if (!entries.length) {
    list.innerHTML = '<p class="sheetEmpty">Nothing added yet.</p>';
    return;
  }
  list.innerHTML = entries.map(([id, qty]) => {
    const p = PRODUCTS.find(p => p.id === id);
    if (!p) return '';
    return '<div class="sheetRow"><span class="nm">' + p.name + '</span>' +
      '<div class="qty"><button class="qm" data-id="' + id + '">\\u2212</button><span class="qn">' + qty + '</span><button class="qp" data-id="' + id + '">+</button></div>' +
      '<span class="pr">' + naira(p.price * qty) + '</span></div>';
  }).join('');
  list.querySelectorAll('.qp').forEach(b => b.onclick = () => changeQty(b.dataset.id, 1));
  list.querySelectorAll('.qm').forEach(b => b.onclick = () => changeQty(b.dataset.id, -1));
}

function openSheet() {
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

// Chidera, 2026-09-17: "the birthday pop up is meant to be on the
// customers website they place others not the staff dashboard" -- schema.sql's
// own crm_config migration already said this ("filled in via the...
// popup on an order's own page"), so it lives here, not on the staff
// dashboard's order detail page. Reuses the same #backdrop/.sheet
// pattern as the basket review above for one consistent visual
// language, not a second kind of popup on the same page.
function openBdaySheet() {
  document.getElementById('backdrop').hidden = false;
  document.getElementById('bdaySheet').hidden = false;
}
function closeBdaySheet() {
  document.getElementById('backdrop').hidden = true;
  document.getElementById('bdaySheet').hidden = true;
}
document.getElementById('bdaySheetClose').onclick = closeBdaySheet;
document.getElementById('bdaySkip').onclick = closeBdaySheet;
document.getElementById('bdaySave').onclick = async () => {
  const value = document.getElementById('bdayInput').value;
  if (!value) return;
  try {
    await fetch(BIRTHDAY_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ birthday: value }) });
  } catch (err) {
    // Silent -- this is a nice-to-have, not something worth blocking or
    // alarming a guest mid-order over if their connection hiccups.
  }
  closeBdaySheet();
};
document.getElementById('backdrop').onclick = () => {
  if (!document.getElementById('bdaySheet').hidden) closeBdaySheet();
  else closeSheet();
};

document.getElementById('go').onclick = async () => {
  const items = Object.entries(basket).map(([productId, quantity]) => ({ productId, quantity }));
  if (!items.length) { document.getElementById('bc').textContent = 'Add something first'; return; }
  const goBtn = document.getElementById('go');
  const originalLabel = goBtn.textContent;
  goBtn.textContent = 'Sending...';
  // A dropped connection right at the tap (Chidera 2026-09-11, right after
  // a "just white on bad network" complaint) used to fail this fetch with
  // nothing shown at all -- no alert, button just sitting there looking
  // unresponsive. Always ends in either the "Order sent!" screen below or a
  // visible alert now, never silence.
  let res, data;
  try {
    res = await fetch(REVIEW_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
    data = await res.json();
  } catch (err) {
    goBtn.textContent = originalLabel;
    alert('Could not reach the connection -- please check your network and try again.');
    return;
  }
  if (!res.ok) { goBtn.textContent = originalLabel; alert(data.error || 'Something went wrong.'); return; }
  document.body.innerHTML = '<div style="padding:60px 20px;text-align:center;font-family:Inter,sans-serif;"><h2 style="font-family:Fraunces,serif;">Order sent!</h2><p style="color:#6E6156;margin-top:8px;">Taking you back to the chat\\u2026</p></div>';
  // Hands the guest straight back to the WhatsApp thread instead of
  // leaving them stranded on this page -- wa.me is what WhatsApp's own
  // in-app browser intercepts and swaps back to the chat for.
  if (WA_DIGITS) setTimeout(function () { window.location.href = 'https://wa.me/' + WA_DIGITS; }, 900);
};

renderCats();
render();
updateBasket();
if (SHOW_BIRTHDAY_PROMPT) openBdaySheet();
// A guest reopening this link may already have an order sitting with us --
// basket is already pre-loaded from it above, and the basket bar itself
// (never "Nothing added yet" when that's true) is the ambient signal;
// opening the sheet once, right away, is what actually answers "how do I
// know" and "how do I remove it" without any always-on inline list.
if (PENDING_ORDER && PENDING_ORDER.items && PENDING_ORDER.items.length) openSheet();
</script>
</body></html>`;
}

export function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
