// A real rating FORM, not free text -- Chidera 2026-09-11: "i told you to
// make your own rating form not your own text" (a correction after an
// earlier chat-based, AI-parsed "reply with 3 numbers" attempt). A real
// WhatsApp Flow (Meta's own native form) needs authoring and registering
// with Meta first; this is our own web page instead -- same pattern
// already proven for the web menu (engine/menu-page-template.js) and
// tracking (engine/tracking-page-template.js) pages, opened via a plain
// cta_url button (engine/flow.js's sendFeedbackRequest), no Meta approval
// needed for any of it. Same warm paper/Fraunces/Inter app-shell as those
// two pages, not a bare form.
export function renderFeedbackFormPage({ businessName, reference, submitted, submitPath }) {
  return `<!doctype html>
<html style="background:#F6F1E8"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>Rate your order</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap"></noscript>
<style>
  :root{--paper:#F6F1E8;--ink:#1C1815;--mid:#6E6156;--line:#E2D9CB;--hot:#C5452B;--wa:#0F7A5A}
  *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
  html,body{height:100%;background:#F6F1E8}
  body{font-family:"Inter",system-ui,sans-serif;background:var(--paper);color:var(--ink);line-height:1.5;min-height:100vh;min-height:100dvh}
  .wrap{max-width:420px;margin:0 auto;padding:28px 18px calc(28px + env(safe-area-inset-bottom))}
  .mtop{background:var(--ink);color:var(--paper);padding:18px 18px;border-radius:14px;margin-bottom:20px}
  .mtop .nm{font-family:"Fraunces",serif;font-size:19px;font-weight:700}
  .mtop .mt{font-size:11.5px;color:#B3A597;margin-top:3px}
  h1{font-family:"Fraunces",serif;font-size:21px;font-weight:700;margin-bottom:4px}
  .sub{color:var(--mid);font-size:13.5px;margin-bottom:22px}
  .q{margin-bottom:22px}
  .q label{display:block;font-size:14px;font-weight:600;margin-bottom:10px}
  .stars{display:flex;gap:6px}
  .stars button{background:none;border:0;font-size:32px;line-height:1;padding:2px;cursor:pointer;color:var(--line);touch-action:manipulation}
  .stars button.on{color:var(--hot)}
  textarea{width:100%;border:1px solid var(--line);border-radius:10px;padding:11px 12px;font-family:inherit;font-size:14px;background:#fff;resize:vertical;min-height:70px}
  .submit{display:block;width:100%;margin-top:6px;background:var(--wa);color:#fff;border:0;font-family:inherit;font-weight:600;font-size:15px;padding:13px;border-radius:999px;touch-action:manipulation}
  .submit:disabled{opacity:.5}
  .err{color:var(--hot);font-size:13px;margin-top:10px;display:none}
  .done{text-align:center;padding:70px 20px}
  .done h2{font-family:"Fraunces",serif;font-size:22px;margin-bottom:8px}
  .done p{color:var(--mid);font-size:14px}
</style></head>
<body>
<div class="wrap">
  <div class="mtop"><div class="nm">${escapeHtml(businessName)}</div><div class="mt">Order ${escapeHtml(reference)}</div></div>
  <div id="content">
    ${
      submitted
        ? `<div class="done"><h2>Thank you!</h2><p>You've already rated this order.</p></div>`
        : `
    <h1>Rate your order</h1>
    <p class="sub">Tap to rate each one, 1 to 5 stars.</p>
    <div class="q"><label>How was your experience?</label><div class="stars" data-field="experience"></div></div>
    <div class="q"><label>How was the food?</label><div class="stars" data-field="food"></div></div>
    <div class="q"><label>How was the service?</label><div class="stars" data-field="service"></div></div>
    <div class="q"><label>Anything else? (optional)</label><textarea id="comment" placeholder="Tell us more..."></textarea></div>
    <button class="submit" id="submitBtn">Submit</button>
    <div class="err" id="err"></div>
    `
    }
  </div>
</div>
<script>
const SUBMIT_PATH = ${JSON.stringify(submitPath)};
const ratings = { experience: 0, food: 0, service: 0 };
document.querySelectorAll('.stars').forEach(function (row) {
  const field = row.dataset.field;
  for (let n = 1; n <= 5; n++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = '★';
    b.dataset.n = n;
    b.onclick = function () { ratings[field] = n; paint(row, n); };
    row.appendChild(b);
  }
});
function paint(row, n) {
  row.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', Number(b.dataset.n) <= n); });
}
const submitBtn = document.getElementById('submitBtn');
const errEl = document.getElementById('err');
if (submitBtn) {
  submitBtn.onclick = async function () {
    if (!ratings.experience || !ratings.food || !ratings.service) {
      errEl.textContent = 'Please rate all three before submitting.';
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
        body: JSON.stringify({ experience: ratings.experience, food: ratings.food, service: ratings.service, comment: document.getElementById('comment').value }),
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      document.getElementById('content').innerHTML = '<div class="done"><h2>Thank you!</h2><p>Your feedback has been sent.</p></div>';
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

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
