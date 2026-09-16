import React from 'react';

// Chidera, 2026-09-16: "when i tap a new tab, why does it just stay white
// and blank for a while" -- every data-driven page was returning `null`
// while its own useEffect fetch was in flight, so a still-loading page and
// a genuinely broken one looked identical: plain white, nothing on screen.
// One shared, honest "loading" state instead, dropped in wherever a page
// used to just return null.
export default function Loading() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 240, color: 'var(--text-muted)' }}>
      <span className="loading-spinner" aria-label="Loading" />
    </div>
  );
}
