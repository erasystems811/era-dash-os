import bcrypt from 'bcryptjs';
import { pool } from './db.js';

export async function findStaffByEmail(email) {
  const { rows } = await pool.query(
    `select id, name, email, password_hash, role, status from staff where email = $1`,
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
