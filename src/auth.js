'use strict';
// Passwords: scrypt with a random salt. Sessions: a signed, HttpOnly cookie that
// carries { u: userId, a: isAdmin, e: expiresAt }. No server-side session store needed.
const crypto = require('crypto');
const config = require('./config');
const { db } = require('./db');

const COOKIE = 'mf_session';
const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored || '').split('$');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return check.length === expected.length && crypto.timingSafeEqual(check, expected);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(token) {
  if (!token || typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const body = token.slice(0, i), mac = token.slice(i + 1);
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  if (!safeEqual(mac, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object' || !payload.e || Date.now() > payload.e) return null;
    return payload;
  } catch { return null; }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSession(res, session) {
  const payload = { u: session.userId || null, a: !!session.admin, e: Date.now() + SESSION_DAYS * 86400e3 };
  const attrs = [`${COOKIE}=${sign(payload)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_DAYS * 86400}`];
  if (config.cookieSecure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

// Middleware: populates req.user (row from users or null) and req.isAdmin.
function sessionMiddleware(req, res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  const payload = unsign(token);
  req.session = { userId: payload?.u || null, admin: !!payload?.a };
  req.user = null;
  if (req.session.userId) {
    req.user = db.prepare('SELECT id, username, full_name, email, pl_number, created_at FROM users WHERE id = ?').get(req.session.userId) || null;
    if (!req.user) req.session.userId = null;
  }
  req.isAdmin = req.session.admin && !!config.adminPassword;
  // helper to update the cookie with changes
  req.saveSession = () => setSession(res, req.session);
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'You must be logged in.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  next();
}

// Very small in-memory rate limiter (per key), used for login attempts.
const attempts = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let rec = attempts.get(key);
  if (!rec || now > rec.reset) { rec = { count: 0, reset: now + windowMs }; attempts.set(key, rec); }
  rec.count++;
  if (attempts.size > 10000) attempts.clear();
  return rec.count <= max;
}

module.exports = { hashPassword, verifyPassword, safeEqual, sessionMiddleware, requireUser, requireAdmin, rateLimit };
