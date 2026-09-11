// Shared HTML shell for the customer's own delivery tracking page
// (routes/tracking.js). Restyled to match the web menu page's own
// app-shell look (engine/menu-page-template.js) -- same paper background,
// same fonts, same "never plain white" discipline -- Chidera 2026-09-11:
// "make that delivery tracking link be an in app web page too", right
// after the same complaint about the menu page. Polls its own JSON status
// endpoint in place instead of the old <meta http-equiv="refresh"> full
// page reload every 20s -- a hard reload flashing the browser chrome back
// in is exactly what reads as "a website", not an app.
export function renderTrackingPage({ reference, businessName, zoneName, stages, stageIndex, rider, expired, failed, statusPath }) {
  return `<!doctype html>
<html style="background:#F6F1E8"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>Tracking ${escapeHtml(reference)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap"></noscript>
<style>
  :root{--paper:#F6F1E8;--ink:#1C1815;--mid:#6E6156;--line:#E2D9CB;--hot:#C5452B;--wa:#0F7A5A}
  *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
  html,body{height:100%;overflow:hidden;overscroll-behavior:none;background:#F6F1E8}
  body{display:flex;flex-direction:column;height:100vh;height:100dvh;font-family:"Inter",system-ui,sans-serif;background:var(--paper);color:var(--ink);line-height:1.5}
  .mtop{flex:0 0 auto;background:var(--ink);color:var(--paper);padding:16px 16px 14px;min-height:56px}
  .mtop .nm{font-family:"Fraunces",serif;font-size:19px;font-weight:700;line-height:1}
  .mtop .mt{font-size:11.5px;color:#B3A597;margin-top:4px}
  .scroll{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior-y:contain;padding:20px 16px calc(20px + env(safe-area-inset-bottom))}
  .stages{list-style:none}
  .stages li{display:flex;align-items:center;gap:12px;padding:11px 0;color:var(--mid);font-size:14px;transition:color .25s}
  .stages li.done{color:var(--ink)}
  .stages li.current{color:var(--hot);font-weight:600}
  .dot{width:24px;height:24px;border-radius:50%;border:2px solid var(--line);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:13px;transition:all .25s}
  .stages li.done .dot{border-color:var(--ink);background:var(--ink);color:var(--paper)}
  .stages li.current .dot{border-color:var(--hot);background:var(--hot);color:#fff}
  .rider{display:flex;align-items:center;gap:12px;padding:16px 14px;margin-top:16px;background:#fff;border-radius:12px;border:1px solid var(--line)}
  .rider .avatar{width:44px;height:44px;border-radius:50%;background:var(--ink);color:var(--paper);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;font-family:"Fraunces",serif;flex-shrink:0}
  .rider a{color:inherit}
  .empty{text-align:center;color:var(--mid);font-size:13.5px;margin-top:60px;padding:0 20px}
  .updated{text-align:center;color:var(--mid);font-size:11.5px;margin-top:22px}
</style></head>
<body>
<div class="mtop"><div class="nm">${escapeHtml(businessName)}</div><div class="mt">Order ${escapeHtml(reference)}${zoneName ? ` &middot; ${escapeHtml(zoneName)}` : ''}</div></div>
<div class="scroll" id="scroll">${trackingBody({ stages, stageIndex, rider, expired, failed })}</div>
<script>
const STATUS_PATH = ${JSON.stringify(statusPath)};
const STAGES = ${JSON.stringify(stages)};
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function renderBody(d) {
  if (d.expired) return '<div class="empty">This tracking link has expired.</div>';
  if (d.failed) return '<div class="empty">This delivery could not be completed. Please contact us.</div>';
  var stagesHtml = STAGES.map(function (s, i) {
    var cls = i < d.stageIndex ? 'done' : i === d.stageIndex ? 'current' : '';
    return '<li class="' + cls + '"><span class="dot">' + (i < d.stageIndex ? '\\u2713' : (i + 1)) + '</span> ' + esc(s) + '</li>';
  }).join('');
  var riderHtml = d.rider
    ? '<div class="rider"><div class="avatar">' + esc(d.rider.name[0]) + '</div><div><div><strong>' + esc(d.rider.name.split(' ')[0]) + '</strong></div><div><a href="tel:' + esc(d.rider.phone) + '">' + esc(d.rider.phone) + '</a></div></div></div>'
    : '';
  return '<ul class="stages">' + stagesHtml + '</ul>' + riderHtml + '<div class="updated">Updates automatically</div>';
}
async function poll() {
  try {
    const res = await fetch(STATUS_PATH);
    if (!res.ok) return;
    const d = await res.json();
    document.getElementById('scroll').innerHTML = renderBody(d);
    if (d.expired || d.failed) clearInterval(timer);
  } catch (err) { /* stays on the last known state until the next tick */ }
}
const timer = setInterval(poll, 12000);
</script>
</body></html>`;
}

function trackingBody({ stages, stageIndex, rider, expired, failed }) {
  if (expired) return '<div class="empty">This tracking link has expired.</div>';
  if (failed) return '<div class="empty">This delivery could not be completed. Please contact us.</div>';
  const stagesHtml = stages
    .map((s, i) => {
      const cls = i < stageIndex ? 'done' : i === stageIndex ? 'current' : '';
      return `<li class="${cls}"><span class="dot">${i < stageIndex ? '✓' : i + 1}</span> ${escapeHtml(s)}</li>`;
    })
    .join('');
  const riderHtml = rider
    ? `<div class="rider"><div class="avatar">${escapeHtml(rider.name[0])}</div><div><div><strong>${escapeHtml(rider.name.split(' ')[0])}</strong></div><div><a href="tel:${escapeHtml(rider.phone)}">${escapeHtml(rider.phone)}</a></div></div></div>`
    : '';
  return `<ul class="stages">${stagesHtml}</ul>${riderHtml}<div class="updated">Updates automatically</div>`;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
