// Chidera, 2026-09-25: "that customer reply coming in and staff seeing it
// pop in live without refreshing it." Verifies routes/api.js's SSE routes
// (GET /conversations/stream and GET /conversations/:id/stream) actually
// push the instant engine/flow.js's logMessage runs -- not just that the
// endpoint responds, but that a real event arrives on an open connection
// with no request made from the client side to trigger it, and that the
// scoped per-conversation stream stays scoped (doesn't wake a staff member
// reading one thread for every OTHER customer's message too).
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3943';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3943';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3943';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

// Node's fetch supports a streaming response body -- reads raw SSE frames
// off the wire the same way a browser's EventSource would, without pulling
// in a browser environment for this test.
async function waitForEvent(res, timeoutMs) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buf = '';
  try {
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ done: false, value: undefined }), 100)),
      ]);
      if (done) return false;
      if (value) buf += decoder.decode(value, { stream: true });
      if (/^data: update$/m.test(buf)) return true;
    }
    return false;
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function main() {
  await import('../server.js');
  const flow = await import('../engine/flow.js');

  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  // These routes are requireStaffApi-gated same as every other /api/conversations
  // route -- real staff session, not a bypass.
  const loginRes = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@samplerestaurant.test', password: 'testpass123' }),
  });
  const cookie = loginRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  assert(loginRes.status === 200 && !!cookie, 'staff login succeeded, got a real session cookie');
  const authed = (url) => fetch(url, { headers: { cookie } });

  const customerA = await flow.findOrCreateCustomer({ phoneNumber: '2348033330003', channel: 'whatsapp' });
  const customerB = await flow.findOrCreateCustomer({ phoneNumber: '2348033330004', channel: 'whatsapp' });

  // === 1. A's scoped stream must NOT fire for B's message ===
  const scopedForA = await authed(`${BASE}/api/conversations/${customerA.id}/stream`);
  assert(scopedForA.status === 200, 'scoped stream connects');
  assert(scopedForA.headers.get('content-type')?.includes('text/event-stream'), 'scoped stream sends the right content-type');
  const noiseCheck = waitForEvent(scopedForA, 1200);
  await flow.reply(customerB, 'irrelevant to A');
  assert((await noiseCheck) === false, 'A\'s scoped stream stays silent for a DIFFERENT customer\'s message');

  // === 2. A's scoped stream DOES fire for A's own message ===
  const scopedForA2 = await authed(`${BASE}/api/conversations/${customerA.id}/stream`);
  const realCheck = waitForEvent(scopedForA2, 3000);
  await flow.reply(customerA, 'a real bot reply for A');
  assert(await realCheck, 'scoped stream fires the instant a message is logged for THIS conversation');

  // === 3. The unscoped list stream fires for ANY conversation's message ===
  const listRes = await authed(`${BASE}/api/conversations/stream`);
  const listCheck = waitForEvent(listRes, 3000);
  await flow.reply(customerB, 'a real bot reply for B');
  assert(await listCheck, "unscoped /conversations/stream fires for any conversation's message");

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
