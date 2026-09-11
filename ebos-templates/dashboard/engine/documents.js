// Generated documents (Section 8/9 of the build schema) are rendered on
// request from the order/order_item/business data itself, not pre-baked
// PDFs -- one route (see routes/documents.js) renders whichever type this
// row asks for. Keeps this file to just recording that a document exists.
import { pool } from '../lib/db.js';

// Invoices are no longer recorded in generated_document -- Chidera
// 2026-09-11: "can the place of documents stop storing invoice and only
// store receipts." The URL below still renders correctly with no row here
// (routes/documents.js's /invoice/:orderId builds the page straight from
// order/order_item/business, never reads generated_document).
export async function createInvoice(order) {
  return `/documents/invoice/${order.id}`;
}

export async function createReceipt(order) {
  const url = `/documents/receipt/${order.id}`;
  await pool.query(`insert into generated_document (type, order_id, url) values ('receipt', $1, $2)`, [order.id, url]);
  return url;
}
