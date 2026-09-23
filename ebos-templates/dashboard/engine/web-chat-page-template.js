// The "WhatsApp-look" chat transcript page (routes/web-chat.js's GET
// /:token) -- Chidera, 2026-09-22: "i need the whole flow duplicated in a
// site... they were still texting a bot but instead theyll do it on the
// site." Colors/structure matched directly against a real WhatsApp screen
// recording (Chidera, 2026-09-23, dark mode -- black wallpaper, dark
// green outgoing bubbles, dark gray incoming bubbles, buttons/lists living
// INSIDE the message bubble they belong to with a divider line, a list
// message opening as a real bottom-sheet picker, not inline rows) --
// matched on purpose, not guessed at, since the whole point of this page
// is that it FEELS like the app the customer already trusts. Item
// selection itself is NOT rebuilt here -- a cta_url bubble just navigates
// out to the existing /m/:token shop page (see routes/web-chat.js's own
// comment on why).
//
// history: real `message` rows (channel='website'), oldest first --
// {id, direction, sender, body, interactive, created_at}. interactive is
// null for a plain bubble, or {type:'buttons'|'list'|'cta_url'|'document', ...}
// for a structured one (see flow.js's sendConfirmButtons/sendUpsellList/
// sendWebMenuLink/sendPaymentLinkButton/sendPaymentInstructions for what
// each shape carries).
import { escapeHtml } from './menu-page-template.js';

export function renderWebChatPage({ businessName, coverPhotoVersion, history, messagePath, tapPath, pollPath }) {
  const avatarStyle = coverPhotoVersion
    ? `background-image:url('/photo/cover?v=${coverPhotoVersion}');background-size:cover;background-position:center`
    : '';
  return `<!doctype html>
<html style="background:#0b141a"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>${escapeHtml(businessName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" media="print" onload="this.media='all'">
<style>
  :root{--bg:#0b141a;--header:#1f2c34;--bubble-in:#202c33;--bubble-out:#005c4b;--text:#e9edef;--text2:#8696a0;--accent:#00a884;--divider:rgba(255,255,255,.09);--input:#2a3942}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0;height:100%;overflow:hidden;font-family:Inter,-apple-system,sans-serif;color:var(--text);background:#000}
  #app{display:flex;flex-direction:column;height:100%}
  /* Fake iOS status bar -- Chidera, 2026-09-23: "it doesnt feel real" --
     a big part of what makes a screen recording read as "a real phone"
     is this bar, which a plain webpage never has on its own. Static
     (real time, decorative icons) -- nobody needs a working signal meter,
     just the silhouette of one. */
  #statusbar{flex:none;background:#000;color:#fff;display:flex;align-items:center;justify-content:space-between;padding:6px 22px 4px;font-size:15px;font-weight:600}
  #statusbar svg{display:block}
  header{flex:none;background:var(--header);color:var(--text);padding:10px 14px;display:flex;align-items:center;gap:8px;border-bottom:1px solid rgba(255,255,255,.05)}
  header .back{flex:none;color:var(--accent);font-size:26px;line-height:1;padding:0 2px}
  .avatar{width:36px;height:36px;border-radius:50%;background:var(--accent);flex:none;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;color:#fff;${avatarStyle}}
  header .name{font-size:16px;font-weight:600}
  header .status{font-size:12.5px;color:var(--text2)}
  #scroll{flex:1;overflow-y:auto;padding:14px 10px;background-color:var(--bg);background-image:radial-gradient(rgba(255,255,255,.035) 1px, transparent 1px);background-size:22px 22px}
  .daterow{text-align:center;margin:12px 0}
  .datepill{display:inline-block;background:#182229;color:var(--text2);font-size:12px;font-weight:600;padding:5px 12px;border-radius:8px}
  .row{display:flex;margin:2px 0}
  .row.in{justify-content:flex-start}
  .row.out{justify-content:flex-end}
  .bubble{position:relative;max-width:82%;min-width:80px;border-radius:9px;font-size:14.5px;line-height:1.4;box-shadow:0 1px 1px rgba(0,0,0,.2)}
  .row.in .bubble{background:var(--bubble-in);border-top-left-radius:0}
  .row.out .bubble{background:var(--bubble-out);border-top-right-radius:0}
  /* Bubble tails -- a plain rounded rectangle is the single biggest "this
     is obviously not real WhatsApp" tell next to the status bar. */
  .row.in .bubble::before{content:'';position:absolute;top:0;left:-7px;width:10px;height:13px;background:var(--bubble-in);clip-path:polygon(100% 0,100% 100%,0 0)}
  .row.out .bubble::before{content:'';position:absolute;top:0;right:-7px;width:10px;height:13px;background:var(--bubble-out);clip-path:polygon(0 0,0 100%,100% 0)}
  .bubble .body{padding:7px 9px 4px 9px;white-space:pre-wrap;word-wrap:break-word}
  .bubble .body a{color:#53bdeb}
  .bubble .time{font-size:11px;color:var(--text2);text-align:right;padding:0 9px 6px 9px;display:flex;justify-content:flex-end;align-items:center;gap:3px}
  .bubble .time .ticks{color:#53bdeb}
  .bubble .actions{border-top:1px solid var(--divider)}
  .actionrow{display:flex;align-items:center;gap:10px;width:100%;background:transparent;border:none;border-top:1px solid var(--divider);color:var(--accent);font-weight:600;font-size:14.5px;padding:11px 12px;cursor:pointer;text-align:left;text-decoration:none;font-family:inherit}
  .actionrow:first-child{border-top:none}
  .actionrow:active{background:rgba(255,255,255,.04)}
  .actionrow .icon{flex:none;width:18px;height:18px;display:flex;align-items:center;justify-content:center;font-size:15px}
  .actionrow .desc{color:var(--text2);font-weight:400;font-size:12.5px;display:block}
  /* List-message bottom sheet */
  #listSheet{position:fixed;inset:0;display:none;z-index:20}
  #listSheet.open{display:block}
  #listSheetBg{position:absolute;inset:0;background:rgba(0,0,0,.5)}
  #listSheetCard{position:absolute;left:0;right:0;bottom:0;background:#182229;border-radius:14px 14px 0 0;max-height:78%;display:flex;flex-direction:column;padding-bottom:env(safe-area-inset-bottom)}
  #listSheetHead{flex:none;display:flex;align-items:center;justify-content:space-between;padding:16px 18px;font-weight:700;font-size:17px}
  #listSheetClose{background:none;border:none;color:var(--text);font-size:20px;cursor:pointer;padding:4px}
  #listSheetRows{flex:1;overflow-y:auto;padding:0 18px}
  .sheetrow{display:flex;align-items:center;justify-content:space-between;width:100%;background:none;border:none;border-top:1px solid var(--divider);color:var(--text);font-family:inherit;text-align:left;padding:14px 0;cursor:pointer}
  .sheetrow:first-child{border-top:none}
  .sheetrow > span:first-child{display:flex;flex-direction:column}
  .sheetrow .label{font-size:15.5px}
  .sheetrow .desc{color:var(--text2);font-size:13px;margin-top:2px}
  .sheetrow .check{color:var(--accent);font-size:18px;opacity:0}
  .sheetrow.selected .check{opacity:1}
  #listSheetSend{flex:none;margin:14px 18px;padding:13px;border:none;border-radius:24px;background:linear-gradient(180deg,#1fda63,#0abb5f);color:#062b1a;font-weight:700;font-size:15.5px;cursor:pointer}
  #composer{flex:none;display:flex;gap:6px;align-items:center;padding:8px 10px;background:var(--header)}
  .composer-icon{flex:none;width:26px;height:26px;border:none;background:none;color:var(--text2);font-size:21px;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
  #inputWrap{flex:1;display:flex;align-items:center;background:var(--input);border-radius:22px;padding:0 6px 0 16px}
  #textInput{flex:1;border:none;padding:11px 4px;font-size:14.5px;font-family:inherit;resize:none;max-height:100px;background:transparent;color:var(--text)}
  #textInput::placeholder{color:var(--text2)}
  #textInput:focus{outline:none}
  #sendBtn{flex:none;width:42px;height:42px;border-radius:50%;background:var(--accent);border:none;color:#fff;font-size:17px;cursor:pointer;display:flex;align-items:center;justify-content:center}
  #sendBtn:disabled{opacity:.5}
</style></head>
<body>
<div id="app">
  <div id="statusbar">
    <span id="clock"></span>
    <svg width="60" height="12" viewBox="0 0 60 12" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="6" width="3" height="6" rx="0.5" fill="#fff"/><rect x="5" y="4" width="3" height="8" rx="0.5" fill="#fff"/><rect x="10" y="2" width="3" height="10" rx="0.5" fill="#fff"/><rect x="15" y="0" width="3" height="12" rx="0.5" fill="#fff"/>
      <path d="M27 9.5a6 6 0 0 1 8 0" stroke="#fff" stroke-width="1.3" stroke-linecap="round" fill="none"/><path d="M29 11.2a3 3 0 0 1 4 0" stroke="#fff" stroke-width="1.3" stroke-linecap="round" fill="none"/><circle cx="31" cy="12" r="0.9" fill="#fff"/>
      <rect x="41" y="1.5" width="16" height="9" rx="2" stroke="#fff" stroke-width="1" fill="none"/><rect x="58" y="4" width="1.5" height="4" rx="0.7" fill="#fff"/><rect x="42.5" y="3" width="13" height="6" rx="1" fill="#fff"/>
    </svg>
  </div>
  <header>
    <div class="back">&#8249;</div>
    <div class="avatar">${escapeHtml((businessName || '?').slice(0, 1).toUpperCase())}</div>
    <div><div class="name">${escapeHtml(businessName || 'Order')}</div><div class="status">online</div></div>
  </header>
  <div id="scroll"></div>
  <div id="composer">
    <button type="button" class="composer-icon" id="attachBtn" aria-label="Attach">&#43;</button>
    <div id="inputWrap">
      <textarea id="textInput" rows="1" placeholder="Message"></textarea>
      <button type="button" class="composer-icon" id="cameraBtn" aria-label="Camera">&#128247;</button>
    </div>
    <button id="sendBtn" type="button">&#10148;</button>
  </div>
</div>
<div id="listSheet">
  <div id="listSheetBg"></div>
  <div id="listSheetCard">
    <div id="listSheetHead"><span id="listSheetTitle">Choose</span><button type="button" id="listSheetClose">&times;</button></div>
    <div id="listSheetRows"></div>
    <button type="button" id="listSheetSend">Send</button>
  </div>
</div>
<script>
const MESSAGE_PATH = ${JSON.stringify(messagePath)};
const TAP_PATH = ${JSON.stringify(tapPath)};
const POLL_PATH = ${JSON.stringify(pollPath)};
let HISTORY = ${JSON.stringify(history)};
let lastCursor = HISTORY.length ? HISTORY[HISTORY.length - 1].created_at : null;

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function fmtTime(iso) { const d = new Date(iso); return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function fmtDay(iso) {
  const d = new Date(iso); const today = new Date(); const yest = new Date(Date.now() - 86400000);
  const same = function (a, b) { return a.toDateString() === b.toDateString(); };
  if (same(d, today)) return 'Today';
  if (same(d, yest)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

// Actions render INSIDE the same bubble as the message they belong to,
// each its own full-width row with a divider above it -- matches real
// WhatsApp's quick-reply/list/cta_url message shape (confirmed against a
// real screen recording), not a separate chip floating below the bubble.
function renderActions(interactive) {
  if (!interactive) return '';
  if (interactive.type === 'buttons') {
    return '<div class="actions">' + (interactive.buttons || []).map(function (b) {
      return '<button type="button" class="actionrow" data-button-id="' + esc(b.id) + '" data-title="' + esc(b.title) + '"><span class="icon">&#8617;</span>' + esc(b.title) + '</button>';
    }).join('') + '</div>';
  }
  if (interactive.type === 'list') {
    return '<div class="actions"><button type="button" class="actionrow" data-open-list="1"><span class="icon">&#9776;</span>' + esc(interactive.buttonText || 'Choose') + '</button></div>';
  }
  if (interactive.type === 'cta_url') {
    return '<div class="actions"><a class="actionrow" href="' + esc(interactive.url) + '"><span class="icon">&#8663;</span>' + esc(interactive.buttonText || 'Open') + '</a></div>';
  }
  if (interactive.type === 'document') {
    return '<div class="actions"><a class="actionrow" href="' + esc(interactive.url) + '" target="_blank" rel="noopener"><span class="icon">&#128196;</span>' + esc(interactive.filename || 'View document') + '</a></div>';
  }
  return '';
}

function renderMessage(m) {
  const side = m.direction === 'inbound' ? 'out' : 'in';
  const body = '<div class="body">' + esc(m.body).replace(/\\n/g, '<br>') + '</div>';
  // Read-receipt ticks only make sense on the customer's own bubbles (the
  // "out" side, right-aligned, green) -- mirrors real WhatsApp, where the
  // double blue check tells YOU your own message was read, never shown on
  // what the other side sent you.
  const ticks = side === 'out' ? '<span class="ticks">&#10003;&#10003;</span>' : '';
  const time = '<div class="time">' + fmtTime(m.created_at) + ticks + '</div>';
  const actions = m.direction === 'outbound' ? renderActions(m.interactive) : '';
  return '<div class="row ' + side + '"><div class="bubble">' + body + time + actions + '</div></div>';
}

function renderAll() {
  const scroll = document.getElementById('scroll');
  let html = '';
  let lastDay = null;
  HISTORY.forEach(function (m) {
    const day = fmtDay(m.created_at);
    if (day !== lastDay) { html += '<div class="daterow"><span class="datepill">' + esc(day) + '</span></div>'; lastDay = day; }
    html += renderMessage(m);
  });
  scroll.innerHTML = html;
  scroll.scrollTop = scroll.scrollHeight;
}
renderAll();

// Real clock in the fake status bar, ticking with the actual time -- a
// static "9:41" (Apple's own screenshot convention) would be the one
// detail most likely to give away that this is a mockup on a second look.
function tickClock() {
  const el = document.getElementById('clock');
  if (el) el.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: false });
}
tickClock();
setInterval(tickClock, 15000);

// The list-message bottom sheet -- WhatsApp's real "Choose" flow opens a
// sheet with every real option, a single selection (defaults to the
// first row, tap another to change it), and one Send button at the
// bottom that submits whichever row is currently selected.
let openListInteractive = null;
let selectedRowId = null;

function openListSheet(interactive) {
  openListInteractive = interactive;
  selectedRowId = (interactive.rows || [])[0] ? interactive.rows[0].id : null;
  document.getElementById('listSheetTitle').textContent = interactive.sectionTitle || interactive.buttonText || 'Choose';
  renderListSheetRows();
  document.getElementById('listSheet').classList.add('open');
}
function renderListSheetRows() {
  const el = document.getElementById('listSheetRows');
  el.innerHTML = (openListInteractive.rows || []).map(function (r) {
    const sel = r.id === selectedRowId;
    return '<button type="button" class="sheetrow' + (sel ? ' selected' : '') + '" data-row-id="' + esc(r.id) + '"><span><span class="label">' + esc(r.title) + '</span>' + (r.description ? '<span class="desc">' + esc(r.description) + '</span>' : '') + '</span><span class="check">&#10003;</span></button>';
  }).join('');
}
document.getElementById('listSheetRows').addEventListener('click', function (e) {
  const row = e.target.closest('.sheetrow');
  if (!row) return;
  selectedRowId = row.dataset.rowId;
  renderListSheetRows();
});
document.getElementById('listSheetClose').addEventListener('click', function () {
  document.getElementById('listSheet').classList.remove('open');
});
document.getElementById('listSheetBg').addEventListener('click', function () {
  document.getElementById('listSheet').classList.remove('open');
});
document.getElementById('listSheetSend').addEventListener('click', function () {
  document.getElementById('listSheet').classList.remove('open');
  if (selectedRowId) tap({ rowId: selectedRowId });
});

document.getElementById('scroll').addEventListener('click', function (e) {
  const openList = e.target.closest('[data-open-list]');
  if (openList) {
    const bubble = openList.closest('.bubble');
    const idx = Array.prototype.indexOf.call(document.querySelectorAll('.bubble'), bubble);
    const msg = HISTORY.filter(function (m) { return m.direction === 'outbound'; })[0];
    // Find the actual message this bubble renders by matching DOM order
    // against the outbound-only slice isn't reliable once inbound rows
    // are interleaved -- walk HISTORY in the same order renderAll did.
    let seen = -1, found = null;
    HISTORY.forEach(function (m) { seen++; if (seen === idx) found = m; });
    if (found && found.interactive) openListSheet(found.interactive);
    return;
  }
  const btn = e.target.closest('button[data-button-id]');
  if (!btn) return;
  btn.closest('.actions').querySelectorAll('.actionrow').forEach(function (b) { b.disabled = true; });
  tap({ buttonId: btn.dataset.buttonId, title: btn.dataset.title });
});

async function tap(body) {
  try {
    await fetch(TAP_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (err) {}
  poll();
}

async function sendText() {
  const input = document.getElementById('textInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  document.getElementById('sendBtn').disabled = true;
  HISTORY.push({ id: 'local-' + Date.now(), direction: 'inbound', sender: 'customer', body: text, interactive: null, created_at: new Date().toISOString() });
  renderAll();
  try {
    await fetch(MESSAGE_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text }) });
  } catch (err) {}
  document.getElementById('sendBtn').disabled = false;
  poll();
}
document.getElementById('sendBtn').addEventListener('click', sendText);
document.getElementById('textInput').addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
});

// Picks up anything NOT triggered by this tab's own action -- a payment
// confirmed by Paystack's webhook, "order ready" if that ever lands here,
// a staff reply. Same lightweight polling idiom the existing dine-in/POS
// pay pages already use, no websocket infra in this codebase.
async function poll() {
  try {
    const url = POLL_PATH + (lastCursor ? '?since=' + encodeURIComponent(lastCursor) : '');
    const res = await fetch(url);
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length) {
      // Drop the optimistic local echo once the real logged row for it
      // arrives, so a customer's own typed message doesn't render twice.
      HISTORY = HISTORY.filter(function (m) { return typeof m.id !== 'string' || !m.id.startsWith('local-'); });
      HISTORY = HISTORY.concat(rows);
      lastCursor = rows[rows.length - 1].created_at;
      renderAll();
    }
  } catch (err) {}
}
setInterval(poll, 3000);
</script>
</body></html>`;
}
