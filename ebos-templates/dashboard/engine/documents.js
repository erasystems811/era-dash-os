// Generated documents (Section 8/9 of the build schema) are rendered on
// request from the order/order_item/business data itself, not pre-baked
// PDFs -- one route (see routes/documents.js) renders whichever type this
// row asks for. Keeps this file to just recording that a document exists.
import { pool } from '../lib/db.js';

export async function createInvoice(order) {
  const url = `/documents/invoice/${order.id}`;
  await pool.query(`insert into generated_document (type, order_id, url) values ('invoice', $1, $2)`, [order.id, url]);
  return url;
}

export async function createReceipt(order) {
  const url = `/documents/receipt/${order.id}`;
  await pool.query(`insert into generated_document (type, order_id, url) values ('receipt', $1, $2)`, [order.id, url]);
  return url;
}
