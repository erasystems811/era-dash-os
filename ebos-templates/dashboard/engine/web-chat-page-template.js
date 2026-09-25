// The "WhatsApp-look" chat transcript page (routes/web-chat.js's GET
// /:token) -- Chidera, 2026-09-22: "i need the whole flow duplicated in a
// site... they were still texting a bot but instead theyll do it on the
// site." Colors/structure matched directly against a real WhatsApp screen
// recording (Chidera, 2026-09-23, originally dark mode -- black wallpaper,
// dark green outgoing bubbles, dark gray incoming bubbles; switched to
// WhatsApp's own LIGHT palette 2026-09-24: "can you make the web chat
// light mode, not dark mode" -- tan-dot wallpaper, white incoming/
// light-green outgoing bubbles, all still matched against the real app,
// not guessed) -- buttons/lists living INSIDE the message bubble they
// belong to with a divider line, a list message opening as a real
// bottom-sheet picker, not inline rows -- matched on purpose, since the
// whole point of this page is that it FEELS like the app the customer
// already trusts. Item selection itself is NOT rebuilt here -- a cta_url
// bubble just navigates out to the existing /m/:token shop page (see
// routes/web-chat.js's own comment on why).
//
// history: real `message` rows (channel='website'), oldest first --
// {id, direction, sender, body, interactive, created_at}. interactive is
// null for a plain bubble, or {type:'buttons'|'list'|'cta_url'|'document', ...}
// for a structured one (see flow.js's sendConfirmButtons/sendUpsellList/
// sendWebMenuLink/sendPaymentLinkButton/sendPaymentInstructions for what
// each shape carries).
import { escapeHtml } from './menu-page-template.js';

export function renderWebChatPage({ businessName, coverPhotoVersion, waNumber, history, messagePath, mediaPath, tapPath, pollPath }) {
  const avatarStyle = coverPhotoVersion
    ? `background-image:url('/photo/cover?v=${coverPhotoVersion}');background-size:cover;background-position:center`
    : '';
  // Chidera, 2026-09-24: "the < button beside the restaurant name should
  // actually take customer back to bare chat and not just exist for
  // fashion." Same digits-only wa.me shape every other real WhatsApp CTA
  // on this page family already uses (see menu-page-template.js's own
  // waDigits). No credentials configured yet (waNumber null/empty) means
  // no real link to go back to -- stays a plain, inert arrow rather than
  // linking to a broken wa.me/ with nothing after it.
  const waDigits = String(waNumber || '').replace(/\D/g, '');
  return `<!doctype html>
<html style="background:#efeae2"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>${escapeHtml(businessName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" media="print" onload="this.media='all'">
<style>
  /* Chidera, 2026-09-24: "can you make the web chat light mode, not dark
     mode." Real WhatsApp's own light palette (white/near-white surfaces,
     the light-green outgoing bubble, the tan-dot chat wallpaper), not a
     guess -- everything below derives from these vars plus --panel/
     --surface2 (added here so the two remaining bottom-sheet cards and
     their inputs never fall back to a hardcoded dark hex again either). */
  /* Chidera, 2026-09-24: "you made it too light o, it should have normal
     whatsapp look but just not like that dark mode, just make the header
     that has the restaurant name and all darker" -- then "make header
     darker still not [light] green." #008069 (WhatsApp's current header
     green) still read too light -- WhatsApp's older, noticeably darker
     forest-green header (#075E54, still real and recognizable, not
     invented) instead. Chat body/bubbles stay light (unchanged from the
     first pass) -- --header/--header-text are specific to the top bar
     only; --composer-bg is the (still light) bottom input bar, which used
     to share --header's value back when that was light too. */
  :root{--bg:#efeae2;--header:#075e54;--header-text:#ffffff;--composer-bg:#f0f2f5;--bubble-in:#ffffff;--bubble-out:#d9fdd3;--text:#111b21;--text2:#667781;--accent:#00a884;--divider:rgba(0,0,0,.08);--input:#ffffff;--panel:#ffffff;--surface2:#f0f2f5}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0;height:100%;overflow:hidden;font-family:Inter,-apple-system,sans-serif;color:var(--text);background:var(--bg)}
  #app{display:flex;flex-direction:column;height:100%;position:relative}
  header{flex:none;background:var(--header);color:var(--header-text);padding:10px 14px;display:flex;align-items:center;gap:8px}
  header .back{flex:none;color:var(--header-text);font-size:26px;line-height:1;padding:0 2px;text-decoration:none;display:inline-block}
  /* White circle + accent-colored initial -- an accent-green avatar (the
     old treatment) would nearly vanish against the header's own dark
     green now. */
  .avatar{width:36px;height:36px;border-radius:50%;background:#fff;flex:none;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;color:var(--accent);${avatarStyle}}
  header .name{font-size:16px;font-weight:600}
  header .status{font-size:12.5px;color:rgba(255,255,255,.75)}
  /* Chidera, 2026-09-24: "under the restaurant name, under should have an
     imprint smaller writing Powered by ERA Systems for my branding." A
     deliberately tiny, muted imprint -- ERA's own attribution, never
     competing with the business's own name/status above it. */
  header .powered-by{font-size:10px;color:rgba(255,255,255,.6);opacity:.85;letter-spacing:.3px;margin-top:1px}
  #scroll{flex:1;overflow-y:auto;padding:14px 10px;background-color:var(--bg);background-image:radial-gradient(rgba(0,0,0,.055) 1px, transparent 1px);background-size:22px 22px}
  /* Chidera, 2026-09-24: "let the webchat notification of received pop as
     a banner... paystack leaves it loading there without making it clear
     when it has actually been confirmed." A real, hard-to-miss banner
     (not just a chat bubble) that slides in over the top of the page --
     visible even switching back from the Paystack tab mid-scroll. */
  #banner{position:absolute;top:0;left:0;right:0;z-index:30;background:var(--accent);color:#04120d;font-weight:700;font-size:14.5px;padding:13px 16px;display:flex;align-items:center;gap:8px;box-shadow:0 2px 10px rgba(0,0,0,.35);transform:translateY(-110%);transition:transform .35s ease}
  #banner.show{transform:translateY(0)}
  .daterow{text-align:center;margin:12px 0}
  .datepill{display:inline-block;background:var(--panel);color:var(--text2);box-shadow:0 1px 2px rgba(0,0,0,.12);font-size:12px;font-weight:600;padding:5px 12px;border-radius:8px}
  .row{display:flex;margin:2px 0}
  .row.in{justify-content:flex-start}
  .row.out{justify-content:flex-end}
  /* Chidera, 2026-09-24: "my own replies should be popping in on the
     screen like bouncing (that subtle effect when a text comes in) not
     just appearing on the screen after ive sent." A real bounce-settle,
     not a fade -- the same "arrived" feeling as a real phone's own send
     animation. Only ever applied to a message right as it's freshly
     appended (see appendMessage below), never replayed on an ordinary
     full re-render, so older bubbles never randomly re-animate. */
  .pop-in{animation:bubblePop .28s cubic-bezier(.34,1.56,.64,1)}
  @keyframes bubblePop{0%{transform:scale(.75);opacity:0}60%{transform:scale(1.04);opacity:1}100%{transform:scale(1)}}
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
  .actionrow:active{background:rgba(0,0,0,.04)}
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
  #listSheetCard{position:absolute;left:0;right:0;bottom:0;background:var(--panel);border-radius:14px 14px 0 0;max-height:78%;display:flex;flex-direction:column;padding-bottom:env(safe-area-inset-bottom)}
  #listSheetHead{flex:none;display:flex;align-items:center;justify-content:space-between;padding:16px 18px;font-weight:700;font-size:17px}
  #listSheetClose{background:none;border:none;color:var(--text);font-size:20px;cursor:pointer;padding:4px}
  #listSheetRows{flex:1;overflow-y:auto;padding:0 18px}
  /* Same bottom-sheet chrome as #listSheet above, reused verbatim for the
     item-question select-plus-note sheet -- see its own comment further
     down by #qSheetBody. */
  #qSheet{position:fixed;inset:0;display:none;z-index:20}
  #qSheet.open{display:block}
  #qSheetBg{position:absolute;inset:0;background:rgba(0,0,0,.5)}
  #qSheetCard{position:absolute;left:0;right:0;bottom:0;background:var(--panel);border-radius:14px 14px 0 0;max-height:78%;display:flex;flex-direction:column;padding-bottom:env(safe-area-inset-bottom)}
  #qSheetHead{flex:none;display:flex;align-items:center;justify-content:space-between;padding:16px 18px;font-weight:700;font-size:17px}
  #qSheetClose{background:none;border:none;color:var(--text);font-size:20px;cursor:pointer;padding:4px}
  /* Chidera, 2026-09-24: "let them be able to pick multiple and also when
     they pick one let the + and - thing show so they can buy more than
     1." A row is now a plain wrapper (not itself the button -- a button
     can't contain another button) around a toggle button (label+checkbox)
     and, once selected, a sibling quantity stepper. */
  .sheetrow{display:flex;align-items:center;justify-content:space-between;width:100%;border-top:1px solid var(--divider);padding:14px 0}
  .sheetrow:first-child{border-top:none}
  .sheetrow-toggle{display:flex;align-items:center;gap:10px;flex:1;min-width:0;background:none;border:none;color:var(--text);font-family:inherit;text-align:left;cursor:pointer;padding:0}
  .sheetrow-toggle > span:last-child{display:flex;flex-direction:column;min-width:0}
  .sheetrow .label{font-size:15.5px}
  .sheetrow .desc{color:var(--text2);font-size:13px;margin-top:2px}
  .sheetrow .check{color:var(--text2);font-size:17px;flex:none}
  .sheetrow.selected .check{color:var(--accent)}
  .sheetrow .qty{display:flex;align-items:center;gap:10px;flex:none;margin-left:10px}
  .qtybtn{width:26px;height:26px;flex:none;border-radius:50%;border:1px solid var(--divider);background:var(--surface2);color:var(--text);font-size:16px;line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer;font-family:inherit;padding:0}
  .qtybtn:active{background:var(--divider)}
  .qtycount{min-width:16px;text-align:center;font-size:14.5px;font-weight:600}
  #listSheetSend{flex:none;margin:14px 18px;padding:13px;border:none;border-radius:24px;background:linear-gradient(180deg,#1fda63,#0abb5f);color:#062b1a;font-weight:700;font-size:15.5px;cursor:pointer}
  #listSheetSend:disabled{opacity:.4;cursor:default}
  /* Chidera, 2026-09-24: "can i have it as a dropdown they can choose,
     and an optional type extra note if they have extra, so they just
     only have to select." Same bottom-sheet shape as the upsell list
     above, a genuinely different control inside it though -- one real
     dropdown (never free multi-select/quantity, this is always exactly
     one answer) plus one optional note field, same as the web menu
     page's own qSheet already offers for a question with real options. */
  #qSheetBody{flex:1;overflow-y:auto;padding:4px 18px 0}
  #qSheetSelect{width:100%;padding:12px;border-radius:8px;border:1px solid var(--divider);background:var(--surface2);color:var(--text);font-size:15px;font-family:inherit;margin-bottom:10px}
  #qSheetNote{width:100%;padding:12px;border-radius:8px;border:1px solid var(--divider);background:var(--surface2);color:var(--text);font-size:14.5px;font-family:inherit;box-sizing:border-box}
  #qSheetNote::placeholder{color:var(--text2)}
  #qSheetSend{flex:none;margin:14px 18px;padding:13px;border:none;border-radius:24px;background:linear-gradient(180deg,#1fda63,#0abb5f);color:#062b1a;font-weight:700;font-size:15.5px;cursor:pointer}
  #composer{flex:none;display:flex;gap:6px;align-items:center;padding:8px 10px;background:var(--composer-bg);border-top:1px solid var(--divider)}
  .composer-icon{flex:none;width:26px;height:26px;border:none;background:none;color:var(--text2);font-size:21px;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
  #inputWrap{flex:1;display:flex;align-items:center;background:var(--input);border-radius:22px;padding:0 6px 0 16px}
  #textInput{flex:1;border:none;padding:11px 4px;font-size:14.5px;font-family:inherit;resize:none;max-height:100px;background:transparent;color:var(--text)}
  #textInput::placeholder{color:var(--text2)}
  #textInput:focus{outline:none}
  #sendBtn{flex:none;width:42px;height:42px;border-radius:50%;background:var(--accent);border:none;color:#fff;font-size:17px;cursor:pointer;display:flex;align-items:center;justify-content:center}
  #sendBtn:disabled{opacity:.5}
  /* Chidera, 2026-09-24: "the tapping should feel like ive tapped
     something, like the effect of popping or bounce." A real press-down,
     not just whatever happens after -- fires instantly on touch/press via
     :active (no JS, no round-trip wait), on every real tappable control
     on this page, so a tap always reads as "that registered" the moment
     it happens, not only once a reply eventually shows up. */
  /* Chidera, 2026-09-25: "when i tap a button on web chat can it have
     that subtle bounce effect... this is for all buttons, dine in and
     online." Dine-in and online already share this exact page/template
     (only the message THREAD differs, routes/web-chat.js's own
     table_session_id scoping) so one fix here covers both automatically.
     Was a manually-maintained list of specific classes/ids -- missed
     #qSheetClose/#listSheetClose (the sheet "X" buttons) entirely, and
     would keep missing whatever real button gets added next. A blanket
     button-element selector covers every real button on this page by
     construction, present or future; a.linkbtn/a.back stay named
     explicitly since those are real navigations (anchor tags), not
     button elements. */
  button,.linkbtn,a.back{transition:transform .08s ease}
  button:active,.linkbtn:active,a.back:active{transform:scale(.94)}
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
    ${waDigits ? `<a class="back" href="https://wa.me/${waDigits}">&#8249;</a>` : '<div class="back">&#8249;</div>'}
    <!-- Chidera, 2026-09-24, real report: "there is an E sign on profile
         photo blocking the actual profile photo." The initial-letter
         fallback (avatarStyle below sets the real cover photo as a CSS
         background) used to render unconditionally as the div's own text
         content, sitting ON TOP of that photo instead of only showing
         when there's no real photo to show instead. -->
    <div class="avatar">${coverPhotoVersion ? '' : escapeHtml((businessName || '?').slice(0, 1).toUpperCase())}</div>
    <div><div class="name">${escapeHtml(businessName || 'Order')}</div><div class="status">online</div><div class="powered-by">Powered by ERA Systems</div></div>
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
<div id="qSheet">
  <div id="qSheetBg"></div>
  <div id="qSheetCard">
    <div id="qSheetHead"><span id="qSheetTitle">Choose</span><button type="button" id="qSheetClose">&times;</button></div>
    <div id="qSheetBody">
      <select id="qSheetSelect"></select>
      <input id="qSheetNote" type="text" placeholder="Extra note (optional)">
    </div>
    <button type="button" id="qSheetSend">Send</button>
  </div>
</div>
<script>
const MESSAGE_PATH = ${JSON.stringify(messagePath)};
const MEDIA_PATH = ${JSON.stringify(mediaPath)};
const TAP_PATH = ${JSON.stringify(tapPath)};
const POLL_PATH = ${JSON.stringify(pollPath)};
let HISTORY = ${JSON.stringify(history)};
let lastCursor = HISTORY.length ? HISTORY[HISTORY.length - 1].created_at : null;
// Moved up from beside poll() below -- the initial-load fresh-batch reveal
// (see splitFreshTrailingBatch further down) needs this flag too, and runs
// before poll()'s own declaration is reached.
let pendingTyping = false;

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
    var mainBtn = '<a class="linkbtn" href="' + esc(interactive.url) + '"' + linkAttrs + '><span class="icon">&#8663;</span>' + esc(interactive.buttonText || 'Open') + '</a>';
    // Chidera, 2026-09-25: "in dine in where bot sends the pay now, let
    // them add a menu button since it was suggested that they can still
    // order more so 2 buttons in that text" -- secondaryUrl is optional
    // (every other cta_url bubble on this page still has just the one).
    var secondaryBtn = interactive.secondaryUrl
      ? '<a class="linkbtn" href="' + esc(interactive.secondaryUrl) + '" style="margin-top:8px;background:transparent;border:1.5px solid var(--accent);color:var(--accent)"><span class="icon">&#9776;</span>' + esc(interactive.secondaryLabel || 'Menu') + '</a>'
      : '';
    var caption = interactive.newTab ? 'Opens in a new tab -- come back here after' : 'Tap to open';
    return '<div class="linkwrap">' + mainBtn + secondaryBtn + '<span class="linkcaption">' + caption + '</span></div>';
  }
  if (interactive.type === 'document') {
    // Chidera, 2026-09-25: "when i said invoice and pay now in same chat i
    // meant itll have 2 buttons not just the pay now in the invoice" -- a
    // real second button right here, not just relying on the invoice
    // page's own embedded Pay Now once they open it. payUrl is optional
    // (the receipt bubble, for instance, never has one -- nothing left to
    // pay by then).
    var docBtn = '<a class="linkbtn" href="' + esc(interactive.url) + '" target="_blank" rel="noopener"><span class="icon">&#128196;</span>' + esc(interactive.filename || 'View document') + '</a>';
    var payBtn = interactive.payUrl
      ? '<a class="linkbtn" href="' + esc(interactive.payUrl) + '" target="_blank" rel="noopener" style="margin-top:8px"><span class="icon">&#8663;</span>' + esc(interactive.payLabel || 'Pay now') + '</a>'
      : '';
    var caption = interactive.payUrl ? 'Tap to view, or pay now' : 'Tap to view';
    return '<div class="linkwrap">' + docBtn + payBtn + '<span class="linkcaption">' + caption + '</span></div>';
  }
  if (interactive.type === 'item_question') {
    // Chidera, 2026-09-24: "can i have it as a dropdown they can choose,
    // and an optional type extra note if they have extra." Same "Tap
    // here" caption treatment every other tappable bubble on this page
    // already has.
    return '<div class="actions"><button type="button" class="actionrow" data-open-qsheet="1"><span class="icon">&#9776;</span>' + esc(interactive.buttonText || 'Choose') + '</button></div><span class="linkcaption">Tap here to answer</span>';
  }
  return '';
}

function renderMessage(m, animate) {
  const side = m.direction === 'inbound' ? 'out' : 'in';
  const body = '<div class="body">' + esc(m.body).replace(/\\n/g, '<br>') + '</div>';
  // Read-receipt ticks only make sense on the customer's own bubbles (the
  // "out" side, right-aligned, green) -- mirrors real WhatsApp, where the
  // double blue check tells YOU your own message was read, never shown on
  // what the other side sent you.
  const ticks = side === 'out' ? '<span class="ticks">&#10003;&#10003;</span>' : '';
  const time = '<div class="time">' + fmtTime(m.created_at) + ticks + '</div>';
  const actions = m.direction === 'outbound' ? renderActions(m.interactive) : '';
  return '<div class="row ' + side + (animate ? ' pop-in' : '') + '"><div class="bubble">' + body + time + actions + '</div></div>';
}

// Chidera, 2026-09-24: "my own replies should be popping in... not just
// appearing on the screen after ive sent." Appends ONE bubble straight
// onto the live DOM (with the bounce-in animation) instead of the usual
// full renderAll() rebuild -- renderAll() is what runs right after this on
// the next poll/server-confirm anyway, reconciling everything back to the
// real data; this is purely the immediate, optimistic "it landed" feel.
function appendMessage(m) {
  const scroll = document.getElementById('scroll');
  const pills = scroll.querySelectorAll('.datepill');
  const lastDay = pills.length ? pills[pills.length - 1].textContent : null;
  const day = fmtDay(m.created_at);
  let html = day !== lastDay ? '<div class="daterow"><span class="datepill">' + esc(day) + '</span></div>' : '';
  html += renderMessage(m, true);
  scroll.insertAdjacentHTML('beforeend', html);
  scroll.scrollTop = scroll.scrollHeight;
}

// Chidera, 2026-09-24: "i need the pop in effect when a text is sent in."
// A real bot reply landing (poll()'s own typing-dots reveal, and the
// initial-load fresh-batch reveal below) rebuilds the WHOLE transcript via
// this same renderAll(), so a plain per-row animate flag would replay on
// every old bubble too. animateIds (a Set of just the freshly-landed
// message ids) is how those two callers mark ONLY the new arrival(s) for
// the bounce -- omitted (undefined) for an ordinary rebuild, where nothing
// should re-animate at all.
function renderAll(animateIds) {
  const scroll = document.getElementById('scroll');
  let html = '';
  let lastDay = null;
  HISTORY.forEach(function (m) {
    const day = fmtDay(m.created_at);
    if (day !== lastDay) { html += '<div class="daterow"><span class="datepill">' + esc(day) + '</span></div>'; lastDay = day; }
    html += renderMessage(m, Boolean(animateIds && animateIds.has(m.id)));
  });
  scroll.innerHTML = html;
  scroll.scrollTop = scroll.scrollHeight;
}

// Chidera, 2026-09-24: "after i pick things from menu, i need to have that
// pop in feeling of a new text coming in as a customer to know a new text
// actually landed, if not upsell wont work cause ill think its the normal
// chat." Landing back here right after submitting on /m or /t is a full
// page load -- the freshest bot reply (the upsell offer, often exactly
// what she means) would otherwise bake straight into history with none of
// poll()'s own typing-dots treatment, since nothing "new" ever gets
// fetched: it was already in HISTORY from the very first render. Held
// back here and revealed the exact same way a live poll() arrival is, so
// it never reads as just more of the same old chat.
const FRESH_WINDOW_MS = 20000;
let freshBatch = [];
(function splitFreshTrailingBatch() {
  const now = Date.now();
  let i = HISTORY.length;
  while (i > 0) {
    const m = HISTORY[i - 1];
    if (m.direction !== 'outbound' || now - new Date(m.created_at).getTime() > FRESH_WINDOW_MS) break;
    i -= 1;
  }
  if (i < HISTORY.length) {
    freshBatch = HISTORY.slice(i);
    HISTORY = HISTORY.slice(0, i);
  }
})();
renderAll();
if (freshBatch.length) {
  pendingTyping = true;
  showTyping();
  setTimeout(function () {
    hideTyping();
    HISTORY = HISTORY.concat(freshBatch);
    lastCursor = freshBatch[freshBatch.length - 1].created_at;
    // freshBatch is entirely outbound by construction (the split above
    // only ever collects a trailing run of outbound rows) -- every one of
    // these just "arrived" as far as this page load is concerned.
    renderAll(new Set(freshBatch.map(function (m) { return m.id; })));
    playReceiveSound();
    if (freshBatch.some(function (m) { return m.trigger === 'payment_confirmed'; })) {
      showBanner('Payment confirmed!');
    }
    pendingTyping = false;
  }, 2000);
}

// The list-message bottom sheet -- WhatsApp's real "Choose" flow opens a
// sheet with every real option. Chidera, 2026-09-24: "let them be able to
// pick multiple and also when they pick one let the + and - thing show so
// they can buy more than 1" -- selectedQuantities maps a row's own id to
// however many of it they want (absent = not selected). "No thanks"
// (upsell::skip) stays its own single immediate action, never part of the
// multi-select set.
let openListInteractive = null;
let selectedQuantities = {};
// Guards BOTH the Send and "No thanks" taps below -- see each one's own comment.
let sheetSubmitting = false;

function openListSheet(interactive) {
  openListInteractive = interactive;
  selectedQuantities = {};
  document.getElementById('listSheetTitle').textContent = interactive.sectionTitle || interactive.buttonText || 'Choose';
  renderListSheetRows();
  document.getElementById('listSheet').classList.add('open');
}
function renderListSheetRows() {
  const el = document.getElementById('listSheetRows');
  el.innerHTML = (openListInteractive.rows || []).map(function (r) {
    const desc = r.description ? '<span class="desc">' + esc(r.description) + '</span>' : '';
    if (r.id === 'upsell::skip') {
      return '<div class="sheetrow"><button type="button" class="sheetrow-toggle" data-skip-row="1"><span class="check">&#8250;</span><span><span class="label">' + esc(r.title) + '</span>' + desc + '</span></button></div>';
    }
    const qty = selectedQuantities[r.id];
    const sel = qty != null;
    const qtyControls = sel
      ? '<span class="qty"><button type="button" class="qtybtn" data-qty-minus="' + esc(r.id) + '">&#8722;</button><span class="qtycount">' + qty + '</span><button type="button" class="qtybtn" data-qty-plus="' + esc(r.id) + '">&#43;</button></span>'
      : '';
    return '<div class="sheetrow' + (sel ? ' selected' : '') + '"><button type="button" class="sheetrow-toggle" data-row-id="' + esc(r.id) + '"><span class="check">' + (sel ? '&#9745;' : '&#9744;') + '</span><span><span class="label">' + esc(r.title) + '</span>' + desc + '</span></button>' + qtyControls + '</div>';
  }).join('');
  const total = Object.keys(selectedQuantities).reduce(function (sum, id) { return sum + selectedQuantities[id]; }, 0);
  const sendBtn = document.getElementById('listSheetSend');
  sendBtn.textContent = total ? 'Add selected (' + total + ')' : 'Send';
  sendBtn.disabled = total === 0;
}
document.getElementById('listSheetRows').addEventListener('click', function (e) {
  const skipBtn = e.target.closest('[data-skip-row]');
  if (skipBtn) {
    // Same double-tap guard as the Send button just below -- a fast
    // double-tap on "No thanks" would otherwise skip two upsell
    // categories at once and send two replies for one tap.
    if (sheetSubmitting) return;
    sheetSubmitting = true;
    document.getElementById('listSheet').classList.remove('open');
    tap({ rowId: 'upsell::skip' }, '[tapped: No thanks]');
    return;
  }
  const minusBtn = e.target.closest('[data-qty-minus]');
  if (minusBtn) {
    const id = minusBtn.dataset.qtyMinus;
    const cur = selectedQuantities[id] || 1;
    if (cur <= 1) delete selectedQuantities[id];
    else selectedQuantities[id] = cur - 1;
    renderListSheetRows();
    return;
  }
  const plusBtn = e.target.closest('[data-qty-plus]');
  if (plusBtn) {
    const id = plusBtn.dataset.qtyPlus;
    selectedQuantities[id] = Math.min(20, (selectedQuantities[id] || 1) + 1);
    renderListSheetRows();
    return;
  }
  const toggle = e.target.closest('.sheetrow-toggle[data-row-id]');
  if (!toggle) return;
  const id = toggle.dataset.rowId;
  if (selectedQuantities[id] != null) delete selectedQuantities[id];
  else selectedQuantities[id] = 1;
  renderListSheetRows();
});
document.getElementById('listSheetClose').addEventListener('click', function () {
  document.getElementById('listSheet').classList.remove('open');
});
document.getElementById('listSheetBg').addEventListener('click', function () {
  document.getElementById('listSheet').classList.remove('open');
});
document.getElementById('listSheetSend').addEventListener('click', function (e) {
  const picks = Object.keys(selectedQuantities).map(function (rowId) {
    return { productId: rowId.slice('upsell::'.length), quantity: selectedQuantities[rowId] };
  });
  if (!picks.length) return;
  // handleUpsellMultiTap logs one real inbound row PER pick ("[tapped:
  // 2x Chapman]", ...) -- the optimistic echo mirrors that exactly, one
  // bubble per pick, not one combined line.
  const pickEchoes = Object.keys(selectedQuantities).map(function (rowId) {
    const row = (openListInteractive.rows || []).find(function (r) { return r.id === rowId; });
    return '[tapped: ' + selectedQuantities[rowId] + 'x ' + (row ? row.title : rowId) + ']';
  });
  // Chidera, 2026-09-24, real report: "when i tap a choose and put 2
  // drinks, the bot sends me 2 response." Same double-tap protection the
  // confirm/quick-reply buttons already have (see this file's other
  // data-button-id handler's own comment) -- this one never got it, so a
  // fast double-tap/ghost-click fired tap() twice, adding every pick
  // TWICE and running finishItemsCollection twice (two real replies for
  // one selection). disabled, not just hidden -- the sheet's own close
  // animation/removal isn't synchronous enough to rule out a second event
  // landing in between.
  if (e.currentTarget.disabled) return;
  e.currentTarget.disabled = true;
  document.getElementById('listSheet').classList.remove('open');
  tap({ upsellPicks: picks }, pickEchoes);
});

// Chidera, 2026-09-24: "can i have it as a dropdown they can choose, and
// an optional type extra note if they have extra, so they just only have
// to select." One real dropdown (always exactly one answer -- never
// multi-select/quantity like the upsell sheet above) plus one optional
// note, same shape as the web menu page's own qSheet for a question with
// real options.
function openQuestionSheet(interactive) {
  document.getElementById('qSheetTitle').textContent = interactive.buttonText || 'Choose';
  document.getElementById('qSheetSelect').innerHTML = (interactive.options || []).map(function (opt) {
    return '<option value="' + esc(opt) + '">' + esc(opt) + '</option>';
  }).join('');
  document.getElementById('qSheetNote').value = '';
  // Re-enabled on every open -- Send disables itself once submitted (see
  // its own click handler below), same double-tap guard the upsell
  // sheet's own Send button uses.
  document.getElementById('qSheetSend').disabled = false;
  document.getElementById('qSheet').classList.add('open');
}
document.getElementById('qSheetClose').addEventListener('click', function () {
  document.getElementById('qSheet').classList.remove('open');
});
document.getElementById('qSheetBg').addEventListener('click', function () {
  document.getElementById('qSheet').classList.remove('open');
});
document.getElementById('qSheetSend').addEventListener('click', function (e) {
  if (e.currentTarget.disabled) return;
  const option = document.getElementById('qSheetSelect').value;
  if (!option) return;
  const note = document.getElementById('qSheetNote').value;
  e.currentTarget.disabled = true;
  document.getElementById('qSheet').classList.remove('open');
  tap({ itemQuestionAnswer: { option: option, note: note } }, '[selected: ' + (note ? option + ' (' + note + ')' : option) + ']');
});

document.getElementById('scroll').addEventListener('click', function (e) {
  const openList = e.target.closest('[data-open-list]');
  const openQSheet = e.target.closest('[data-open-qsheet]');
  if (openList || openQSheet) {
    const bubble = (openList || openQSheet).closest('.bubble');
    const idx = Array.prototype.indexOf.call(document.querySelectorAll('.bubble'), bubble);
    // Find the actual message this bubble renders by matching DOM order --
    // walk HISTORY in the same order renderAll did (can't just match on
    // "the first outbound row", that's not reliable once inbound rows are
    // interleaved).
    let seen = -1, found = null;
    HISTORY.forEach(function (m) { seen++; if (seen === idx) found = m; });
    if (!found || !found.interactive) return;
    if (openList) openListSheet(found.interactive);
    else openQuestionSheet(found.interactive);
    return;
  }
  const btn = e.target.closest('button[data-button-id]');
  if (!btn) return;
  // .confirmbtns (Yes/No pill buttons) or the older .actions wrapper --
  // whichever this button actually sits in, disable every button inside
  // it so a double-tap can't fire twice while the reply is in flight.
  btn.parentElement.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
  tap({ buttonId: btn.dataset.buttonId, title: btn.dataset.title }, '[tapped: ' + btn.dataset.title + ']');
});

// Chidera, 2026-09-24, real report: "when i tapped make a complaint it
// sent double reply... it should be able to know when a double tap of a
// button is a mistake." The individual per-button disabled-attribute
// guards (confirmbtns, the upsell list sheet's Send/skip) already existed, but
// each one was its own separate, easy-to-miss copy of the same idea --
// one centralized, ALWAYS-on guard right here instead, so every single
// caller of tap() (current and future) is covered the same way, with no
// possible gap. A tap while one's already in flight is silently dropped,
// never queued or retried -- the customer's first tap is what happens,
// a second one on top of it never means "do it twice."
// Chidera, 2026-09-25: "when i respond to bot on web chat like a tap or
// something cant my response seem likee a normal response and appear in
// chat immediately i tap it, right now my response appears when bot is
// delivering its own response, and they both apperar same time." sendText()
// already gives typed messages this instant "it sent" feel (appendMessage,
// right before the fetch); tap() never did the same, so a tap's own
// customer-facing bubble only ever showed up later, in the same poll batch
// as the bot's reply. echoTexts -- one string, or an array (a multi-pick
// upsell logs one real inbound row PER pick, server-side) -- must match the
// real logMessage body EXACTLY (the same "[tapped: X]"/"[selected: X]"
// bracket format every handler already logs), so the optimistic bubble and
// the real row that lands right behind it are pixel-identical, no visible
// swap.
let tapInFlight = false;
async function tap(body, echoTexts) {
  if (tapInFlight) return;
  tapInFlight = true;
  const echoList = echoTexts ? (Array.isArray(echoTexts) ? echoTexts : [echoTexts]) : [];
  echoList.forEach(function (text, i) {
    const localMsg = { id: 'local-tap-' + Date.now() + '-' + i, direction: 'inbound', sender: 'customer', body: text, interactive: null, created_at: new Date().toISOString() };
    HISTORY.push(localMsg);
    appendMessage(localMsg);
  });
  if (echoList.length) playSendSound();
  try {
    await fetch(TAP_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (err) {}
  tapInFlight = false;
  poll();
}

// Chidera, 2026-09-24: "if possible add the text sound fx." Short,
// synthesized tones (Web Audio API, no external audio file to host/load)
// -- a quick rising blip for the customer's own send, a slightly lower
// one for a bot reply landing. One shared AudioContext, created lazily on
// first real use (browsers refuse to start one before any user gesture
// has happened on the page at all; by the time either sound actually
// needs to play, the customer has already tapped/typed something).
// Deliberately best-effort -- audio failing (blocked, unsupported) must
// never break sending or receiving an actual message.
let audioCtx = null;
function playTone(freq, duration) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.16, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch (err) {}
}
function playSendSound() { playTone(720, 0.11); }
function playReceiveSound() { playTone(480, 0.14); }

async function sendText() {
  const input = document.getElementById('textInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  document.getElementById('sendBtn').disabled = true;
  const localMsg = { id: 'local-' + Date.now(), direction: 'inbound', sender: 'customer', body: text, interactive: null, created_at: new Date().toISOString() };
  HISTORY.push(localMsg);
  appendMessage(localMsg);
  playSendSound();
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
    const localMsg = { id: 'local-' + Date.now(), direction: 'inbound', sender: 'customer', body: isImage ? '[photo]' : '[file]', interactive: null, created_at: new Date().toISOString() };
    HISTORY.push(localMsg);
    appendMessage(localMsg);
    playSendSound();
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
// rows a second time. (declared up top now, see its own comment there)
async function poll() {
  if (pendingTyping) return;
  try {
    // POLL_PATH may already carry its own ?table=... query (dine-in's own
    // separate chat thread, routes/web-chat.js) -- joiner must be & in
    // that case, not a second ?, or the since= param is silently dropped.
    const url = POLL_PATH + (lastCursor ? (POLL_PATH.includes('?') ? '&' : '?') + 'since=' + encodeURIComponent(lastCursor) : '');
    const res = await fetch(url);
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return;
    // Drop the optimistic local echo(es) once the real logged row(s)
    // arrive, so a customer's own typed/tapped message doesn't render
    // twice.
    HISTORY = HISTORY.filter(function (m) { return typeof m.id !== 'string' || !m.id.startsWith('local-'); });
    lastCursor = rows[rows.length - 1].created_at;

    const inboundInBatch = rows.filter(function (m) { return m.direction !== 'outbound'; });
    const outboundInBatch = rows.filter(function (m) { return m.direction === 'outbound'; });

    // The customer's own message(s), now logged for real -- silently
    // replaces the local echo (already bounced in the instant it was
    // sent), no re-animation, no delay.
    if (inboundInBatch.length) {
      HISTORY = HISTORY.concat(inboundInBatch);
      renderAll();
    }
    if (!outboundInBatch.length) return;

    // Chidera, 2026-09-24: "add the typing sign but it should type for 2
    // seconds, so they know a new text has dropped."
    // Chidera, 2026-09-25: "when receipt and rate your order is landing
    // let them land one by one" -- more than one real bot message can
    // land in the same poll batch (a receipt bubble immediately followed
    // by a feedback request, say); revealing all of them in one renderAll()
    // used to pop every one in at the exact same instant, reading as one
    // dump instead of a real back-and-forth. Same typing-dots pause before
    // the first one, now followed by a real stagger between each
    // additional one in the same batch -- each gets its own reveal, sound,
    // and (where relevant) banner check, one at a time.
    pendingTyping = true;
    showTyping();
    setTimeout(function revealOutboundOneByOne() {
      hideTyping();
      let i = 0;
      function revealNext() {
        const m = outboundInBatch[i];
        HISTORY.push(m);
        appendMessage(m);
        playReceiveSound();
        if (m.trigger === 'payment_confirmed') showBanner('Payment confirmed!');
        i += 1;
        if (i < outboundInBatch.length) {
          setTimeout(revealNext, 700);
        } else {
          pendingTyping = false;
        }
      }
      revealNext();
    }, 2000);
  } catch (err) {}
}
setInterval(poll, 3000);
</script>
</body></html>`;
}
