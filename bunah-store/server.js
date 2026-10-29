'use strict';
try { require('./lib/env').load(); } catch (e) { /* optional */ }

const path = require('path');
const express = require('express');
const multer = require('multer');
const store = require('./lib/store');
const U = require('./lib/util');
const payments = require('./lib/payments');
const { saveUpload, UPLOAD_DIR } = require('./lib/uploads');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MIN_DONATION = Number(process.env.MIN_DONATION) || 10;
const MAX_DONATION = Number(process.env.MAX_DONATION) || 1000000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

// async route wrapper
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- security headers --------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://cdn.moyasar.com https://applepay.cdn-apple.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.moyasar.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https:",
    "connect-src 'self' https://api.moyasar.com",
    "frame-src 'self' https://*.moyasar.com",
    "form-action 'self' https://*.moyasar.com",
    "base-uri 'self'", "object-src 'none'"
  ].join('; '));
  next();
});

// On Vercel the public/ folder is served by the CDN; locally Express serves it.
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d', index: false }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d' }));
app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(express.json({ limit: '200kb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype))
});
async function saveFiles(files) { const out = []; for (const f of files || []) { const u = await saveUpload(f); if (u) out.push(u); } return out; }

// ---- session (signed cookie) -----------------------------------------------
const COOKIE = 'bn_admin';
const SESSION_HOURS = 12;
async function getSession(req) {
  const s = U.unsign(U.parseCookies(req)[COOKIE]);
  if (!s || !s.exp || s.exp < Date.now()) return null;
  const admin = await store.getAdmin();
  if (!admin || admin.username !== s.u || admin.ver !== s.v) return null;
  return s;
}
function setSession(res, username, ver) {
  const s = { u: username, v: ver, sid: store.newId(), exp: Date.now() + SESSION_HOURS * 3600e3 };
  const secure = process.env.COOKIE_SECURE === 'false' ? '' : (process.env.NODE_ENV === 'production' ? '; Secure' : '');
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(U.sign(s))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}${secure}`);
}
function clearSession(res) { res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`); }
const csrfFor = s => U.hmac('csrf:' + s.sid);

// ---- locals for every view ---------------------------------------------------
app.use(h(async (req, res, next) => {
  const S = await store.getSettings();
  res.locals.S = S;
  res.locals.money = U.money;
  res.locals.fmtDate = U.fmtDate;
  res.locals.path = req.path;
  res.locals.categories = S.categories || [];
  res.locals.flash = req.query.msg ? String(req.query.msg).slice(0, 200) : '';
  next();
}));

function baseUrl(req) { return (process.env.BASE_URL || (req.protocol + '://' + req.get('host'))).replace(/\/$/, ''); }
const msg = (res, status, o) => res.status(status).render('message', Object.assign({ title: o.heading }, o));

// =============================================================================
// PUBLIC
// =============================================================================
app.get('/', h(async (req, res) => {
  const [opps, partners] = await Promise.all([store.publicOpportunities(), store.listPartners()]);
  const totals = opps.reduce((a, o) => { a.target += o.target || 0; a.raised += o.raised; return a; }, { target: 0, raised: 0 });
  res.render('home', { title: res.locals.S.name, opps, totals, partners: partners.sort(store.byOrder) });
}));

app.get('/o/:slug', h(async (req, res, next) => {
  const opp = await store.opportunityWithProgress(req.params.slug);
  if (!opp || (opp.status !== 'active' && opp.status !== 'completed')) return next();
  const related = (await store.publicOpportunities()).filter(x => x.id !== opp.id && x.status === 'active' && !x.completed).slice(0, 3);
  res.render('opportunity', { title: opp.title, opp, related, donorsCount: opp.donors });
}));

app.get('/cart', (req, res) => res.render('cart', { title: 'سلة التبرعات', paymentEnabled: !!payments.active(), MIN_DONATION }));

app.get('/api/opportunities', h(async (req, res) => {
  res.json((await store.publicOpportunities()).map(o => ({
    id: o.id, slug: o.slug, title: o.title, image: (o.images || [])[0] || '', remaining: o.remaining,
    target: o.target, completed: o.completed, status: o.status
  })));
}));

app.post('/checkout', h(async (req, res) => {
  let items = req.body.items;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = []; } }
  if (!Array.isArray(items)) items = [];
  const all = await store.publicOpportunities();
  const clean = [];
  for (const it of items.slice(0, 20)) {
    const p = all.find(o => o.id === String(it.id || ''));
    if (!p || p.status !== 'active' || clean.some(c => c.opportunityId === p.id)) continue;
    let amount = U.toInt(it.amount, 0);
    if (p.target > 0 && p.remaining <= 0) continue;
    if (p.target > 0) amount = Math.min(amount, p.remaining);
    if (amount < MIN_DONATION || amount > MAX_DONATION) continue;
    clean.push({ opportunityId: p.id, title: p.title, amount });
  }
  if (!clean.length) return msg(res, 400, { heading: 'تعذّر إتمام التبرع', body: 'السلة فارغة أو المبالغ غير صحيحة (الحد الأدنى ' + MIN_DONATION + ' ريال).', back: '/cart' });

  const phone = U.clean(req.body.phone, 20).replace(/[^\d+]/g, '');
  if (!/^(\+?966|0)?5\d{8}$/.test(phone)) return msg(res, 400, { heading: 'رقم الجوال غير صحيح', body: 'أدخل رقم جوال سعوديًا صحيحًا مثل 05XXXXXXXX ليصلك إيصال التبرع.', back: '/cart' });

  const provider = payments.active();
  const donation = {
    id: store.newId(), ref: U.donationRef(), items: clean,
    total: clean.reduce((a, b) => a + b.amount, 0),
    donor: {
      name: U.clean(req.body.name, 80), phone, email: U.clean(req.body.email, 120),
      anonymous: req.body.anonymous === 'on' || req.body.anonymous === true,
      giftTo: U.clean(req.body.giftTo, 80), giftPhone: U.clean(req.body.giftPhone, 20).replace(/[^\d+]/g, '')
    },
    method: provider ? 'online' : 'bank', status: 'pending', createdAt: new Date().toISOString()
  };
  await store.saveDonation(donation);
  res.redirect(303, (provider ? '/pay/' : '/bank/') + donation.ref);
}));

app.get('/pay/:ref', h(async (req, res, next) => {
  const dn = await store.getDonation(req.params.ref);
  const provider = payments.active();
  if (!dn || dn.ref !== req.params.ref || dn.method !== 'online') return next();
  if (dn.status === 'paid') return res.redirect('/thanks/' + dn.ref);
  if (!provider) return res.redirect('/bank/' + dn.ref);
  res.render('pay', { title: 'إتمام الدفع', dn, cfg: provider.clientConfig(dn, baseUrl(req)) });
}));

app.get('/bank/:ref', h(async (req, res, next) => {
  const dn = await store.getDonation(req.params.ref);
  if (!dn || dn.ref !== req.params.ref) return next();
  res.render('bank', { title: 'التبرع بالتحويل البنكي', dn });
}));

async function confirmPayment(dn, paymentId) {
  const provider = payments.active();
  if (!provider || !dn) return { ok: false };
  const r = await provider.verify(paymentId, dn);
  if (r.ok) {
    await store.markPaid(dn.id, { paidAt: new Date().toISOString(), providerPaymentId: paymentId, payment: r.raw });
  } else if (r.status === 'failed' && dn.status === 'pending') {
    dn.status = 'failed'; dn.providerPaymentId = paymentId; await store.saveDonation(dn);
  }
  return r;
}

app.get('/payment/callback', h(async (req, res) => {
  const ref = String(req.query.ref || '');
  let dn = await store.getDonation(ref);
  if (!dn || dn.ref !== ref) return res.redirect('/');
  if (dn.status !== 'paid') {
    try { await confirmPayment(dn, String(req.query.id || '')); } catch (e) { console.error('verify error', e.message); }
    dn = await store.getDonation(ref);
  }
  if (dn.status === 'paid') return res.redirect('/thanks/' + dn.ref);
  msg(res, 200, { heading: 'لم يكتمل الدفع', body: 'لم تتم عملية الدفع. يمكنك المحاولة مرة أخرى، أو التبرع بالتحويل البنكي. رقم الطلب: ' + dn.ref, back: '/pay/' + dn.ref, backLabel: 'المحاولة مرة أخرى' });
}));

// Moyasar webhook (optional): set MOYASAR_WEBHOOK_SECRET and point the webhook to /payment/webhook
app.post('/payment/webhook', h(async (req, res) => {
  const secret = process.env.MOYASAR_WEBHOOK_SECRET;
  if (!secret || !req.body || req.body.secret_token !== secret) return res.status(401).end();
  const p = req.body.data || {};
  const ref = p.metadata && p.metadata.donation_ref;
  const dn = ref && await store.getDonation(ref);
  if (dn && dn.ref === ref && p.id && dn.status !== 'paid') { try { await confirmPayment(dn, p.id); } catch (e) { console.error(e.message); } }
  res.json({ ok: true });
}));

app.get('/thanks/:ref', h(async (req, res, next) => {
  const dn = await store.getDonation(req.params.ref);
  if (!dn || dn.ref !== req.params.ref) return next();
  res.render('thanks', { title: 'شكرًا لتبرعك', dn });
}));

// =============================================================================
// ADMIN
// =============================================================================
const loginAttempts = new Map();
function tooMany(ip) {
  const now = Date.now(); const a = (loginAttempts.get(ip) || []).filter(t => now - t < 15 * 60e3);
  loginAttempts.set(ip, a); return a.length >= 8;
}
function checkCsrf(req, res, next) {
  const t = (req.body && req.body._csrf) || req.get('x-csrf-token');
  if (!req.admin || t !== csrfFor(req.admin)) return res.status(403).send('طلب غير صالح (CSRF). أعد تحميل الصفحة وحاول مجددًا.');
  next();
}
const back = (res, to, text) => res.redirect(to + (to.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent(text));

app.get('/admin/setup', h(async (req, res) => {
  if (await store.getAdmin()) return res.redirect('/admin/login');
  res.render('admin/setup', { title: 'إعداد لوحة التحكم', error: '' });
}));
app.post('/admin/setup', h(async (req, res) => {
  if (await store.getAdmin()) return res.redirect('/admin/login');
  const token = process.env.SETUP_TOKEN;
  const fail = e => res.render('admin/setup', { title: 'إعداد لوحة التحكم', error: e });
  if (token && req.body.token !== token) return fail('رمز الإعداد غير صحيح.');
  const u = U.clean(req.body.username, 40); const p = String(req.body.password || '');
  if (u.length < 3 || p.length < 10) return fail('اسم المستخدم 3 أحرف على الأقل، وكلمة المرور 10 أحرف على الأقل.');
  const { salt, hash } = U.hashPassword(p);
  if (!(await store.createAdmin({ username: u, salt, hash, ver: 1 }))) return res.redirect('/admin/login');
  setSession(res, u, 1); res.redirect('/admin');
}));

app.get('/admin/login', h(async (req, res) => {
  if (!(await store.getAdmin())) return res.redirect('/admin/setup');
  res.render('admin/login', { title: 'تسجيل الدخول', error: '' });
}));
app.post('/admin/login', h(async (req, res) => {
  const ip = req.ip; const a = await store.getAdmin();
  if (tooMany(ip)) return res.status(429).render('admin/login', { title: 'تسجيل الدخول', error: 'محاولات كثيرة. انتظر 15 دقيقة.' });
  const ok = a && req.body.username === a.username && U.verifyPassword(String(req.body.password || ''), a.salt, a.hash);
  if (!ok) { loginAttempts.get(ip).push(Date.now()); return res.status(401).render('admin/login', { title: 'تسجيل الدخول', error: 'بيانات الدخول غير صحيحة.' }); }
  loginAttempts.delete(ip); setSession(res, a.username, a.ver); res.redirect('/admin');
}));
app.post('/admin/logout', (req, res) => { clearSession(res); res.redirect('/admin/login'); });

app.use('/admin', h(async (req, res, next) => {
  if (['/login', '/setup', '/logout'].includes(req.path)) return next();
  const s = await getSession(req);
  if (!s) return res.redirect('/admin/login');
  req.admin = s; res.locals.csrf = csrfFor(s); res.locals.adminUser = s.u;
  res.setHeader('Cache-Control', 'no-store');
  next();
}));

app.get('/admin', h(async (req, res) => {
  const [donations, opps] = await Promise.all([store.listDonations(), store.opportunitiesWithProgress()]);
  const paid = donations.filter(x => x.status === 'paid');
  const since = Date.now() - 30 * 86400e3;
  const when = x => x.paidAt || x.createdAt;
  const stats = {
    raised: paid.reduce((a, b) => a + b.total, 0),
    raised30: paid.filter(x => new Date(when(x)).getTime() > since).reduce((a, b) => a + b.total, 0),
    count: paid.length,
    pendingBank: donations.filter(x => x.status === 'pending' && x.method === 'bank').length,
    active: opps.filter(o => o.status === 'active').length
  };
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10);
    days.push({ day, total: paid.filter(x => when(x).slice(0, 10) === day).reduce((a, b) => a + b.total, 0) });
  }
  res.render('admin/dashboard', { title: 'لوحة التحكم', stats, days, opps: opps.slice().sort((a, b) => b.raised - a.raised).slice(0, 6), recent: donations.slice(0, 8), pay: payments.status() });
}));

// ---- opportunities -----------------------------------------------------------
app.get('/admin/opportunities', h(async (req, res) => {
  res.render('admin/opportunities', { title: 'الفرص', list: await store.opportunitiesWithProgress() });
}));
app.get('/admin/opportunities/new', h(async (req, res) => {
  const n = (await store.listOpportunities()).length;
  res.render('admin/opportunity-form', { title: 'فرصة جديدة', o: { id: 'new', status: 'draft', presets: [100, 500, 1000], images: [], target: 0, raisedOffset: 0, order: n + 1 } });
}));
app.get('/admin/opportunities/:id', h(async (req, res, next) => {
  const o = await store.opportunityWithProgress(req.params.id);
  if (!o || o.id !== req.params.id) return next();
  res.render('admin/opportunity-form', { title: 'تعديل: ' + o.title, o });
}));
app.post('/admin/opportunities/:id', upload.array('images', 8), checkCsrf, h(async (req, res) => {
  const b = req.body;
  let o = req.params.id === 'new' ? null : await store.getOpportunity(req.params.id);
  if (o && o.id !== req.params.id) o = null;
  if (!o) o = { id: store.newId(), createdAt: new Date().toISOString(), images: [] };
  o.title = U.clean(b.title, 140) || 'فرصة بدون عنوان';
  let slug = U.slugify(b.slug || o.title);
  if (await store.slugTaken(slug, o.id)) slug += '-' + o.id.slice(0, 4);
  o.slug = slug;
  o.category = U.clean(b.category, 60);
  o.summary = U.clean(b.summary, 400);
  o.description = U.clean(b.description, 6000);
  o.beneficiaries = U.clean(b.beneficiaries, 300);
  o.impact = U.clean(b.impact, 1500);
  o.duration = U.clean(b.duration, 60);
  o.target = Math.max(0, U.toInt(b.target, 0));
  o.raisedOffset = Math.max(0, U.toInt(b.raisedOffset, 0));
  o.presets = String(b.presets || '').split(/[,،\s]+/).map(x => U.toInt(x, 0)).filter(x => x >= MIN_DONATION).slice(0, 6);
  if (!o.presets.length) o.presets = [100, 500, 1000];
  o.status = ['active', 'draft', 'completed', 'hidden'].includes(b.status) ? b.status : 'draft';
  o.featured = b.featured === 'on';
  o.order = U.toInt(b.order, 0);
  const keep = [].concat(b.keepImages || []).filter(x => (o.images || []).includes(x));
  o.images = keep.concat(await saveFiles(req.files)).slice(0, 10);
  await store.saveOpportunity(o);
  back(res, '/admin/opportunities/' + o.id, 'تم الحفظ');
}));
app.post('/admin/opportunities/:id/delete', checkCsrf, h(async (req, res) => {
  const o = await store.getOpportunity(req.params.id);
  if (o && o.id === req.params.id) {
    if (await store.opportunityHasDonations(o.id)) { o.status = 'hidden'; await store.saveOpportunity(o); return back(res, '/admin/opportunities', 'الفرصة مرتبطة بتبرعات، فتم إخفاؤها بدل حذفها'); }
    await store.deleteOpportunity(o.id);
  }
  back(res, '/admin/opportunities', 'تم الحذف');
}));

// ---- donations ---------------------------------------------------------------
async function filteredDonations(q) {
  let list = await store.listDonations();
  if (q.status && q.status !== 'all') list = list.filter(x => x.status === q.status);
  if (q.method && q.method !== 'all') list = list.filter(x => x.method === q.method);
  if (q.opp) list = list.filter(x => x.items.some(i => i.opportunityId === q.opp));
  if (q.q) { const s = String(q.q).toLowerCase(); list = list.filter(x => (x.ref + ' ' + x.donor.name + ' ' + x.donor.phone + ' ' + x.donor.email).toLowerCase().includes(s)); }
  return list;
}
app.get('/admin/donations', h(async (req, res) => {
  const list = await filteredDonations(req.query);
  res.render('admin/donations', { title: 'التبرعات', list: list.slice(0, 500), total: list.filter(x => x.status === 'paid').reduce((a, b) => a + b.total, 0), q: req.query, opps: await store.listOpportunities() });
}));
app.get('/admin/donations.csv', h(async (req, res) => {
  const list = await filteredDonations(req.query);
  // neutralise spreadsheet formulas (=,+,-,@) in user-provided fields
  const esc = v => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const rows = [['رقم الطلب', 'التاريخ', 'الحالة', 'الطريقة', 'المبلغ', 'الفرص', 'الاسم', 'الجوال', 'البريد', 'فاعل خير', 'إهداء إلى'].map(esc).join(',')];
  for (const x of list) rows.push([x.ref, x.createdAt, x.status, x.method, x.total, x.items.map(i => i.title + ' (' + i.amount + ')').join(' | '), x.donor.name, x.donor.phone, x.donor.email, x.donor.anonymous ? 'نعم' : '', x.donor.giftTo].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="donations-' + new Date().toISOString().slice(0, 10) + '.csv"');
  res.send('﻿' + rows.join('\r\n'));
}));
app.post('/admin/donations/:id/status', checkCsrf, h(async (req, res, next) => {
  const dn = await store.getDonation(req.params.id);
  if (!dn || dn.id !== req.params.id) return next();
  const st = req.body.status;
  if (!['paid', 'pending', 'cancelled', 'failed'].includes(st)) return res.redirect('/admin/donations');
  if (dn.method === 'online' && st === 'paid' && dn.status !== 'paid') return back(res, '/admin/donations', 'التبرعات الإلكترونية تُعتمد تلقائيًا بعد تحقق بوابة الدفع');
  dn.status = st; dn.note = U.clean(req.body.note, 300) || dn.note;
  if (st === 'paid') { dn.paidAt = new Date().toISOString(); dn.approvedBy = req.admin.u; }
  await store.saveDonation(dn);
  back(res, '/admin/donations', 'تم تحديث حالة ' + dn.ref);
}));

// ---- partners ----------------------------------------------------------------
app.get('/admin/partners', h(async (req, res) => {
  res.render('admin/partners', { title: 'الشركاء', list: (await store.listPartners()).sort(store.byOrder) });
}));
app.post('/admin/partners', upload.single('logo'), checkCsrf, h(async (req, res) => {
  const url = req.file && await saveUpload(req.file);
  if (!url) return back(res, '/admin/partners', 'اختر صورة الشعار (PNG أو JPG أو WEBP)');
  const list = await store.listPartners();
  const max = list.reduce((m, p) => Math.max(m, p.order || 0), 0);
  await store.savePartner({ id: store.newId(), name: U.clean(req.body.name, 120), logo: url, order: max + 10 });
  back(res, '/admin/partners', 'تمت الإضافة');
}));
app.post('/admin/partners/:id/move', checkCsrf, h(async (req, res) => {
  const list = (await store.listPartners()).sort(store.byOrder);
  const i = list.findIndex(x => x.id === req.params.id); const j = req.body.dir === 'up' ? i - 1 : i + 1;
  if (i >= 0 && j >= 0 && j < list.length) {
    [list[i], list[j]] = [list[j], list[i]];
    for (let k = 0; k < list.length; k++) { if (list[k].order !== (k + 1) * 10) { list[k].order = (k + 1) * 10; await store.savePartner(list[k]); } }
  }
  res.redirect('/admin/partners');
}));
app.post('/admin/partners/:id/delete', checkCsrf, h(async (req, res) => {
  await store.deletePartner(req.params.id); back(res, '/admin/partners', 'تم الحذف');
}));

// ---- settings ----------------------------------------------------------------
app.get('/admin/settings', (req, res) => res.render('admin/settings', { title: 'الإعدادات', pay: payments.status() }));
app.post('/admin/settings', upload.fields([{ name: 'heroImage', maxCount: 1 }, { name: 'logo', maxCount: 1 }]), checkCsrf, h(async (req, res) => {
  const s = await store.getSettings(); const b = req.body;
  ['name', 'tagline', 'about', 'vision', 'mission', 'phone', 'email', 'address', 'website', 'x', 'instagram', 'whatsapp', 'license', 'bankName', 'accountName', 'iban', 'heroTitle', 'heroText']
    .forEach(k => { s[k] = U.clean(b[k], k === 'about' ? 3000 : 600); });
  s.iban = s.iban.replace(/\s+/g, '').toUpperCase();
  s.whatsapp = s.whatsapp.replace(/[^\d]/g, '');
  s.x = s.x.replace(/^@/, ''); s.instagram = s.instagram.replace(/^@/, '');
  if (s.website && !/^https?:\/\//i.test(s.website)) s.website = 'https://' + s.website;
  s.categories = String(b.categories || '').split(/\n|،|,/).map(x => U.clean(x, 60)).filter(Boolean).slice(0, 12);
  s.stats = [0, 1, 2, 3].map(i => ({ value: U.clean(b['statValue' + i], 20), label: U.clean(b['statLabel' + i], 80) })).filter(x => x.value);
  s.values = [0, 1, 2, 3, 4].map(i => ({ title: U.clean(b['valueTitle' + i], 40), desc: U.clean(b['valueDesc' + i], 200) })).filter(x => x.title);
  if (req.files && req.files.heroImage) s.heroImage = (await saveUpload(req.files.heroImage[0])) || s.heroImage;
  if (req.files && req.files.logo) s.logo = (await saveUpload(req.files.logo[0])) || s.logo;
  await store.saveSettings(s);
  back(res, '/admin/settings', 'تم حفظ الإعدادات');
}));
app.post('/admin/password', checkCsrf, h(async (req, res) => {
  const a = await store.getAdmin();
  if (!U.verifyPassword(String(req.body.current || ''), a.salt, a.hash)) return back(res, '/admin/settings', 'كلمة المرور الحالية غير صحيحة');
  const p = String(req.body.password || '');
  if (p.length < 10) return back(res, '/admin/settings', 'كلمة المرور الجديدة 10 أحرف على الأقل');
  const { salt, hash } = U.hashPassword(p); a.salt = salt; a.hash = hash; a.ver = (a.ver || 1) + 1;
  await store.saveAdmin(a);
  setSession(res, a.username, a.ver); back(res, '/admin/settings', 'تم تغيير كلمة المرور');
}));

// ---- errors ------------------------------------------------------------------
app.use((req, res) => {
  if (!res.locals.S) res.locals.S = {};
  msg(res, 404, { heading: 'الصفحة غير موجودة', body: 'ربما نُقلت الصفحة أو انتهت الفرصة.', back: '/' });
});
app.use((err, req, res, next) => {
  console.error(err);
  const text = err && err.code === 'LIMIT_FILE_SIZE' ? 'حجم الصورة أكبر من 4 ميجابايت.' : 'حدث خطأ غير متوقع. حاول مرة أخرى.';
  if (!res.locals.S || !res.locals.money) return res.status(500).send(text);
  msg(res, 500, { heading: 'عذرًا', body: text, back: req.get('referer') || '/' });
});

if (require.main === module) {
  store.ensure().then(() => app.listen(PORT, () => console.log('متجر بُناة يعمل على المنفذ ' + PORT + ' — التخزين: ' + store.kind + ' — الدفع: ' + payments.status().label)))
    .catch(e => { console.error('تعذّر الاتصال بقاعدة البيانات:', e.message); process.exit(1); });
}
module.exports = app;
