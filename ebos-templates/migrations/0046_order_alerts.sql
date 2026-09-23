-- Chidera, 2026-09-16: "a staff number should be able to get a confirmed
-- order after paystack has automatically confirmed payment on their
-- whatsapp without accessing the back end" -- a separate list from
-- handover_alerts (customer-service escalations): this one is who gets
-- pinged the moment a payment clears and an order is ready to start
-- preparing, kitchen/ops staff rather than whoever handles a complaint.
alter table staff add column if not exists order_alerts boolean not null default false;
