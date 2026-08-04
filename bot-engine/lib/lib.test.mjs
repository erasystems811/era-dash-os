// Throwaway functional check -- proves the lib actually behaves as
// intended, not just that it parses. Not part of the real test harness
// (bot-engine/tests/ will be that, built later against real fixtures).
import assert from 'node:assert/strict';
import {
  defineStates,
  defineField,
  extractField,
  sanitizeText,
  formatInternalMessage,
  handoffIntro,
  sendMessage,
  recordRelayTarget,
  resolveSwipeReply,
  resolveByNamePrefix,
  detectExplicitRoleRequest,
  sendWakeTemplateIfNeeded,
  shouldFlushQueuedMessage,
} from './index.js';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// states.js
const sm = defineStates({ inquiry: ['invoiced'], invoiced: ['paid'], paid: [] });
check('valid transition allowed', () => assert.equal(sm.canTransition('inquiry', 'invoiced'), true));
check('invalid transition blocked', () => assert.equal(sm.canTransition('inquiry', 'paid'), false));
check('assertTransition throws on bad move', () => assert.throws(() => sm.assertTransition('paid', 'inquiry')));
check('unknown state throws', () => assert.throws(() => sm.canTransition('bogus', 'paid')));

// extract.js
const dateField = defineField({ key: 'event_date', label: 'event date', type: 'date' });
const fakeAskJson = async (prompt) => {
  assert.match(prompt, /Never invent a missing part/);
  return { event_date: null };
};
const r1 = await extractField(dateField, 'the 23rd', { askJson: fakeAskJson });
check('date field returns null instead of guessing', () => assert.equal(r1, null));

const nameField = defineField({ key: 'name', label: 'name' });
const r2 = await extractField(nameField, 'mad party entertainment', { askJson: async () => ({ name: 'mad party entertainment' }) });
check('lowercase name accepted as-is', () => assert.equal(r2, 'mad party entertainment'));

// send.js
check('plain text passes sanitizeText', () => assert.equal(sanitizeText('Your total is 50000 naira.'), 'Your total is 50000 naira.'));
check('asterisk is rejected', () => assert.throws(() => sanitizeText('*bold*')));
check('leading bullet dash is rejected', () => assert.throws(() => sanitizeText('- item one')));
check('double dash is rejected', () => assert.throws(() => sanitizeText('wait -- really?')));
check('hyphen inside a word is allowed', () => assert.equal(sanitizeText('please check-in by 5pm.'), 'please check-in by 5pm.'));
check('date-style hyphen is allowed', () => assert.equal(sanitizeText('date: 12-08-2026'), 'date: 12-08-2026'));

check('internal message gets role prefix', () =>
  assert.equal(formatInternalMessage({ role: 'HR', senderName: 'Amaka', roleHasMultiplePeople: true }, 'please review'), 'HR(Amaka): please review')
);
check('single-person role has no name suffix', () =>
  assert.equal(formatInternalMessage({ role: 'PM', senderName: 'Sarah', roleHasMultiplePeople: false }, 'ok'), 'PM: ok')
);
check('handoff intro reads correctly', () =>
  assert.equal(handoffIntro({ staffName: 'Sarah', staffRole: 'sales lead' }), 'Hi, my name is Sarah, I am the sales lead. You will now be speaking with me.')
);

let sent = null;
await sendMessage({ trigger: 'bot_flow_step', to: '234...', text: 'thanks', whatsappSend: async (to, text) => { sent = { to, text }; } });
check('sendMessage works with a valid trigger', () => assert.deepEqual(sent, { to: '234...', text: 'thanks' }));
let threw = false;
try {
  await sendMessage({ trigger: undefined, to: '234...', text: 'thanks', whatsappSend: async () => {} });
} catch { threw = true; }
check('sendMessage rejects a missing/invalid trigger', () => assert.equal(threw, true));

// swipe-reply.js
const fakeRows = [];
const fakeDb = {
  insert: async (table, row) => fakeRows.push(row),
  select: async (table, where) => fakeRows.filter((r) => r.whatsapp_message_id === where.whatsapp_message_id),
};
await recordRelayTarget(fakeDb, { whatsappMessageId: 'wamid1', targetPhoneNumber: '234111' });
const found1 = await resolveSwipeReply(fakeDb, 'wamid1');
check('swipe reply resolves the right target', () => assert.equal(found1.target_phone_number, '234111'));
const found2 = await resolveSwipeReply(fakeDb, 'wamid1');
check('same message can be swiped again (not consumed)', () => assert.equal(found2.target_phone_number, '234111'));

const nameResult = await resolveByNamePrefix('Sarah: please confirm the date', async (frag) => (frag === 'Sarah' ? { id: 1, name: 'Sarah' } : null));
check('name-prefix fallback routes correctly', () => assert.deepEqual(nameResult, { contact: { id: 1, name: 'Sarah' }, message: 'please confirm the date' }));

// handoff.js
const roleMatch = await detectExplicitRoleRequest({
  message: 'can I speak to a manager please',
  roles: [{ key: 'manager', label: 'manager', requestable: true }, { key: 'lawyer', label: 'lawyer', requestable: false }],
  askJson: async () => ({ role_key: 'manager' }),
});
check('explicit role request resolves to the requestable role', () => assert.equal(roleMatch.key, 'manager'));
const noRoles = await detectExplicitRoleRequest({ message: 'hi', roles: [], askJson: async () => ({ role_key: null }) });
check('no requestable roles means no match, no LLM call needed', () => assert.equal(noRoles, null));

// wake-template.js
let templateSent = false;
let queued = null;
const oldTimestamp = new Date(Date.now() - 30 * 36e5).toISOString();
const res1 = await sendWakeTemplateIfNeeded({
  lastCustomerMessageAt: oldTimestamp,
  sendTemplate: async () => { templateSent = true; },
  queuePendingText: async (t) => { queued = t; },
  businessName: 'Bali',
  pendingText: 'your invoice is ready',
});
check('wake template sent when outside 24h window', () => assert.equal(res1.sentTemplate, true));
check('pending text queued, not sent directly', () => assert.equal(queued, 'your invoice is ready'));
check('template actually sent', () => assert.equal(templateSent, true));

const recentTimestamp = new Date().toISOString();
const res2 = await sendWakeTemplateIfNeeded({
  lastCustomerMessageAt: recentTimestamp,
  sendTemplate: async () => { throw new Error('should not be called'); },
  queuePendingText: async () => {},
  businessName: 'Bali',
  pendingText: 'hello',
});
check('no template needed inside the window', () => assert.equal(res2.sentTemplate, false));

check('any reply flushes queued content, not just "ok"', () => assert.equal(shouldFlushQueuedMessage({ hasQueuedMessage: true }), true));

console.log(`\n${passed} checks passed.`);
