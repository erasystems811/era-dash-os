#!/usr/bin/env node
// Regression check for esf-sheet.mjs / google-sheets.mjs's REQUEST SHAPES --
// mocks global fetch (no real Google account needed, same reasoning as
// google-auth.test.mjs stopping short of testing getAccessToken's real
// network call) so this can assert the actual URLs/methods/bodies sent are
// correct, which is the part most likely to have a silent bug (a wrong
// field name, wrong encoding) that a real API call would catch late and a
// syntax check would never catch at all.

import { generateKeyPairSync } from 'node:crypto';
import { provisionSheet } from './esf-sheet.mjs';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok: ${name}`);
}
async function checkAsync(name, fn) {
  await fn();
  passed++;
  console.log(`  ok: ${name}`);
}

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const fakeServiceAccount = {
  client_email: 'esf-sheets@fake-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs1', format: 'pem' }),
};

await checkAsync('no service account configured -> returns null, makes zero network calls', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls++;
    throw new Error('fetch should not have been called');
  };
  try {
    const result = await provisionSheet({ businessName: 'X', ownerEmail: 'x@example.com', serviceAccountJson: null });
    if (result !== null) throw new Error(`expected null, got ${result}`);
    if (calls !== 0) throw new Error(`expected zero fetch calls, got ${calls}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await checkAsync('a configured service account hits token -> create -> 3x write -> share, in order, with correct shapes', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = options?.body ? (typeof options.body === 'string' ? JSON.parse(options.body) : Object.fromEntries(options.body)) : null;
    calls.push({ url: String(url), method: options?.method, body });

    if (String(url) === 'https://oauth2.googleapis.com/token') {
      return { ok: true, json: async () => ({ access_token: 'fake-access-token' }) };
    }
    if (String(url) === 'https://sheets.googleapis.com/v4/spreadsheets') {
      return { ok: true, json: async () => ({ spreadsheetId: 'fake-sheet-id-123' }) };
    }
    if (String(url).startsWith('https://sheets.googleapis.com/v4/spreadsheets/fake-sheet-id-123/values/')) {
      return { ok: true, json: async () => ({}) };
    }
    if (String(url) === 'https://www.googleapis.com/drive/v3/files/fake-sheet-id-123/permissions') {
      return { ok: true, json: async () => ({}) };
    }
    throw new Error(`unexpected fetch call: ${url}`);
  };

  try {
    const spreadsheetId = await provisionSheet({ businessName: 'Grace Stores', ownerEmail: 'owner@gracestores.test', serviceAccountJson: fakeServiceAccount });

    check('returns the spreadsheetId from the create call', () => {
      if (spreadsheetId !== 'fake-sheet-id-123') throw new Error(`expected fake-sheet-id-123, got ${spreadsheetId}`);
    });

    check('exactly 6 calls: token, create, 3x write (Today/Attendance/History), share', () => {
      if (calls.length !== 6) throw new Error(`expected 6 calls, got ${calls.length}: ${calls.map((c) => c.url).join(', ')}`);
    });

    check('token exchange uses the JWT-bearer grant type', () => {
      if (calls[0].body.grant_type !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') throw new Error(`wrong grant_type: ${JSON.stringify(calls[0].body)}`);
    });

    check('create call POSTs a title and all three tab names, in Today/Attendance/History order', () => {
      const c = calls[1];
      if (c.method !== 'POST') throw new Error(`expected POST, got ${c.method}`);
      if (c.body.properties.title !== 'Grace Stores') throw new Error(`wrong title: ${JSON.stringify(c.body)}`);
      const tabTitles = c.body.sheets.map((s) => s.properties.title);
      if (tabTitles.join(',') !== 'Today,Attendance,History') throw new Error(`wrong tab order: ${tabTitles.join(',')}`);
    });

    check('each write call PUTs to the right tab\'s range with the generated-automatically warning on row 1', () => {
      const writeCalls = calls.slice(2, 5);
      const expectedTabs = ['Today', 'Attendance', 'History'];
      writeCalls.forEach((c, i) => {
        if (c.method !== 'PUT') throw new Error(`expected PUT, got ${c.method}`);
        if (!c.url.includes(`${encodeURIComponent(expectedTabs[i])}!A1`)) throw new Error(`expected range for tab "${expectedTabs[i]}", got url ${c.url}`);
        if (!/generated automatically/i.test(c.body.values[0][0])) throw new Error(`row 1 is not the generated-automatically warning: ${JSON.stringify(c.body.values[0])}`);
      });
    });

    check('share call grants Viewer (reader) to the owner\'s email, not Editor', () => {
      const c = calls[5];
      if (c.method !== 'POST') throw new Error(`expected POST, got ${c.method}`);
      if (c.body.role !== 'reader' || c.body.emailAddress !== 'owner@gracestores.test') throw new Error(`wrong share body: ${JSON.stringify(c.body)}`);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

console.log(`\n${passed} checks passed.`);
