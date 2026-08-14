export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function layout({ title, staff, body }) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${esc(title)} — EBOS</title>
<style>
  body { font-family: sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  td, th { border: 1px solid #ccc; padding: 6px 10px; text-align: left; font-size: 14px; }
  fieldset { margin: 1rem 0; }
  label { display: block; margin: 6px 0 2px; font-size: 14px; }
  input, select, textarea { padding: 4px; width: 260px; }
  button { margin-top: 10px; padding: 6px 14px; cursor: pointer; }
  nav { margin-bottom: 1.5rem; }
  nav a { margin-right: 14px; }
  .danger { color: #b00; }
  .muted { color: #666; font-size: 13px; }
</style>
</head>
<body>
  ${staff ? `<nav><a href="/">Businesses</a>${staff.businessId ? ` | <a href="/businesses/${esc(staff.businessId)}/catalogue">Catalogue</a>` : ''} | <span class="muted">${esc(staff.name)} (${esc(staff.role)})</span> | <a href="/logout">Log out</a></nav>` : ''}
  <h1>${esc(title)}</h1>
  ${body}
</body>
</html>`;
}
