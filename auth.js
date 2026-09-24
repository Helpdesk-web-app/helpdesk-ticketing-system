import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Router } from 'express';
import { q } from './db.js';

const sign = (u) => jwt.sign({ id: u.id, name: u.name, role: u.role }, process.env.JWT_SECRET, { expiresIn: '8h' });

export function authenticate(req, res, next) {
  try {
    req.user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Sign in required' });
  }
}

export const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Your role cannot do this' });

async function createUser(res, { name, email, password }, role) {
  if (!name || !email || !password || password.length < 8)
    return res.status(400).json({ error: 'Name, email and a password of at least 8 characters are required' });
  try {
    const { rows } = await q(
      'INSERT INTO users(name, email, password_hash, role) VALUES($1, $2, $3, $4) RETURNING id, name, role',
      [name, email.toLowerCase(), await bcrypt.hash(password, 10), role]
    );
    res.status(201).json({ token: sign(rows[0]), user: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That email is already registered' });
    throw e;
  }
}

export const auth = Router();

// Public sign-up always creates a requester.
auth.post('/register', (req, res) => createUser(res, req.body || {}, 'requester'));

// Only admins can create agents or other admins.
auth.post('/users', authenticate, requireRole('admin'), (req, res) => {
  const role = req.body?.role;
  if (!['agent', 'admin', 'requester'].includes(role)) return res.status(400).json({ error: 'Role must be requester, agent or admin' });
  return createUser(res, req.body, role);
});

auth.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  const { rows } = await q('SELECT * FROM users WHERE email = $1', [String(email || '').toLowerCase()]);
  const u = rows[0];
  if (!u || !(await bcrypt.compare(String(password || ''), u.password_hash)))
    return res.status(401).json({ error: 'Email or password is incorrect' });
  res.json({ token: sign(u), user: { id: u.id, name: u.name, role: u.role } });
});
