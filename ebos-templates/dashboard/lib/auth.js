import bcrypt from 'bcryptjs';
import { pool } from './db.js';

export async function findStaffByEmail(email) {
  const { rows } = await pool.query(
    `select s.id, s.name, s.email, s.password_hash, s.role, s.status, s.branch_id, b.name as branch_name
     from staff s left join branch b on b.id = s.branch_id where s.email = $1`,
    [email.trim().toLowerCase()]
  );
  return rows[0] || null;
}

export async function verifyPassword(staff, password) {
  if (staff.status !== 'active') return false;
  return bcrypt.compare(password, staff.password_hash);
}

export function hashPassword(password) {
  return bcrypt.hash(password, 10);
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
