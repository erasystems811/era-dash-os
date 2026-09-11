// The invoice page is rendered on request from the order/order_item/
// business data itself (routes/documents.js's /invoice/:orderId), not a
// pre-baked PDF -- this just builds that URL in one place. There used to be
// a matching createReceipt() here too (a generated_document row + rendered
// "Receipt" page, auto-created the moment payment cleared) -- removed
// entirely, Chidera 2026-09-11: "receipts on dashboard are the actual
// payment proofs that the customers send that they confirm not ai
// generated pdf." The real receipt is the payment-proof photo itself
// (order_payment_proof, see routes/api.js's GET /documents and
// OrderDetail.jsx's Payment gallery), not a document the system generated
// restating the order total.
export async function createInvoice(order) {
  return `/documents/invoice/${order.id}`;
}
