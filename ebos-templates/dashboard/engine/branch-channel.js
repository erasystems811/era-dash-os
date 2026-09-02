// Per-branch WhatsApp (and later voice/Instagram) credentials -- kept in its
// own table rather than on `branch` itself, since a branch's number/token
// pair is really "the WhatsApp channel's own config", not a property of the
// location, and other channels will want the same shape later.
//
// Deliberately built to stay completely inert for every business that
// hasn't set one of these up: with zero branch_channel rows, every function
// here returns null, and every caller already falls back to the single
// shared env-var pair (whatsapp-send.js) exactly as before this file
// existed. Nothing in the conversational flow changes until a real row is
// added from the dashboard.
import { pool } from '../lib/db.js';

// Resolves an inbound WhatsApp message's business phone_number_id
// (Meta webhook payload's change.value.metadata.phone_number_id) to the
// branch that number belongs to -- same zero/one/many idiom used
// everywhere else branch logic lives (see fields.js's branchOptions):
//   - no branch_channel rows configured at all -> null (not resolved by
//     channel; a shared-number business asks the customer instead, or a
//     single-branch business needs no resolution at all)
//   - a real match -> that branch's id
//   - rows exist but none match this phone_number_id (a deprovisioned or
//     misconfigured number) -> null, logged loudly, never silently
//     misroutes a customer to the wrong branch
export async function resolveBranchByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  const { rows } = await pool.query(
    `select branch_id from branch_channel where channel = 'whatsapp' and phone_number_id = $1`,
    [phoneNumberId]
  );
  if (rows[0]) return rows[0].branch_id;

  const { rows: any } = await pool.query(`select 1 from branch_channel where channel = 'whatsapp' limit 1`);
  if (any.length) {
    console.error(`No branch_channel configured for WhatsApp phone_number_id ${phoneNumberId} -- falling back to unresolved.`);
  }
  return null;
}

// The real send credentials for a branch's WhatsApp number, or null when
// this branch has none configured -- whatsapp-send.js treats null as "use
// the single shared env-var pair", so every existing caller keeps working
// unchanged until a real branch_channel row exists.
export async function getWhatsAppCredentials(branchId) {
  if (!branchId) return null;
  const { rows } = await pool.query(
    `select phone_number_id, access_token from branch_channel where channel = 'whatsapp' and branch_id = $1`,
    [branchId]
  );
  if (!rows[0]) return null;
  return { phoneNumberId: rows[0].phone_number_id, accessToken: rows[0].access_token };
}
