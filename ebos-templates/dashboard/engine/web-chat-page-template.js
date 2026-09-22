// The "WhatsApp-look" chat transcript page (routes/web-chat.js's GET
// /:token) -- Chidera, 2026-09-22: "i need the whole flow duplicated in a
// site... they were still texting a bot but instead theyll do it on the
// site." Leans on WhatsApp's own recognizable chat colors (green outgoing
// bubbles, light incoming bubbles, the classic wallpaper tone) rather than
// this app's usual Fraunces/paper branding -- the whole point of this page
// is that it FEELS like the app the customer already trusts, not like a
// separate website. Item selection itself is NOT rebuilt here -- a
// cta_url bubble just navigates out to the existing /m/:token shop page
// (see routes/web-chat.js's own comment on why).
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
<html style="background:#ECE5DD"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>${escapeHtml(businessName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" media="print" onload="this.media='all'">
<style>
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0;height:100%;overflow:hidden;font-family:Inter,-apple-system,sans-serif;color:#111b21}
  #app{display:flex;flex-direction:column;height:100%}
  header{flex:none;background:#075E54;color:#fff;padding:12px 16px;display:flex;align-items:center;gap:10px;box-shadow:0 1px 3px rgba(0,0,0,.15)}
  .avatar{width:36px;height:36px;border-radius:50%;background:#25D366;flex:none;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:15px;${avatarStyle}}
  header .name{font-size:16px;font-weight:600}
  header .status{font-size:12px;opacity:.85}
  #scroll{flex:1;overflow-y:auto;padding:14px 10px;background:#ECE5DD}
  .row{display:flex;margin:3px 0}
  .row.in{justify-content:flex-start}
  .row.out{justify-content:flex-end}
  .bubble{max-width:78%;padding:8px 10px;border-radius:8px;font-size:14.5px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word;box-shadow:0 1px 1px rgba(0,0,0,.08)}
  .row.in .bubble{background:#fff;border-top-left-radius:0}
  .row.out .bubble{background:#DCF8C6;border-top-right-radius:0}
  .bubble a{color:#0b6cf0}
  .extras{max-width:78%;margin-top:4px;display:flex;flex-direction:column;gap:6px}
  .row.in .extras{align-self:flex-start}
  button.chip,a.chip{display:block;width:100%;text-align:center;background:#fff;border:1px solid #d8d8d8;color:#00a884;font-weight:600;font-size:14px;padding:9px 10px;border-radius:8px;cursor:pointer;text-decoration:none}
  button.chip:active,a.chip:active{background:#f2f2f2}
  .listrow{display:flex;justify-content:space-between;gap:8px}
  .listrow .desc{color:#667781;font-weight:400}
  #composer{flex:none;display:flex;gap:8px;align-items:flex-end;padding:8px 10px;background:#f0f0f0}
  #textInput{flex:1;border:none;border-radius:20px;padding:11px 16px;font-size:14.5px;font-family:inherit;resize:none;max-height:100px}
  #sendBtn{flex:none;width:42px;height:42px;border-radius:50%;background:#00a884;border:none;color:#fff;font-size:18px;cursor:pointer}
  #sendBtn:disabled{opacity:.5}
</style></head>
<body>
<div id="app">
  <header>
    <div class="avatar">${escapeHtml((businessName || '?').slice(0, 1).toUpperCase())}</div>
    <div><div class="name">${escapeHtml(businessName || 'Order')}</div><div class="status">online</div></div>
  </header>
  <div id="scroll"></div>
  <div id="composer">
    <textarea id="textInput" rows="1" placeholder="Type a message"></textarea>
    <button id="sendBtn" type="button">&#10148;</button>
  </div>
</div>
<script>
const MESSAGE_PATH = ${JSON.stringify(messagePath)};
const TAP_PATH = ${JSON.stringify(tapPath)};
const POLL_PATH = ${JSON.stringify(pollPath)};
let HISTORY = ${JSON.stringify(history)};
let lastCursor = HISTORY.length ? HISTORY[HISTORY.length - 1].created_at : null;

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

function renderExtras(interactive) {
  if (!interactive) return '';
  if (interactive.type === 'buttons') {
    return (interactive.buttons || []).map(function (b) {
      return '<button type="button" class="chip" data-button-id="' + esc(b.id) + '" data-title="' + esc(b.title) + '">' + esc(b.title) + '</button>';
    }).join('');
  }
  if (interactive.type === 'list') {
    return (interactive.rows || []).map(function (r) {
      return '<button type="button" class="chip listrow" data-row-id="' + esc(r.id) + '"><span>' + esc(r.title) + '</span>' + (r.description ? '<span class="desc">' + esc(r.description) + '</span>' : '') + '</button>';
    }).join('');
  }
  if (interactive.type === 'cta_url') {
    return '<a class="chip" href="' + esc(interactive.url) + '">' + esc(interactive.buttonText || 'Open') + '</a>';
  }
  if (interactive.type === 'document') {
    return '<a class="chip" href="' + esc(interactive.url) + '" target="_blank" rel="noopener">' + esc(interactive.filename || 'View document') + '</a>';
  }
  return '';
}

function renderMessage(m) {
  const side = m.direction === 'inbound' ? 'out' : 'in';
  const bubble = '<div class="row ' + side + '"><div class="bubble">' + esc(m.body).replace(/\\n/g, '<br>') + '</div></div>';
  const extras = m.direction === 'outbound' ? renderExtras(m.interactive) : '';
  return bubble + (extras ? '<div class="row ' + side + '"><div class="extras">' + extras + '</div></div>' : '');
}

function renderAll() {
  const scroll = document.getElementById('scroll');
  scroll.innerHTML = HISTORY.map(renderMessage).join('');
  scroll.scrollTop = scroll.scrollHeight;
}
renderAll();

document.getElementById('scroll').addEventListener('click', function (e) {
  const btn = e.target.closest('button[data-button-id], button[data-row-id]');
  if (!btn) return;
  btn.disabled = true;
  if (btn.dataset.buttonId) {
    tap({ buttonId: btn.dataset.buttonId, title: btn.dataset.title });
  } else if (btn.dataset.rowId) {
    tap({ rowId: btn.dataset.rowId });
  }
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
