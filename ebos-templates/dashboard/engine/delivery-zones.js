// Address-to-zone resolution -- deterministic, never AI. A wrong zone means
// a wrong price charged to a customer and a wrong amount paid to a rider,
// both real money (spec B5), so this matches on plain substring containment
// against a zone's name and aliases, the same "never guess" discipline
// already used elsewhere in this engine for anything a wrong guess would
// cost money over (see flow.js's classifyPureAck -- deterministic for the
// same class of reason). No match returns null; the caller's job is to
// treat that as "ask a human", never to fall back to a nearby-sounding zone.
import { pool } from '../lib/db.js';

// Whole-deployment toggle (delivery_config is keyed on business_id, a true
// singleton -- see schema.sql's own comment on why this table alone isn't
// branch_id like every other table in this add-on). Kept here rather than
// in engine/delivery-dispatch.js so both flow.js and delivery-dispatch.js
// can import it without a circular dependency between the two.
export async function getDeliveryConfig() {
  const { rows } = await pool.query('select * from delivery_config limit 1');
  return rows[0] || { mode: 'none' };
}

export async function resolveZoneForAddress(address, branchId) {
  if (!address) return null;
  const { rows } = await pool.query(
    `select * from delivery_zone where active = true and ($1::uuid is null or branch_id = $1 or branch_id is null) order by name`,
    [branchId]
  );
  if (!rows.length) return null;
  const lower = address.toLowerCase();
  const byName = rows.find((z) => lower.includes(z.name.toLowerCase()));
  if (byName) return byName;
  return rows.find((z) => (z.aliases || []).some((alias) => lower.includes(alias.toLowerCase()))) || null;
}
