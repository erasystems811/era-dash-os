// Chidera, 2026-09-24: "for things like drink just asks for your drinks
// cold or room temperature, the customer can type 1 cold and 1 room
// temperature and you just show it like that for staff." Storing
// whatever's typed verbatim already worked -- handlePendingItemQuestion
// (unchanged by this fix) takes the answer as plain text.trim(), no forced
// single-choice, no splitting/validation, straight into order_item.modification
// -- confirmed by reading, not retested here (reaching it through the real
// dispatch path needs a live Anthropic key this sandbox doesn't have, see
// detectWantsHuman's own no-stub gate). The real gap THIS fixes: a
// quantity>1 line's question never told the customer there WAS more than
// one, so nothing hinted a split answer was even possible. Confirms the
// prompt now names the real quantity and hints a split is fine once it's
// genuinely more than one, stays exactly as before for a single unit.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3957';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3957';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  const { rows: prodRows } = await pool.query(`insert into product (name, price, category) values ('Zobo Drink', 1200, 'DRINKS') returning id`);
  const productId = prodRows[0].id;
  await pool.query(`insert into product_question (product_id, question) values ($1, 'Cold or room temperature?')`, [productId]);

  // === 1. A single unit -- the prompt stays exactly as it always did, no quantity/hint noise. ===
  const soloCustomer = await flow.findOrCreateCustomer({ phoneNumber: '2348012369101', channel: 'whatsapp' });
  const { rows: soloOrderRows } = await pool.query(
    `insert into "order" (customer_id, reference, status, engine_state) values ($1, 'REF-QTYHINT-1', 'new', 'collect_info') returning *`,
    [soloCustomer.id]
  );
  await pool.query('insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, 1, 1200, $3)', [soloOrderRows[0].id, productId, soloCustomer.id]);
  await flow.finishItemsCollection(soloCustomer, soloOrderRows[0], '', { preferTextForQuestions: true });
  const { rows: soloMsg } = await pool.query(`select body from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`, [soloCustomer.id]);
  assert(/For your Zobo Drink, Cold or room temperature\?/.test(soloMsg[0].body), 'a single unit gets the plain, unhinted question, no "1x" prefix');
  assert(!/You have/.test(soloMsg[0].body), 'no split hint for a single unit -- nothing to split');

  // === 2. Quantity 2 -- the prompt now names the real quantity and hints a split is fine. ===
  const multiCustomer = await flow.findOrCreateCustomer({ phoneNumber: '2348012369102', channel: 'whatsapp' });
  const { rows: multiOrderRows } = await pool.query(
    `insert into "order" (customer_id, reference, status, engine_state) values ($1, 'REF-QTYHINT-2', 'new', 'collect_info') returning *`,
    [multiCustomer.id]
  );
  await pool.query('insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, 2, 1200, $3)', [multiOrderRows[0].id, productId, multiCustomer.id]);
  await flow.finishItemsCollection(multiCustomer, multiOrderRows[0], '', { preferTextForQuestions: true });
  const { rows: multiMsg } = await pool.query(`select body from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`, [multiCustomer.id]);
  assert(/For your 2x Zobo Drink, Cold or room temperature\?/.test(multiMsg[0].body), 'names the real quantity (2x) right in the question');
  assert(/You have 2.*split.*1 cold, 1 room temperature/i.test(multiMsg[0].body), 'and hints a split answer is fine, with a concrete example');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
