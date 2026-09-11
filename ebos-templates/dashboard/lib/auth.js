import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { pool } from './db.js';

export async function findStaffByEmail(email) {
  const { rows } = await pool.query(
    `select s.id, s.name, s.email, s.password_hash, s.role, s.status, s.branch_id, s.auth_type, s.work_area, b.name as branch_name
     from staff s left join branch b on b.id = s.branch_id where s.email = $1`,
    [email.trim().toLowerCase()]
  );
  return rows[0] || null;
}

// A Nigerian number is routinely typed in LOCAL format (0903...) into the
// Staff form and everywhere else a business types in a phone number, but
// WhatsApp's own wire format (both message.from on an inbound webhook, and
// what Meta's send API actually accepts as a recipient) is always
// international digits with no leading 0 and no "+" (234903...). Found
// live, 2026-09-11: a real manager's number stored as "09032637607"
// matched no inbound sender AND was rejected outright by Meta as an
// outbound recipient ("(#131009) The phone number is malformed") --
// meaning handover alerts to any staff member entered in local format have
// likely been silently failing to send this whole time, not just the new
// WhatsApp dashboard command below. One normalizer, used both to match an
// inbound sender and right before every outbound send that uses a stored
// staff/business number, rather than trusting whatever format someone
// typed in. Hardcoded to Nigeria (234) -- every business on this platform
// today is Nigerian; a number that's neither 0-prefixed-local nor already
// 234-prefixed is left alone rather than guessed at.
export function toWhatsAppDigits(rawNumber, defaultCountryCode = '234') {
  const digits = String(rawNumber || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) return defaultCountryCode + digits.slice(1);
  return digits;
}

// Small per-business table, so normalizing in JS and scanning it beats a
// fragile "strip a leading 0 inside SQL" expression for the same match.
// Only active accounts, same as every other login path.
export async function findStaffByPhoneNumber(phoneNumber) {
  const target = toWhatsAppDigits(phoneNumber);
  if (!target) return null;
  const { rows } = await pool.query(
    `select id, name, role, status, branch_id, auth_type, work_area, phone_number
     from staff where status = 'active' and phone_number is not null and phone_number != ''`
  );
  return rows.find((s) => toWhatsAppDigits(s.phone_number) === target) || null;
}

export async function verifyPassword(staff, password) {
  if (staff.status !== 'active') return false;
  return bcrypt.compare(password, staff.password_hash);
}

export function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

// PIN accounts are always looked up scoped to one specific branch + staff
// id, never by a bare PIN value -- the real anti-brute-force property a
// 4-digit PIN needs. A business-wide "does any staff have this PIN" lookup
// would turn 10,000 combinations into a business-wide scan; this way an
// attacker is stuck guessing against exactly one person.
export async function findPinStaffById(branchId, staffId) {
  const { rows } = await pool.query(
    `select id, name, role, status, branch_id, auth_type, pin_hash, work_area,
            pin_failed_attempts, pin_locked_until
     from staff where id = $1 and branch_id = $2 and auth_type = 'pin'`,
    [staffId, branchId]
  );
  return rows[0] || null;
}

// Name-only list for the "pick your name" screen -- never returns pin_hash
// or anything else. A branch with no PIN staff yet returns an empty list,
// same as any other empty-state, not an error.
export async function findPinStaffForBranch(branchId) {
  const { rows } = await pool.query(
    `select id, name from staff
     where branch_id = $1 and auth_type = 'pin' and status = 'active'
     order by name`,
    [branchId]
  );
  return rows;
}

export function hashPin(pin) {
  return bcrypt.hash(pin, 10);
}

const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 15 * 60 * 1000;

// Per-account lockout, checked before ever comparing the PIN -- a locked
// row refuses outright rather than doing (and timing) a real bcrypt
// compare, so a locked-out attacker learns nothing more from retrying.
export async function verifyPin(staff, pin) {
  if (staff.status !== 'active') return false;
  if (staff.pin_locked_until && new Date(staff.pin_locked_until) > new Date()) return false;
  const ok = staff.pin_hash ? await bcrypt.compare(pin, staff.pin_hash) : false;
  if (ok) {
    await pool.query(`update staff set pin_failed_attempts = 0, pin_locked_until = null where id = $1`, [staff.id]);
    return true;
  }
  const attempts = staff.pin_failed_attempts + 1;
  if (attempts >= PIN_MAX_ATTEMPTS) {
    await pool.query(
      `update staff set pin_failed_attempts = 0, pin_locked_until = $2 where id = $1`,
      [staff.id, new Date(Date.now() + PIN_LOCKOUT_MS)]
    );
  } else {
    await pool.query(`update staff set pin_failed_attempts = $2 where id = $1`, [staff.id, attempts]);
  }
  return false;
}

export function isPinTier(staff) {
  return staff?.auth_type === 'pin';
}

// A handover alert can sit unread for a while before anyone taps it (unlike
// a password reset link, which should expire in minutes) -- 24h is generous
// enough to cover an overnight handover without leaving the link usable
// indefinitely.
const MAGIC_LINK_TTL_MS = 24 * 60 * 60 * 1000;

function hashMagicLinkToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// One-tap login for a staff handover alert sent over WhatsApp -- Chidera
// 2026-09-11: "can handover numbers get to handle whatever it is internally
// in whatsapp without leaving the app... they can access the dashboard
// internally." The token itself is only ever in the URL texted to the
// staff member; the DB keeps just its sha256 hash, so a DB leak alone can't
// be turned into a working login the way a stored plaintext token could.
// Reusable for its whole window, not single-use -- originally built
// single-use on the assumption that the first tap's session cookie would
// carry every later tap, but found live, 2026-09-11: "why does the
// dashboard link only work once? if i open it and leave and come back it
// doesnt work again?" -- WhatsApp's own in-app browser doesn't reliably
// keep that cookie across separate open/close cycles, so leaning on it was
// wrong. The token is still high-entropy (32 random bytes) and only ever
// sent to the one intended phone number, so staying valid to repeat taps
// within a bounded window is an acceptable tradeoff, not an open door.
export async function createMagicLink(staffId, redirectPath) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `insert into staff_magic_link (staff_id, token_hash, redirect_path, expires_at) values ($1, $2, $3, $4)`,
    [staffId, hashMagicLinkToken(token), redirectPath, new Date(Date.now() + MAGIC_LINK_TTL_MS)]
  );
  return token;
}

// used_at is informational only now (first-tap timestamp) -- expires_at is
// the only real gate, so a repeat tap of the same link keeps working right
// up until it genuinely expires.
export async function consumeMagicLink(token) {
  const { rows } = await pool.query(
    `update staff_magic_link set used_at = coalesce(used_at, now())
     where token_hash = $1 and expires_at > now()
     returning staff_id, redirect_path`,
    [hashMagicLinkToken(token)]
  );
  return rows[0] || null;
}

// Best-effort hint for the failure page's redirect target ONLY -- not a
// security check (consumeMagicLink above is what actually gates login).
// Tolerant of a genuinely expired token, since even a stale link should
// still point someone at the right KIND of login screen (PIN vs password)
// instead of a bare error page that strands them.
export async function magicLinkAuthTypeHint(token) {
  const { rows } = await pool.query(
    `select s.auth_type from staff_magic_link l join staff s on s.id = l.staff_id where l.token_hash = $1`,
    [hashMagicLinkToken(token)]
  );
  return rows[0]?.auth_type || null;
}

// Attaches req.staff from the session, or null. Does not block the request --
// individual routes decide what they require (requireStaff below).
export function loadStaff(req, res, next) {
  req.staff = req.session?.staff || null;
  next();
}

export function requireStaff(req, res, next) {
  if (!req.staff) return res.redirect('/login');
  next();
}

export function requireStaffApi(req, res, next) {
  if (!req.staff) return res.status(401).json({ error: 'Not logged in.' });
  next();
}

export function canEdit(staff) {
  return staff.role === 'owner' || staff.role === 'manager';
}

export function requireEditorApi(req, res, next) {
  if (!canEdit(req.staff)) return res.status(403).json({ error: 'Only an owner or manager can do this.' });
  next();
}

// Deny-list for the handful of endpoints a PIN-tier (Tier 3) session must
// never reach even via a direct API call, not just a hidden nav tab --
// defense in depth on top of the client only rendering 5 tabs for them.
// Staff (password-tier) and above pass through unchanged; only auth_type
// = 'pin' is blocked.
export function requireFullAccessApi(req, res, next) {
  if (isPinTier(req.staff)) return res.status(403).json({ error: 'Not available to this account.' });
  next();
}

// Computes req.branchId once per request, for every route after this one to
// filter by -- the same "row data, not a role check" idiom as everywhere
// else branch logic lives. A staff member locked to a branch (branch_id set
// -- see schema.sql's comment on staff.branch_id) always sees only that
// branch, full stop, never overridable by a query param -- that's the whole
// point of locking them, not just a default. An owner/admin (branch_id
// null) sees everything UNLESS they explicitly ask to view one branch (the
// dashboard's scope switcher passing ?branch_id=), which is how the same
// "branch scope" view serves both "my one branch" and "owner looking at one
// branch specifically" with one mechanism.
export function scopeToBranch(req, res, next) {
  req.branchId = req.staff?.branch_id || req.query.branch_id || null;
  next();
}

// Same idiom as scopeToBranch, one request-scoped value every route after
// this filters by -- null (owner/manager, or any staff account from before
// work_area existed) means unrestricted, exactly today's behavior. Set at
// login time (staff.work_area), never overridable by a query param the way
// branch can be for an owner -- there's no legitimate reason for a scoped
// staff session to ever act outside its own work area.
export function scopeToWorkArea(req, res, next) {
  req.workArea = req.staff?.work_area || null;
  next();
}

// Bot config (bot_field/bot_state -- what questions it asks, how the flow
// moves) is ERA's to change, never the business's own -- an owner or
// manager login is not enough here, unlike every other requireEditorApi
// route. Checked against EBOS_ADMIN_TOKEN, the same secret ERA's own tools
// already carry, sent as x-era-admin-token -- nothing a business's staff
// login can produce.
export function requireEraAdmin(req, res, next) {
  const token = req.header('x-era-admin-token');
  if (!process.env.EBOS_ADMIN_TOKEN || token !== process.env.EBOS_ADMIN_TOKEN) {
    return res.status(403).json({ error: 'ERA admin only.' });
  }
  next();
}

// One helper every "major action" route calls, so the activity log stays
// consistent and cheap to extend later rather than each route hand-rolling
// its own insert. branch_id is read from req.branchId when scopeToBranch
// has already run on this route, falling back to the acting staff's own
// branch_id (covers PIN-tier staff, who are always branch-locked but whose
// routes may not otherwise need scopeToBranch).
export async function logActivity(req, action, { entityType = null, entityId = null, detail = null } = {}) {
  const branchId = req.branchId ?? req.staff?.branch_id ?? null;
  await pool.query(
    `insert into activity_log (staff_id, branch_id, action, entity_type, entity_id, detail)
     values ($1, $2, $3, $4, $5, $6)`,
    [req.staff?.id || null, branchId, action, entityType, entityId, detail ? JSON.stringify(detail) : null]
  );
}
