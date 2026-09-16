#!/usr/bin/env node
// Regression test for the new branch-WhatsApp-connect routes (Chidera's
// ask, 2026-09-16: "send a staff to onboard a client without needing
// code and it'll be done perfectly" -- specifically the per-branch
// WhatsApp connect half of that, routes/api.js's GET /branches/for-connect
// and POST /branch-channels/whatsapp). Tests the real SQL each route
// runs, not a paraphrase of it -- same standing pattern as every other
// sandbox test in this codebase.
//
// Set EBOS_TEST_PGLITE=1 to run against a real, throwaway, in-process
// Postgres (see lib/db.js) -- schema.sql is applied automatically.
import { pool } from '../lib/db.js';

let passed = 0;

async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok: ${name}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
}

// Mirrors exactly the SQL in routes/api.js's POST /branch-channels/whatsapp.
async function connectBranchWhatsapp({ branchId, phoneNumberId, accessToken, verifyToken }) {
  const { rows: branchRows } = await pool.query('select id from branch where id = $1', [branchId]);
  if (!branchRows.length) return { status: 404, body: { error: 'No branch with that id.' } };
  try {
    const { rows } = await pool.query(
      `insert into branch_channel (branch_id, channel, phone_number_id, access_token, verify_token)
       values ($1, 'whatsapp', $2, $3, $4)
       on conflict (branch_id, channel)
       do update set phone_number_id = excluded.phone_number_id, access_token = excluded.access_token, verify_token = excluded.verify_token
       returning branch_id, channel, phone_number_id`,
      [branchId, phoneNumberId, accessToken, verifyToken]
    );
    return { status: 200, body: rows[0] };
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'branch_channel_phone_number_id_idx') {
      return { status: 409, body: { error: 'This WhatsApp number is already connected to a different branch.' } };
    }
    throw err;
  }
}

async function main() {
  const { rows: bizRows } = await pool.query(
    `insert into business (name, type, address, phone_number) values ('Test Biz', 'restaurant', '1 Test Rd', '2348010000000') returning id`
  );
  const { rows: branchRows } = await pool.query(
    `insert into branch (business_id, name, address, is_primary) values ($1, 'Lekki', '1 Lekki Rd', true) returning id`,
    [bizRows[0].id]
  );
  const { rows: branch2Rows } = await pool.query(
    `insert into branch (business_id, name, address, is_primary) values ($1, 'Abuja', '1 Abuja Rd', false) returning id`,
    [bizRows[0].id]
  );
  const branchId = branchRows[0].id;
  const branch2Id = branch2Rows[0].id;

  console.log('=== GET /branches/for-connect equivalent ===');
  await check('lists branches, primary first', async () => {
    const { rows } = await pool.query(
      `select id, name, area, is_primary from branch where status != 'closed' order by is_primary desc, name`
    );
    assert(rows.length === 2, `expected 2 branches, got ${rows.length}`);
    assert(rows[0].id === branchId && rows[0].is_primary === true, 'expected the primary branch first');
  });

  console.log('=== First connect ===');
  await check('inserts a new branch_channel row', async () => {
    const result = await connectBranchWhatsapp({ branchId, phoneNumberId: 'pnid-1', accessToken: 'tok-1', verifyToken: 'verify-1' });
    assert(result.status === 200, `expected 200, got ${result.status}`);
    const { rows } = await pool.query('select * from branch_channel where branch_id = $1', [branchId]);
    assert(rows.length === 1, `expected exactly 1 row, got ${rows.length}`);
    assert(rows[0].phone_number_id === 'pnid-1', 'expected the phone number id to be saved');
  });

  console.log('=== Reconnect (rotated token) ===');
  await check('upserts the same row, does not duplicate', async () => {
    const result = await connectBranchWhatsapp({ branchId, phoneNumberId: 'pnid-1', accessToken: 'tok-2-rotated', verifyToken: 'verify-1' });
    assert(result.status === 200, `expected 200, got ${result.status}`);
    const { rows } = await pool.query('select * from branch_channel where branch_id = $1', [branchId]);
    assert(rows.length === 1, `expected still exactly 1 row after reconnect, got ${rows.length}`);
    assert(rows[0].access_token === 'tok-2-rotated', 'expected the access token to be updated in place');
  });

  console.log('=== A different branch tries to claim the same phone number ===');
  await check('refused with a clean 409, not a raw 500', async () => {
    const result = await connectBranchWhatsapp({ branchId: branch2Id, phoneNumberId: 'pnid-1', accessToken: 'tok-3', verifyToken: 'verify-3' });
    assert(result.status === 409, `expected 409, got ${result.status}`);
    assert(/already connected to a different branch/i.test(result.body.error), `got: ${result.body.error}`);
    const { rows } = await pool.query('select * from branch_channel where branch_id = $1', [branch2Id]);
    assert(rows.length === 0, 'the second branch must not have gotten a row out of the failed attempt');
  });

  console.log('=== A nonexistent branch id ===');
  await check('refused with a clean 404', async () => {
    const result = await connectBranchWhatsapp({ branchId: '00000000-0000-0000-0000-000000000000', phoneNumberId: 'pnid-9', accessToken: 'x', verifyToken: 'y' });
    assert(result.status === 404, `expected 404, got ${result.status}`);
  });

  console.log(`\n${passed} checks passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
