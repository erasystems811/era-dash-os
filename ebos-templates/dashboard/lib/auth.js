import bcrypt from 'bcryptjs';
import { pool } from './db.js';

export async function findStaffByEmail(email) {
  const { rows } = await pool.query(
    `select id, business_id, name, email, password_hash, role, status from staff where email = $1`,
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
