'use strict';

const crypto = require('crypto');
const { getDb } = require('./db');

/** 管理员口令：默认 admin123，可由 ADMIN_PASSWORD 覆盖 */
function adminPassword() {
  return process.env.ADMIN_PASSWORD || 'admin123';
}

function createSession(role, name) {
  const token = crypto.randomBytes(24).toString('hex');
  getDb()
    .prepare(`INSERT INTO sessions(token,role,name) VALUES(?,?,?)`)
    .run(token, role, name);
  return token;
}

function getSession(token) {
  if (!token) return null;
  return getDb().prepare(`SELECT token, role, name FROM sessions WHERE token=?`).get(token) || null;
}

function destroySession(token) {
  if (token) getDb().prepare(`DELETE FROM sessions WHERE token=?`).run(token);
}

/** 从 Authorization: Bearer 或 cookie sid 中取令牌 */
function tokenOf(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function requireAuth(role) {
  return (req, res, next) => {
    const session = getSession(tokenOf(req));
    if (!session) return res.status(401).json({ ok: false, error: '未登录或会话已失效，请重新登录' });
    if (role && session.role !== role) {
      return res.status(403).json({ ok: false, error: `需要 ${role === 'admin' ? '管理员' : '值班员'} 身份` });
    }
    req.session = session;
    next();
  };
}

module.exports = { adminPassword, createSession, getSession, destroySession, tokenOf, requireAuth };
