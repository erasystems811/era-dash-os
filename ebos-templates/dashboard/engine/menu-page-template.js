// Shared HTML for the web menu page -- used by both routes/dinein-menu.js
// (table-scoped, GET /t/:qrToken) and routes/menu-page.js (general
// ordering, GET /m/:token). Same page either way, just a different way of
// knowing who's looking at it and where "Review order" posts to. Styling
// matches the reference demo (Downloads/EBOS-Web-Menu-Demo.html,
// Chidera 2026-09-10) -- Fraunces/Inter, warm paper background, pill
// buttons -- not the plainer first pass this replaced.
//
// coverPhotoUrl: business.cover_photo_data_url (Settings > Branding) --
// null falls back to the plain dark header, same as before this existed.
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
export function renderMenuPage({ reviewPath, businessName, subtitle, coverPhotoUrl, waNumber, products, pendingOrder }) {
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
  const headerStyle = coverPhotoUrl
    ? ` style="background-image:linear-gradient(180deg,rgba(28,24,21,.1),rgba(28,24,21,.88)),url('${coverPhotoUrl.replace(/'/g, '%27')}');background-size:cover;background-position:center"`
    : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>${escapeHtml(businessName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{--paper:#F6F1E8;--ink:#1C1815;--mid:#6E6156;--line:#E2D9CB;--hot:#C5452B;--wa:#0F7A5A}
  *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
  html,body{height:100%;overflow:hidden;overscroll-behavior:none}
  body{display:flex;flex-direction:column;height:100vh;height:100dvh;font-family:"Inter",system-ui,sans-serif;background:#fff;color:var(--ink);line-height:1.5}
  .mtop{flex:0 0 auto;background:var(--ink);color:var(--paper);padding:20px 16px 16px;min-height:78px}
  .mtop.photo{padding:76px 16px 18px;min-height:190px;display:flex;flex-direction:column;justify-content:flex-end}
  .mtop .nm{font-family:"Fraunces",serif;font-size:24px;font-weight:700;line-height:1}
  .mtop .mt{font-size:12px;color:#B3A597;margin-top:5px}
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
  .shot{width:100%;height:168px;border-radius:10px;position:relative;overflow:hidden;display:grid;place-items:center;margin-bottom:10px;background-color:#8E5220}
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
  .pending{margin:12px 14px 0;padding:10px 12px;background:#FBF3E7;border:1px solid #EAD9B8;border-radius:10px;font-size:12.5px;color:var(--ink);line-height:1.4}
  .pending b{font-weight:600}
</style></head>
<body>
<div class="mtop${coverPhotoUrl ? ' photo' : ''}"${headerStyle}><div class="nm">${escapeHtml(businessName)}</div><div class="mt">${escapeHtml(subtitle)}</div></div>
<div class="scroll">
  <div id="cats" class="cats"></div>
  <div id="pending" class="pending" hidden></div>
  <div id="sec" class="sec"></div>
  <div id="grid" class="grid"></div>
</div>
<div class="bask"><span id="bc">Nothing added yet</span><button class="go" id="go">Review order</button></div>
<script>
const PRODUCTS = ${JSON.stringify(lightProducts)};
const PENDING_ORDER = ${JSON.stringify(pendingOrder)};
const REVIEW_PATH = ${JSON.stringify(reviewPath)};
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
let cur = (PRODUCTS[0] && (PRODUCTS[0].category || 'Menu')) || 'Menu';

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
      ? '<span class="gone">finished for today</span>'
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

document.getElementById('go').onclick = async () => {
  const items = Object.entries(basket).map(([productId, quantity]) => ({ productId, quantity }));
  if (!items.length) { document.getElementById('bc').textContent = 'Add something first'; return; }
  const res = await fetch(REVIEW_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Something went wrong.'); return; }
  document.body.innerHTML = '<div style="padding:60px 20px;text-align:center;font-family:Inter,sans-serif;"><h2 style="font-family:Fraunces,serif;">Order sent!</h2><p style="color:#6E6156;margin-top:8px;">Taking you back to the chat\\u2026</p></div>';
  // Hands the guest straight back to the WhatsApp thread instead of
  // leaving them stranded on this page -- wa.me is what WhatsApp's own
  // in-app browser intercepts and swaps back to the chat for.
  if (WA_DIGITS) setTimeout(function () { window.location.href = 'https://wa.me/' + WA_DIGITS; }, 900);
};

if (PENDING_ORDER && PENDING_ORDER.items && PENDING_ORDER.items.length) {
  const pendingEl = document.getElementById('pending');
  const count = PENDING_ORDER.items.reduce(function (s, i) { return s + i.quantity; }, 0);
  pendingEl.innerHTML = 'You already have <b>' + count + ' item' + (count > 1 ? 's' : '') + '</b> pending (' + naira(PENDING_ORDER.total) + ') &mdash; shown below. Adjust or add more, then tap Review order.';
  pendingEl.hidden = false;
}
renderCats();
render();
updateBasket();
</script>
</body></html>`;
}

export function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
