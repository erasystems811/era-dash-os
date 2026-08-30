// Used by routes/documents.js to render the invoice/receipt pages -- those
// stay server-rendered HTML (they're printable documents sent to
// customers, not part of the interactive React dashboard).
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
