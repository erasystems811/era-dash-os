// Chidera, 2026-10-02: "she sells slippers and leather textured things...
// with product you cant predict its basically buy and sell or produce and
// sell, its not a service." product.order_type ('ready_made' vs
// 'made_to_order', migrations/0068_made_to_order.sql) is the per-item
// fact; made_to_order_config is the per-business settings that apply to
// it -- "not all do deposit or cutoff time all those are options", so
// deposit_percent/max_concurrent_jobs/same_day_cutoff_time are each
// checked independently below, never assumed to travel together.
import { pool } from '../lib/db.js';

// Same "select * from X_config limit 1, default off" shape as
// getDeliveryConfig (engine/delivery-zones.js) -- one business per
// deployment, so there's never more than one real row here.
export async function getMadeToOrderConfig() {
  const { rows } = await pool.query('select * from made_to_order_config limit 1');
  return rows[0] || { enabled: false, deposit_percent: null, max_concurrent_jobs: null, same_day_cutoff_time: null };
}

// What's actually in this order, split by product.order_type. Deliberately
// its own query rather than extending summariseOrder (flow.js) -- that
// function already has several callers that have no reason to know or
// care about made-to-order at all, and its own shape (lines/itemLines/
// total) is tuned for customer-facing messages, not this.
export async function splitOrderItemsByType(orderId) {
  const { rows } = await pool.query(
    `select p.order_type, oi.quantity, oi.price
     from order_item oi join product p on p.id = oi.product_id
     where oi.order_id = $1`,
    [orderId]
  );
  let madeToOrderSubtotal = 0;
  let readyMadeSubtotal = 0;
  for (const r of rows) {
    const lineTotal = Number(r.price) * r.quantity;
    if (r.order_type === 'made_to_order') madeToOrderSubtotal += lineTotal;
    else readyMadeSubtotal += lineTotal;
  }
  return { madeToOrderSubtotal, readyMadeSubtotal, hasMadeToOrderItems: madeToOrderSubtotal > 0 };
}

// The actual deposit math for a mixed cart: ready_made items (already in
// stock) are always charged in full right now -- only the made_to_order
// portion is ever split into a deposit + balance. Returns null when no
// deposit applies at all (no made-to-order items, config disabled, or no
// deposit_percent set) -- callers charge `order.total` as before in that
// case, completely unaffected.
export function computeDepositSplit({ total, madeToOrderSubtotal, deliveryFee, depositPercent }) {
  if (!madeToOrderSubtotal || !depositPercent) return null;
  const madeToOrderDeposit = Math.ceil((madeToOrderSubtotal * depositPercent) / 100);
  const depositAmount = Number(total) - Number(madeToOrderSubtotal) + madeToOrderDeposit;
  const balanceDue = Number(total) - depositAmount;
  if (balanceDue <= 0) return null;
  return { depositAmount, balanceDue };
}

// "not all product business do ready made or made to order, some do just
// ready made simply" -- a business with made_to_order_config.enabled =
// false (the default, including every business that's never touched this
// at all) always returns false here, same as one with no cap set.
export async function isAtConcurrentJobCap(config) {
  if (!config?.enabled || !config.max_concurrent_jobs) return { atCap: false, activeCount: 0 };
  const { rows } = await pool.query(
    `select count(distinct o.id) as count
     from "order" o join order_item oi on oi.order_id = o.id join product p on p.id = oi.product_id
     where p.order_type = 'made_to_order' and o.status in ('confirmation', 'preparation')`
  );
  const activeCount = Number(rows[0]?.count || 0);
  return { atCap: activeCount >= config.max_concurrent_jobs, activeCount };
}

// Pure time check, no DB -- same_day_cutoff_time is a plain `time` column
// (local wall-clock, no timezone), compared against `now`'s own local
// hours/minutes the same way. Exported separately from the caller so it's
// directly unit-testable without needing a real clock or a DB row.
export function isPastSameDayCutoff(cutoffTime, now = new Date()) {
  if (!cutoffTime) return false;
  const [h, m] = cutoffTime.split(':').map(Number);
  const cutoff = new Date(now);
  cutoff.setHours(h, m, 0, 0);
  return now.getTime() > cutoff.getTime();
}
