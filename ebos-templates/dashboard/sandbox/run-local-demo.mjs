// One-off local demo runner -- Chidera, 2026-09-23: "I NEED TO TEST NOWWWW."
// Starts the real server AND creates the demo customer in the SAME
// process (one shared in-memory pglite instance), then keeps listening.
// Previous attempt ran these as two separate node processes, each with
// its own throwaway database -- the generated link pointed at a customer
// that only ever existed in a process that had already exited by the
// time anyone clicked it.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3950';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3950';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

await import('../server.js');
const { pool } = await import('../lib/db.js');
const flow = await import('../engine/flow.js');

for (let i = 0; i < 50; i++) {
  try { await fetch('http://localhost:3950/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

const phoneNumber = '2348010001111';
await flow.handleInboundMessage({ phoneNumber, text: 'hi', channel: 'whatsapp', messageId: 'demo-m1' });
await new Promise((r) => setTimeout(r, flow.DEBOUNCE_MS + 1000));
const customer = await flow.findOrCreateCustomer({ phoneNumber, channel: 'whatsapp' });
const { rows } = await pool.query('select menu_token from customers where id = $1', [customer.id]);
console.log('\n\n=== OPEN THIS LINK ===');
console.log('http://localhost:3950/wa/' + rows[0].menu_token);
console.log('=======================\n');
