// The invoice page is rendered on request from the order/order_item/
// business data itself (routes/documents.js's /invoice/:orderId), not a
// pre-baked PDF -- this just builds that URL in one place.
export async function createInvoice(order) {
  return `/documents/invoice/${order.id}`;
}

// Chidera, 2026-09-11: "receipts on dashboard are the actual payment
// proofs that the customers send that they confirm not ai generated
// pdf." -- that was about the DASHBOARD's own record of a payment (staff
// looking at what proves this order was paid), which really is the
// customer's own uploaded proof image, not a document to invent. This is
// a different thing: 2026-09-25, "after payment is confirmed instead of
// the bare payment received, send customer a receipt" -- what the
// CUSTOMER receives over WhatsApp once payment clears, same idea as the
// invoice sent at checkout, just going the other direction. Same
// rendered-on-request shape as the invoice (routes/documents.js's
// /receipt/:orderId) -- no stored file, no generated_document row.
export async function createReceipt(order) {
  return `/documents/receipt/${order.id}`;
}
