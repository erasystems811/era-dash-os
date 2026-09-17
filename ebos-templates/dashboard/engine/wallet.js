// Chidera, 2026-09-17: "i give them 1500 free every month then they cover
// the rest by putting money in an account and i extract it from there if
// not it wont go" -- WhatsApp's own per-message billing (Meta pricing
// change, effective 2026-10-01) gives no self-service spending cap, so
// this is ERA's own prepaid wallet, checked once per outbound message
// right before it actually goes out (whatsapp-send.js's postMessage, the
// one real place every send funnels through -- same "one choke point"
// reasoning as claude.js's own callClaude).
//
// Deliberately off by default (message_wallet.enabled) and not wired into
// any live business yet -- built and left dormant on Chidera's own
// explicit call, after today's earlier Haiku regression: prove it works
// before anyone's real customers depend on it.
import { pool } from '../lib/db.js';

// A single atomic UPDATE ... FROM ... WHERE ... RETURNING, not a
// read-then-write -- two messages sent within the same instant (a
// realistic case: a button send immediately followed by a text send, see
// flow.js's own many two-part replies) must never both read the same
// pre-deduction balance and both think they can afford to send. Postgres
// row-locks the matched row for the duration of one UPDATE, which a
// separate read-then-write pair of queries cannot guarantee.
//
// Wrapped in try/catch and fails OPEN (allows the send) on any error,
// deliberately -- this runs on literally every outbound WhatsApp message
// now (whatsapp-send.js's postMessage), for every business, whether or
// not that business has ever heard of the wallet. A real customer message
// must never be silently dropped because of a wallet-tracking problem
// (a migration not yet run on this specific database being the most
// likely one, since 0048_message_wallet.sql doesn't reach an existing
// client until its own migrate job runs) -- that would be this feature
// causing exactly the kind of regression it's supposed to prevent.
export async function canSendAndCharge() {
  let enabled;
  try {
    const { rows } = await pool.query('select enabled from message_wallet limit 1');
    enabled = rows[0]?.enabled;
  } catch (err) {
    console.error('canSendAndCharge: could not read message_wallet, allowing send:', err.message);
    return true;
  }
  // No wallet row, or one that exists but isn't enabled, means this
  // business hasn't opted into the wallet at all -- unrestricted, exactly
  // today's behavior.
  if (!enabled) return true;

  const currentMonth = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
  try {
    const { rows } = await pool.query(
      `with target as (
         select business_id,
           (case when free_reset_month = $1 then free_messages_this_month else 0 end) as free_used,
           free_messages_per_month, balance_kobo, rate_kobo_per_message
         from message_wallet
         where enabled = true
         limit 1
       ),
       decision as (
         select *,
           (free_used < free_messages_per_month) as use_free,
           (free_used >= free_messages_per_month and balance_kobo >= rate_kobo_per_message) as use_paid
         from target
       )
       update message_wallet w
       set free_reset_month = $1,
           free_messages_this_month = case when d.use_free then d.free_used + 1 else d.free_used end,
           balance_kobo = case when d.use_paid then w.balance_kobo - d.rate_kobo_per_message else w.balance_kobo end
       from decision d
       where w.business_id = d.business_id and (d.use_free or d.use_paid)
       returning true as sent`,
      [currentMonth]
    );
    // A row that's enabled but matched no UPDATE (neither use_free nor
    // use_paid) means genuinely out of free messages AND out of balance --
    // that's the one real, intentional "don't send" case.
    return rows.length > 0;
  } catch (err) {
    console.error('canSendAndCharge: charge query failed, allowing send:', err.message);
    return true;
  }
}

// For the dashboard's own Settings display and the panel's manual credit
// action -- read-only, no side effect, unlike canSendAndCharge above.
export async function getWalletStatus() {
  const { rows } = await pool.query('select * from message_wallet limit 1');
  return rows[0] || null;
}

// ERA's own manual top-up (Chidera: "i extract it from there" -- money
// comes to her directly, outside this codebase, e.g. bank transfer; this
// just credits the balance once she's actually received it). Positive
// amounts only -- a correction/refund is a separate, deliberate action,
// not something this same function should silently also allow via a
// negative number.
export async function creditWallet(kobo) {
  if (!Number.isInteger(kobo) || kobo <= 0) throw new Error('Credit amount must be a positive whole number of kobo.');
  const { rows } = await pool.query(
    `insert into message_wallet (business_id, balance_kobo)
     values ((select id from business limit 1), $1)
     on conflict (business_id) do update set balance_kobo = message_wallet.balance_kobo + $1
     returning *`,
    [kobo]
  );
  return rows[0];
}
