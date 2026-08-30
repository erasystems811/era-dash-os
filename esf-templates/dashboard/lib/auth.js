import bcrypt from 'bcryptjs';
import { pool } from './db.js';

export async function findOwnerByEmail(email) {
  const { rows } = await pool.query(
    `select id, email, password_hash, role, can_override from owner_user where email = $1`,
    [email.trim().toLowerCase()]
  );
  return rows[0] || null;
}

export async function verifyPassword(owner, password) {
  return bcrypt.compare(password, owner.password_hash);
}

export function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

// Attaches req.owner from the session, or null. Does not block the request --
// individual routes decide what they require (requireOwner below).
export function loadOwner(req, res, next) {
  req.owner = req.session?.owner || null;
  next();
}

export function requireOwner(req, res, next) {
  if (!req.owner) return res.redirect('/login');
  next();
}

export function requireOwnerApi(req, res, next) {
  if (!req.owner) return res.status(401).json({ error: 'Not logged in.' });
  next();
}

// Manager and owner can override a blocked run/step (build schema v2.0
// section 3.8) -- viewer cannot.
export function canOverride(owner) {
  return owner.role === 'owner' || (owner.role === 'manager' && owner.can_override);
}

export function requireOverrideApi(req, res, next) {
  if (!canOverride(req.owner)) return res.status(403).json({ error: 'Only an owner or a manager with override rights can do this.' });
  next();
}

// task/step config edits by ERA's own tooling (the workstation, later), not
// this business's own owner login -- same pattern as EBOS's
// requireEraAdmin, checked against ESF_ADMIN_TOKEN.
export function requireEraAdmin(req, res, next) {
  const token = req.header('x-era-admin-token');
  if (!process.env.ESF_ADMIN_TOKEN || token !== process.env.ESF_ADMIN_TOKEN) {
    return res.status(403).json({ error: 'ERA admin only.' });
  }
  next();
}
