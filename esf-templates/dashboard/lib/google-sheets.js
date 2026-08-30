// Flat copy of scripts/lib/google-sheets.mjs -- see google-auth.js's own
// comment for why a copy (not an import) lives here too. Only writeTab is
// actually used by this deployment (engine/sheet-sync.js) -- the sheet
// itself is created once at provision time by the control server's
// scripts/lib/esf-sheet.mjs, never by the running app. The create/share
// functions are kept here anyway so a client-side "regenerate my sheet"
// admin action (not built yet) doesn't need a third copy later.

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

export async function shareAsViewer(accessToken, spreadsheetId, email) {
  await googleFetch(`${DRIVE_BASE}/${spreadsheetId}/permissions`, accessToken, {
    method: 'POST',
    body: JSON.stringify({ role: 'reader', type: 'user', emailAddress: email }),
  });
}

export async function writeTab(accessToken, spreadsheetId, tabTitle, rows) {
  const range = `${tabTitle}!A1`;
  await googleFetch(`${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, accessToken, {
    method: 'PUT',
    body: JSON.stringify({ values: rows }),
  });
}
