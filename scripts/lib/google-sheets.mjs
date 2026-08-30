// Thin wrapper over the Sheets v4 and Drive v3 REST APIs -- raw fetch, no
// googleapis dependency (see google-auth.mjs's own comment for why). Not
// ESF-specific on purpose: build-schema v2.0 section 9.4's "create, tab,
// share, write" sequence is the only thing that calls this, but nothing
// here assumes ESF's schema.

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3/files';

async function googleFetch(url, accessToken, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', ...options.headers },
  });
  if (!res.ok) throw new Error(`Google API call failed ${res.status} ${url}: ${await res.text()}`);
  return res.json();
}

// Creates a spreadsheet with the given tab titles (in order) and a header
// row already written into row 1 of each -- row 1 is always the
// "generated automatically, edits here are not saved" warning (build
// schema v2.0 section 9, rule 1), never left for the caller to remember.
export async function createSpreadsheet(accessToken, { title, tabs }) {
  const created = await googleFetch(SHEETS_BASE, accessToken, {
    method: 'POST',
    body: JSON.stringify({
      properties: { title },
      sheets: tabs.map((tabTitle) => ({ properties: { title: tabTitle } })),
    }),
  });
  return created.spreadsheetId;
}

// Viewer only -- build schema v2.0 section 9.4: nothing is ever read back
// from a sheet, so there is no reason to grant Editor.
export async function shareAsViewer(accessToken, spreadsheetId, email) {
  await googleFetch(`${DRIVE_BASE}/${spreadsheetId}/permissions`, accessToken, {
    method: 'POST',
    body: JSON.stringify({ role: 'reader', type: 'user', emailAddress: email }),
  });
}

// Overwrites one tab's full range with `rows` (array of arrays). RAW input
// -- values are written exactly as given, no formula/date reinterpretation
// -- since every value here is already the exact display text the engine
// computed.
export async function writeTab(accessToken, spreadsheetId, tabTitle, rows) {
  const range = `${tabTitle}!A1`;
  await googleFetch(`${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, accessToken, {
    method: 'PUT',
    body: JSON.stringify({ values: rows }),
  });
}
