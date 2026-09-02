// Shared by Orders.jsx (the kanban board -- buttons live right on the card,
// not only after opening an order, Chidera's call: "i want the button at
// the surface not when kanban is opened") and OrderDetail.jsx, so the two
// screens can never disagree about which action a given stage offers.
//
// Full pipeline: new -> confirmation -> preparation -> ready ->
// [pickup: completed] -> [delivery: in_transit -> completed].
//
// 'confirmation' means "customer has sent proof of payment (or a real
// Paystack payment landed) and it's pending staff's confirmation" -- NOT
// "already confirmed." There is no generic advance button for it here; the
// real action is the existing Confirm-payment control (needs the payment
// proof/amount in view, not a bare status click), and confirming payment
// itself (engine/flow.js's completePayment) moves the order straight to
// 'preparation' automatically -- there's nothing left to separately click
// once payment is confirmed.
//
// 'preparation' has one button, always labelled the same regardless of
// fulfilment_type -- clicking it is the single "food's ready" moment.
// Server-side (routes/api.js's /orders/:id/status), that one click is what
// triggers the own_riders rider alarm for a delivery order AND the
// ready-for-pickup customer notification for a pickup order -- both
// automatic from this one click, never two separate actions for the same
// real-world fact.
//
// 'ready' branches by fulfilment_type into the two different physical
// handoffs a person actually watches for: a pickup order's customer
// arriving and taking it (-> completed, done), or a delivery order's rider
// arriving and taking it (-> in_transit). Both are staff pressing a button
// at the moment they see it happen with their own eyes -- deliberately not
// automatic, because nothing else in the system can see that moment.
//
// 'in_transit' -> 'completed' IS automatic (routes/rider.js), the instant
// the rider enters the real delivery code the customer gave them -- no
// staff click for that one, the system already knows.
export function nextStageFor(order) {
  switch (order.status) {
    case 'preparation':
      return { label: 'Mark as ready', next: 'ready' };
    case 'ready':
      return order.fulfilment_type === 'pickup' ? { label: 'Picked up', next: 'completed' } : { label: 'Mark in delivery', next: 'in_transit' };
    case 'in_transit':
      return { label: 'Mark completed', next: 'completed' };
    default:
      return null;
  }
}

// No 'new' column (still-being-built-through-chat orders belong on
// Conversations, not here) and no separate 'delivery' column -- 'ready'
// already covers "waiting for a rider" for a delivery order, matching
// what actually happens the instant it's marked ready (dispatch fires
// right then).
export const ORDER_COLUMNS = [
  { key: 'confirmation', label: 'Confirmation', hint: 'needs a look' },
  { key: 'preparation', label: 'Preparation', hint: 'kitchen is on it' },
  { key: 'ready', label: 'Ready', hint: 'awaiting pickup/rider' },
  { key: 'in_transit', label: 'In transit', hint: 'rider has it' },
  { key: 'completed', label: 'Completed', hint: 'last 24h' },
];

// Completed orders drop off the board a day after they're done -- nothing
// is deleted, this is purely "don't let a growing pile of finished orders
// clutter what staff actually need to act on" (Chidera's call: "completed
// only lasts a day").
const COMPLETED_VISIBLE_MS = 24 * 60 * 60 * 1000;
export function isRecentlyCompleted(order) {
  return Date.now() - new Date(order.updated_at).getTime() < COMPLETED_VISIBLE_MS;
}
