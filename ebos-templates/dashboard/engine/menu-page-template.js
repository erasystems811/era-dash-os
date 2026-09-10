// Shared HTML for the web menu page -- used by both routes/dinein-menu.js
// (table-scoped, GET /t/:qrToken) and routes/menu-page.js (general
// ordering, GET /m/:token). Same page either way, just a different way of
// knowing who's looking at it and where "Review order" posts to. Styling
// matches the reference demo (Downloads/EBOS-Web-Menu-Demo.html,
// Chidera 2026-09-10) -- Fraunces/Inter, warm paper background, pill
// buttons -- not the plainer first pass this replaced.
export function renderMenuPage({ reviewPath, businessName, subtitle, products }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>${escapeHtml(businessName)}</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{--paper:#F6F1E8;--ink:#1C1815;--mid:#6E6156;--line:#E2D9CB;--hot:#C5452B;--wa:#0F7A5A}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:"Inter",system-ui,sans-serif;background:#fff;color:var(--ink);line-height:1.5;padding-bottom:80px}
  .mtop{background:var(--ink);color:var(--paper);padding:20px 16px 16px}
  .mtop .nm{font-family:"Fraunces",serif;font-size:24px;font-weight:700;line-height:1}
  .mtop .mt{font-size:12px;color:#B3A597;margin-top:5px}
  .cats{position:sticky;top:0;background:#fff;display:flex;gap:7px;padding:11px 14px;overflow-x:auto;border-bottom:1px solid var(--line);z-index:3}
  .cats::-webkit-scrollbar{display:none}
  .cats button{border:1px solid var(--line);background:#fff;color:var(--mid);font-family:inherit;font-size:12.5px;font-weight:500;white-space:nowrap;padding:6px 14px;border-radius:999px}
  .cats button.active{background:var(--ink);color:#fff;border-color:var(--ink)}
  .sec{padding:16px 14px 4px}
  .sec h2{font-family:"Fraunces",serif;font-size:17px;font-weight:600}
  .grid{padding:8px 14px 20px}
  .item{border-bottom:1px solid #F0EBE2;padding-bottom:16px;margin-bottom:16px}
  .item:last-child{border-bottom:0}
  .shot{width:100%;height:168px;border-radius:10px;position:relative;overflow:hidden;background-size:cover;background-position:center;display:grid;place-items:center;margin-bottom:10px;background-color:#8E5220}
  .shot span{color:rgba(255,255,255,.75);font-size:10.5px;letter-spacing:.16em;border:1px solid rgba(255,255,255,.35);padding:4px 10px;border-radius:999px}
  .item h3{font-family:"Fraunces",serif;font-size:17px;font-weight:600;margin-bottom:3px}
  .item .d{font-size:13px;color:var(--mid);margin-bottom:9px;line-height:1.45}
  .ln{display:flex;align-items:center;gap:12px}
  .pr{font-weight:600;font-size:15.5px}
  .add{margin-left:auto;border:1px solid var(--hot);color:var(--hot);background:#fff;font-family:inherit;font-size:13px;font-weight:600;padding:7px 16px;border-radius:999px}
  .add.in{background:var(--hot);color:#fff}
  .gone{margin-left:auto;font-size:12px;color:var(--mid);font-style:italic}
  .bask{position:fixed;bottom:0;left:0;right:0;background:var(--ink);color:#fff;padding:13px 15px;display:flex;align-items:center;gap:10px;font-size:13.5px}
  .bask .go{margin-left:auto;background:var(--wa);color:#fff;border:0;font-family:inherit;font-weight:600;font-size:13px;padding:9px 16px;border-radius:999px}
  .err{padding:12px 16px;background:#fdecea;color:#611}
</style></head>
<body>
<div class="mtop"><div class="nm">${escapeHtml(businessName)}</div><div class="mt">${escapeHtml(subtitle)}</div></div>
<div id="cats" class="cats"></div>
<div id="sec" class="sec"></div>
<div id="grid" class="grid"></div>
<div class="bask"><span id="bc">Nothing added yet</span><button class="go" id="go">Review order</button></div>
<script>
const PRODUCTS = ${JSON.stringify(products)};
const REVIEW_PATH = ${JSON.stringify(reviewPath)};
let basket = {};
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

function render() {
  const list = PRODUCTS.filter(p => (p.category || 'Menu') === cur);
  document.getElementById('sec').innerHTML = '<h2>' + cur + '</h2>';
  document.getElementById('grid').innerHTML = list.map(p => {
    const shot = p.image_data_url
      ? '<div class="shot" style="background-image:url(\\'' + p.image_data_url + '\\')"></div>'
      : '<div class="shot"><span>' + p.name.toUpperCase() + '</span></div>';
    const added = basket[p.id];
    return '<div class="item">' + shot +
      '<h3>' + p.name + '</h3>' +
      (p.description ? '<p class="d">' + p.description + '</p>' : '') +
      '<div class="ln"><span class="pr">' + naira(p.price) + '</span>' +
      (p.availability
        ? '<button class="add' + (added ? ' in' : '') + '" data-id="' + p.id + '">' + (added ? 'Added (' + added + ')' : 'Add') + '</button>'
        : '<span class="gone">finished for today</span>') +
      '</div></div>';
  }).join('');
  document.querySelectorAll('.add').forEach(b => b.onclick = () => { basket[b.dataset.id] = (basket[b.dataset.id] || 0) + 1; render(); updateBasket(); });
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
  document.body.innerHTML = '<div style="padding:60px 20px;text-align:center;font-family:Inter,sans-serif;"><h2 style="font-family:Fraunces,serif;">Order sent!</h2><p style="color:#6E6156;margin-top:8px;">Check WhatsApp to confirm it.</p></div>';
};

renderCats();
render();
updateBasket();
</script>
</body></html>`;
}

export function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
