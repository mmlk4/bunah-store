'use strict';
const crypto = require('crypto');

const DBU = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const SECRET = process.env.SESSION_SECRET || (DBU ? crypto.createHash('sha256').update('bunah-session:' + DBU).digest('hex') : null) || (() => {
  const s = crypto.randomBytes(32).toString('hex');
  console.warn('[تحذير] SESSION_SECRET غير مضبوط؛ تم توليد مفتاح مؤقت. اضبطه في ملف .env حتى لا تُسجَّل خروجك عند كل إعادة تشغيل.');
  return s;
})();

function hmac(value) {
  return crypto.createHmac('sha256', SECRET).update(String(value)).digest('base64url');
}

function sign(obj) {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return body + '.' + hmac(body);
}

function unsign(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = hmac(body);
  const a = Buffer.from(sig || ''); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
}

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return h.length === expected.length && crypto.timingSafeEqual(h, expected);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function slugify(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || crypto.randomBytes(3).toString('hex');
}

const nf = new Intl.NumberFormat('en-US');
function money(n) { return nf.format(Math.round(Number(n) || 0)); }

function toInt(v, def = 0) {
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : def;
}

function clean(s, max = 5000) { return String(s == null ? '' : s).trim().slice(0, max); }

function donationRef() {
  const d = new Date();
  const ymd = d.toISOString().slice(2, 10).replace(/-/g, '');
  return 'BN' + ymd + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

const dtf = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Riyadh' });
function fmtDate(iso) { try { return dtf.format(new Date(iso)); } catch { return iso || ''; } }

module.exports = { sign, unsign, hmac, hashPassword, verifyPassword, parseCookies, slugify, money, toInt, clean, donationRef, fmtDate };
