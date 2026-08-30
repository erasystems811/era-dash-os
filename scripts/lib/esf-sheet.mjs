// Provisions the Google Sheet for a new ESF business -- build schema v2.0
// section 9.4's "the owner never creates or shares a sheet by hand" step,
// called once by create-client.mjs at provision time (not from inside the
// deployed dashboard -- that's engine/sheet-sync.js's periodic re-sync,
// esf-templates/dashboard's own copy of google-auth.js/google-sheets.js).

import { getAccessToken } from './google-auth.mjs';
import { createSpreadsheet, shareAsViewer, writeTab } from './google-sheets.mjs';

const SCOPES = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file';
const TABS = ['Today', 'Attendance', 'History'];
const WARNING_ROW = ['Generated automatically -- edits here are not saved.'];

// Returns the new spreadsheetId, or null if no service account is
// configured -- Sheet provisioning is optional (create-client.mjs still
// works without it, same as --whatsapp/--payment being opt-in toggles),
// not a hard requirement to provision an ESF business.
export async function provisionSheet({ businessName, ownerEmail, serviceAccountJson }) {
  if (!serviceAccountJson) return null;

  const accessToken = await getAccessToken(serviceAccountJson, SCOPES);
  const spreadsheetId = await createSpreadsheet(accessToken, { title: businessName, tabs: TABS });
  for (const tab of TABS) {
    await writeTab(accessToken, spreadsheetId, tab, [WARNING_ROW, ['(no data yet)']]);
  }
  await shareAsViewer(accessToken, spreadsheetId, ownerEmail);
  return spreadsheetId;
}
