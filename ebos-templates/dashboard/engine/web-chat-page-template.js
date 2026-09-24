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

export function renderWebChatPage({ businessName, coverPhotoVersion, history, messagePath, mediaPath, tapPath, pollPath }) {
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
  #app{display:flex;flex-direction:column;height:100%;position:relative}
  header{flex:none;background:var(--header);color:var(--text);padding:10px 14px;display:flex;align-items:center;gap:8px;border-bottom:1px solid rgba(255,255,255,.05)}
  header .back{flex:none;color:var(--accent);font-size:26px;line-height:1;padding:0 2px}
  .avatar{width:36px;height:36px;border-radius:50%;background:var(--accent);flex:none;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;color:#fff;${avatarStyle}}
  header .name{font-size:16px;font-weight:600}
  header .status{font-size:12.5px;color:var(--text2)}
  #scroll{flex:1;overflow-y:auto;padding:14px 10px;background-color:var(--bg);background-image:radial-gradient(rgba(255,255,255,.035) 1px, transparent 1px);background-size:22px 22px}
  /* Chidera, 2026-09-24: "let the webchat notification of received pop as
     a banner... paystack leaves it loading there without making it clear
     when it has actually been confirmed." A real, hard-to-miss banner
     (not just a chat bubble) that slides in over the top of the page --
     visible even switching back from the Paystack tab mid-scroll. */
  #banner{position:absolute;top:0;left:0;right:0;z-index:30;background:var(--accent);color:#04120d;font-weight:700;font-size:14.5px;padding:13px 16px;display:flex;align-items:center;gap:8px;box-shadow:0 2px 10px rgba(0,0,0,.35);transform:translateY(-110%);transition:transform .35s ease}
  #banner.show{transform:translateY(0)}
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
  /* cta_url/document rows ("See menu", "View invoice") read as plain text
     links, not buttons -- Chidera, 2026-09-23: "either make it look like
     a real button or put a tap here type of text." Doing both: a filled
     pill chip (visibly a tappable control, not inline text) plus an
     explicit "Tap to open" caption underneath it. */
  .linkwrap{padding:10px 12px 12px}
  .linkbtn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;background:var(--accent);border:none;border-radius:8px;color:#04120d;font-weight:700;font-size:14.5px;padding:11px 12px;cursor:pointer;text-decoration:none;font-family:inherit}
  .linkbtn:active{background:#03946f}
  .linkbtn .icon{font-size:15px}
  .linkcaption{display:block;text-align:center;color:var(--text2);font-size:12px;margin-top:6px}
  /* Chidera, 2026-09-24: "yes to confirm and no change should also look
     like buttons" -- same filled-pill treatment as .linkbtn, but stacked
     with a real gap (not touching) so multiple buttons in one bubble each
     still read as their own separate control. */
  .confirmbtns{padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px}
  .confirmbtn{display:flex;align-items:center;justify-content:center;width:100%;background:var(--accent);border:none;border-radius:8px;color:#04120d;font-weight:700;font-size:14.5px;padding:11px 12px;cursor:pointer;font-family:inherit}
  .confirmbtn:active{background:#03946f}
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
  /* Chidera, 2026-09-24: "the next text just appears, customer may not
     even notice its a new text... add the typing sign." A real WhatsApp-
     style three-dot bubble shown for 2s before a new bot message actually
     renders, so the arrival is felt, not just silently there. */
  .typing-dots{display:inline-flex;align-items:center;gap:4px;padding:10px 6px}
  .typing-dots span{width:7px;height:7px;border-radius:50%;background:var(--text2);animation:typingBounce 1.2s infinite ease-in-out}
  .typing-dots span:nth-child(2){animation-delay:.2s}
  .typing-dots span:nth-child(3){animation-delay:.4s}
  @keyframes typingBounce{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-4px);opacity:1}}
</style></head>
<body>
<div id="app">
  <div id="banner"><span>&#10003;</span><span id="bannerText">Payment confirmed!</span></div>
  <header>
    <div class="back">&#8249;</div>
    <div class="avatar">${escapeHtml((businessName || '?').slice(0, 1).toUpperCase())}</div>
    <div><div class="name">${escapeHtml(businessName || 'Order')}</div><div class="status">online</div></div>
  </header>
  <div id="scroll"></div>
  <div id="composer">
    <button type="button" class="composer-icon" id="attachBtn" aria-label="Attach a photo or file">&#43;</button>
    <input type="file" id="fileInput" accept="image/*,application/pdf" style="display:none">
    <div id="inputWrap">
      <textarea id="textInput" rows="1" placeholder="Message"></textarea>
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
const MEDIA_PATH = ${JSON.stringify(mediaPath)};
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
    // Chidera, 2026-09-24: "yes to confirm and no change should also look
    // like buttons" -- these used to be the same flat, divider-separated
    // list rows as the upsell "Choose" row below, which read as plain
    // text rather than something tappable. Real pill buttons now, same
    // filled/rounded treatment as the "Pay now"/"See menu" cta_url
    // buttons, stacked with a real gap between them (not touching) so
    // each one reads as its own distinct button.
    return '<div class="confirmbtns">' + (interactive.buttons || []).map(function (b) {
      return '<button type="button" class="confirmbtn" data-button-id="' + esc(b.id) + '" data-title="' + esc(b.title) + '">' + esc(b.title) + '</button>';
    }).join('') + '</div>';
  }
  if (interactive.type === 'list') {
    // Chidera, 2026-09-24: "when you want to upsell on web chat, that
    // choose, let there be a tap here text so its obvious its a button."
    // Same "Tap to open" caption treatment the cta_url/document rows
    // already got for the exact same reason.
    return '<div class="actions"><button type="button" class="actionrow" data-open-list="1"><span class="icon">&#9776;</span>' + esc(interactive.buttonText || 'Choose') + '</button></div><span class="linkcaption">Tap here to see options</span>';
  }
  if (interactive.type === 'cta_url') {
    // newTab (e.g. Paystack's "Pay now") -- a genuinely external page we
    // don't control, opened in its own tab so THIS chat tab stays open
    // behind it. "See menu"/other in-app links stay same-tab on purpose
    // (their own page already navigates back here once done).
    var linkAttrs = interactive.newTab ? ' target="_blank" rel="noopener"' : '';
    return '<div class="linkwrap"><a class="linkbtn" href="' + esc(interactive.url) + '"' + linkAttrs + '><span class="icon">&#8663;</span>' + esc(interactive.buttonText || 'Open') + '</a><span class="linkcaption">' + (interactive.newTab ? 'Opens in a new tab -- come back here after' : 'Tap to open') + '</span></div>';
  }
  if (interactive.type === 'document') {
    return '<div class="linkwrap"><a class="linkbtn" href="' + esc(interactive.url) + '" target="_blank" rel="noopener"><span class="icon">&#128196;</span>' + esc(interactive.filename || 'View document') + '</a><span class="linkcaption">Tap to view</span></div>';
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
  // .confirmbtns (Yes/No pill buttons) or the older .actions wrapper --
  // whichever this button actually sits in, disable every button inside
  // it so a double-tap can't fire twice while the reply is in flight.
  btn.parentElement.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
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

// "+" -- Chidera, 2026-09-23: "actually enable them to upload photo of
// file." Reads the file straight into a data URL in the browser and posts
// it as-is (routes/web-chat.js's own /:token/media, same data_url shape
// handleInboundMedia already stores real WhatsApp photos as) -- no
// separate upload/storage step.
document.getElementById('attachBtn').addEventListener('click', function () {
  document.getElementById('fileInput').click();
});
document.getElementById('fileInput').addEventListener('change', function (e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const isImage = file.type.indexOf('image/') === 0;
  const reader = new FileReader();
  reader.onload = async function () {
    HISTORY.push({ id: 'local-' + Date.now(), direction: 'inbound', sender: 'customer', body: isImage ? '[photo]' : '[file]', interactive: null, created_at: new Date().toISOString() });
    renderAll();
    try {
      await fetch(MEDIA_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: reader.result }) });
    } catch (err) {}
    poll();
  };
  reader.readAsDataURL(file);
});

function showTyping() {
  const scroll = document.getElementById('scroll');
  const row = document.createElement('div');
  row.className = 'row in';
  row.id = 'typingRow';
  row.innerHTML = '<div class="bubble"><div class="typing-dots"><span></span><span></span><span></span></div></div>';
  scroll.appendChild(row);
  scroll.scrollTop = scroll.scrollHeight;
}
function hideTyping() {
  const row = document.getElementById('typingRow');
  if (row) row.remove();
}

// Chidera, 2026-09-24: "let the webchat notification of received pop as a
// banner so customer can know their payment has been confirmed cause
// sometimes paystack leaves it loading there." flow.js's completePayment
// tags its two customer-facing replies 'payment_confirmed' specifically so
// this can be told apart from any other bot message. Auto-dismisses on its
// own -- no dismiss button needed for a purely informational banner.
let bannerTimer = null;
function showBanner(text) {
  const banner = document.getElementById('banner');
  document.getElementById('bannerText').textContent = text;
  banner.classList.add('show');
  if (bannerTimer) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(function () { banner.classList.remove('show'); }, 6000);
}

// Picks up anything NOT triggered by this tab's own action -- a payment
// confirmed by Paystack's webhook, "order ready" if that ever lands here,
// a staff reply. Same lightweight polling idiom the existing dine-in/POS
// pay pages already use, no websocket infra in this codebase.
// pendingTyping blocks a second poll tick from firing mid-delay -- since
// lastCursor only advances once the delayed rows actually land, an
// overlapping poll would otherwise refetch and re-queue the exact same
// rows a second time.
let pendingTyping = false;
async function poll() {
  if (pendingTyping) return;
  try {
    const url = POLL_PATH + (lastCursor ? '?since=' + encodeURIComponent(lastCursor) : '');
    const res = await fetch(url);
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length) {
      const applyRows = function () {
        // Drop the optimistic local echo once the real logged row for it
        // arrives, so a customer's own typed message doesn't render twice.
        HISTORY = HISTORY.filter(function (m) { return typeof m.id !== 'string' || !m.id.startsWith('local-'); });
        HISTORY = HISTORY.concat(rows);
        lastCursor = rows[rows.length - 1].created_at;
        renderAll();
        if (rows.some(function (m) { return m.trigger === 'payment_confirmed'; })) {
          showBanner('Payment confirmed!');
        }
      };
      // Chidera, 2026-09-24: "add the typing sign but it should type for 2
      // seconds, so they know a new text has dropped." Only for a real bot
      // reply arriving (outbound) -- nothing to announce for the
      // customer's own message being echoed back.
      if (rows.some(function (m) { return m.direction === 'outbound'; })) {
        pendingTyping = true;
        showTyping();
        setTimeout(function () {
          hideTyping();
          applyRows();
          pendingTyping = false;
        }, 2000);
      } else {
        applyRows();
      }
    }
  } catch (err) {}
}
setInterval(poll, 3000);
</script>
</body></html>`;
}
