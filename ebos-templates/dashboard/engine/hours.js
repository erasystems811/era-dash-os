// Out-of-hours handling, shared by the voice add-on (spec A9) and the
// regular WhatsApp/Instagram text flow (Chidera, 2026-09-16: tell a
// customer who messages while closed when the business opens, instead of
// answering normally). Deliberately its own small, structured format --
// `{ open: "HH:MM", close: "HH:MM" }`, applied every day -- rather than the
// separate business.operating_hours/branch.operating_hours free-text
// columns interpolated straight into an AI prompt elsewhere in this
// codebase. A real "is it open right now" decision needs something a
// program can actually compare, not a sentence an AI would have to
// re-interpret on every single message, which would mean cost, latency,
// and a wrong guess on a bad day, for a fact that's really just two
// numbers. Stored on branch.opening_hours (already a jsonb column, unused
// before this) -- a real place for a program to compare against, not text.
// A full day-by-day schedule is a natural next step once a real client
// actually needs one -- not built ahead of that need.
//
// Fixed to Africa/Lagos: every existing timezone default in this codebase
// (branch.timezone) already assumes it, and EBOS has no client outside
// Nigeria to make this configurable for yet.
function currentTimeInLagos(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const hh = parts.find((p) => p.type === 'hour').value;
  const mm = parts.find((p) => p.type === 'minute').value;
  return `${hh}:${mm}`;
}

function formatTime12h(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, '0')}${period}`;
}

// No `operating_hours` configured at all -- a business that hasn't set
// this up yet gets a genuinely working feature with sensible defaults
// (spec 0.7's "on" rule), not a feature that silently refuses every call
// until someone fills in a form. Always open until they actually set hours.
export function checkOperatingHours(operatingHours, now = new Date()) {
  if (!operatingHours?.open || !operatingHours?.close) return { open: true, opensAt: null };
  const current = currentTimeInLagos(now);
  const { open, close } = operatingHours;
  const isOpen = open <= close
    ? current >= open && current < close
    // Overnight hours (e.g. open 18:00, close 02:00) wrap past midnight --
    // "closed" is the gap between close and open, not a literal range
    // comparison.
    : current >= open || current < close;
  return { open: isOpen, opensAt: isOpen ? null : formatTime12h(open) };
}
