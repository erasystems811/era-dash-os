// Chidera, 2026-09-24: "now feedback can have a fill a complaint form kind
// of thing" -- was chat-based free text (routes/web-chat.js's own
// ?ctx=complaint greeting), now a real form, same pattern already proven
// for the star-rating feedback form (engine/feedback-form-template.js) --
// same warm paper/Fraunces/Inter app-shell, not a bare form. Simpler than
// that one: one free-text field, no star ratings (a complaint isn't a
// completed-order review).
export function renderComplaintFormPage({ businessName, submitted, submitPath, chatUrl }) {
  return `<!doctype html>
<html style="background:#F6F1E8"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>Tell us what happened</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap"></noscript>
<style>
  :root{--paper:#F6F1E8;--ink:#1C1815;--mid:#6E6156;--line:#E2D9CB;--wa:#0F7A5A}
  *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
  html,body{height:100%;background:#F6F1E8}
  body{font-family:"Inter",system-ui,sans-serif;background:var(--paper);color:var(--ink);line-height:1.5;min-height:100vh;min-height:100dvh}
  .wrap{max-width:420px;margin:0 auto;padding:28px 18px calc(28px + env(safe-area-inset-bottom))}
  .mtop{background:var(--ink);color:var(--paper);padding:18px 18px;border-radius:14px;margin-bottom:20px}
  .mtop .nm{font-family:"Fraunces",serif;font-size:19px;font-weight:700}
  h1{font-family:"Fraunces",serif;font-size:21px;font-weight:700;margin-bottom:4px}
  .sub{color:var(--mid);font-size:13.5px;margin-bottom:22px}
  textarea{width:100%;border:1px solid var(--line);border-radius:10px;padding:12px 13px;font-family:inherit;font-size:14.5px;background:#fff;resize:vertical;min-height:140px}
  .submit{display:block;width:100%;margin-top:14px;background:var(--wa);color:#fff;border:0;font-family:inherit;font-weight:600;font-size:15px;padding:13px;border-radius:999px;touch-action:manipulation}
  .submit:disabled{opacity:.5}
  .err{color:#C5452B;font-size:13px;margin-top:10px;display:none}
  .done{text-align:center;padding:70px 20px}
  .done h2{font-family:"Fraunces",serif;font-size:22px;margin-bottom:8px}
  .done p{color:var(--mid);font-size:14px}
</style></head>
<body>
<div class="wrap">
  <div class="mtop"><div class="nm">${escapeHtml(businessName)}</div></div>
  <div id="content">
    ${
      submitted
        ? `<div class="done"><h2>Thank you!</h2><p>We've received your message and will get back to you shortly.</p></div>`
        : `
    <h1>Tell us what happened</h1>
    <p class="sub">We're sorry things didn't go well. Let us know and we'll sort it out.</p>
    <textarea id="text" placeholder="What happened?"></textarea>
    <button class="submit" id="submitBtn">Submit</button>
    <div class="err" id="err"></div>
    `
    }
  </div>
</div>
<script>
const SUBMIT_PATH = ${JSON.stringify(submitPath)};
const CHAT_URL = ${JSON.stringify(chatUrl)};
const submitBtn = document.getElementById('submitBtn');
const errEl = document.getElementById('err');
if (submitBtn) {
  submitBtn.onclick = async function () {
    const text = document.getElementById('text').value.trim();
    if (!text) {
      errEl.textContent = 'Please tell us what happened first.';
      errEl.style.display = 'block';
      return;
    }
    errEl.style.display = 'none';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';
    try {
      const res = await fetch(SUBMIT_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text }),
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      document.getElementById('content').innerHTML = '<div class="done"><h2>Thank you!</h2><p>We\\'ve received your message'
        + (CHAT_URL ? ' and will get back to you shortly.<br>Taking you back to the chat\\u2026' : ' and will get back to you shortly.') + '</p></div>';
      // Chidera, 2026-09-24: same "hand them back, don't leave them
      // stranded" reasoning as the invoice/feedback pages -- back to the
      // SAME chat tab, not real WhatsApp, since that's where they came
      // from and where the ack bubble (handover's own reply) will show up.
      if (CHAT_URL) setTimeout(function () { window.location.href = CHAT_URL; }, 1100);
    } catch (err) {
      errEl.textContent = err.message || 'Could not submit -- please check your connection and try again.';
      errEl.style.display = 'block';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit';
    }
  };
}
</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
