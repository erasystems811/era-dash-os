-- Chidera, 2026-09-20: "totally stop sending account number for era demo
-- and use just paystack." A top-up (extra items added to an already-paid
-- order) was deliberately bank-transfer-only until now -- its own comment
-- in flow.js said Paystack's reference has to be unique per charge, and
-- reusing order.reference (as the main invoice used to, unconditionally)
-- would collide with the original payment. Same fix as the main invoice's
-- own reference-collision bug: a genuinely unique reference per attempt,
-- persisted on the topup's own row so it can be looked up and auto-
-- confirmed independently of the order it belongs to.
alter table order_topup add column if not exists payment_reference text;
alter table order_topup add column if not exists payment_link_url text;
