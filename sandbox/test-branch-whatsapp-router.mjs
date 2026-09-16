#!/usr/bin/env node
// Regression test for the branch-WhatsApp control-plane pieces (Chidera's
// ask, 2026-09-16) that aren't reachable from a plain DB test: the
// registry array merge in panel/server.js's POST /api/connect/:token/complete,
// and the webhook phone_number_id match in wa-router/server.js (and its
// mirror in panel/server.js). Mirrors the exact logic each file runs,
// same as this codebase's other sandbox tests mirror exact SQL.
//
// No env vars needed -- pure logic, no database, no network.
import { upsertClient, findClient } from '../scripts/lib/registry.mjs';

let passed = 0;

function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok: ${name}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
}

// Mirrors exactly the read-then-append block in panel/server.js's
// POST /api/connect/:token/complete branch path.
function addBranchPhoneNumberId(registry, clientName, phoneNumberId) {
  const existing = findClient(registry, clientName);
  const ids = new Set(existing?.whatsappBranchPhoneNumberIds || []);
  ids.add(phoneNumberId);
  upsertClient(registry, { name: clientName, whatsappBranchPhoneNumberIds: [...ids] });
}

// Mirrors exactly the match in wa-router/server.js (and panel/server.js's
// own copy of the same webhook handler).
function findClientForPhoneNumber(registry, phoneNumberId) {
  return registry.clients.find(
    (c) => c.whatsappPhoneNumberId === phoneNumberId || (c.whatsappBranchPhoneNumberIds || []).includes(phoneNumberId)
  );
}

function main() {
  console.log('=== Registry merge: connecting a first branch ===');
  check('adds the id without touching any other client field', () => {
    const registry = { clients: [{ name: 'mama-put', whatsappPhoneNumberId: 'business-pnid', isEbos: true }] };
    addBranchPhoneNumberId(registry, 'mama-put', 'pnid-lekki');
    const client = findClient(registry, 'mama-put');
    assert(client.whatsappPhoneNumberId === 'business-pnid', 'the pre-existing business-level number must survive untouched');
    assert(client.isEbos === true, 'unrelated fields must survive the merge');
    assert(JSON.stringify(client.whatsappBranchPhoneNumberIds) === JSON.stringify(['pnid-lekki']), 'expected exactly one branch id');
  });

  console.log('=== Registry merge: connecting a second branch ===');
  check('appends without dropping the first branch id (the shallow-merge trap)', () => {
    const registry = { clients: [{ name: 'mama-put', whatsappBranchPhoneNumberIds: ['pnid-lekki'] }] };
    addBranchPhoneNumberId(registry, 'mama-put', 'pnid-abuja');
    const client = findClient(registry, 'mama-put');
    assert(client.whatsappBranchPhoneNumberIds.includes('pnid-lekki'), 'the first branch id must not be dropped');
    assert(client.whatsappBranchPhoneNumberIds.includes('pnid-abuja'), 'the new branch id must be present');
    assert(client.whatsappBranchPhoneNumberIds.length === 2, `expected exactly 2 ids, got ${client.whatsappBranchPhoneNumberIds.length}`);
  });

  console.log('=== Registry merge: reconnecting the same branch (rotated number) ===');
  check('deduplicates instead of storing the same id twice', () => {
    const registry = { clients: [{ name: 'mama-put', whatsappBranchPhoneNumberIds: ['pnid-lekki'] }] };
    addBranchPhoneNumberId(registry, 'mama-put', 'pnid-lekki');
    const client = findClient(registry, 'mama-put');
    assert(client.whatsappBranchPhoneNumberIds.length === 1, `expected still 1 id, got ${client.whatsappBranchPhoneNumberIds.length}`);
  });

  console.log('=== Webhook router: matching a business-level number ===');
  check('finds the client via the scalar field, exactly as before this change', () => {
    const registry = { clients: [{ name: 'mama-put', whatsappPhoneNumberId: 'business-pnid' }] };
    const client = findClientForPhoneNumber(registry, 'business-pnid');
    assert(client?.name === 'mama-put', 'expected to find mama-put via the business-level field');
  });

  console.log('=== Webhook router: matching a branch-level number ===');
  check('finds the client via the new array field -- this is the real fix', () => {
    const registry = { clients: [{ name: 'mama-put', whatsappPhoneNumberId: 'business-pnid', whatsappBranchPhoneNumberIds: ['pnid-lekki', 'pnid-abuja'] }] };
    const client = findClientForPhoneNumber(registry, 'pnid-abuja');
    assert(client?.name === 'mama-put', 'expected to find mama-put via a branch-level number -- this used to silently fail');
  });

  console.log('=== Webhook router: a genuinely unknown number ===');
  check('finds nobody, same as before -- no false positive introduced', () => {
    const registry = { clients: [{ name: 'mama-put', whatsappPhoneNumberId: 'business-pnid', whatsappBranchPhoneNumberIds: ['pnid-lekki'] }] };
    const client = findClientForPhoneNumber(registry, 'totally-unknown-pnid');
    assert(client === undefined, 'expected no match for an unrelated number');
  });

  console.log(`\n${passed} checks passed.`);
}

main();
