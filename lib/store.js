'use strict';
// Storage layer with two interchangeable backends:
//  - Postgres (Neon / Vercel Postgres) when DATABASE_URL or POSTGRES_URL is set  -> production on Vercel
//  - JSON file (data/db.json)                                                     -> local / VPS
// Every function is async so both backends share one interface.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SEED_FILE = path.join(__dirname, '..', 'seed', 'seed.json');
const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
const newId = () => crypto.randomBytes(8).toString('hex');
const readSeed = () => JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));

// ============================================================================
// Postgres backend
// ============================================================================
function pgBackend() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DB_URL, max: 3, idleTimeoutMillis: 10000, ssl: /sslmode=disable/.test(DB_URL) || /localhost|127\.0\.0\.1/.test(DB_URL) ? false : { rejectUnauthorized: false } });
  const q = (text, params) => pool.query(text, params);
  let ready = null;

  async function init() {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(424242)');
      await c.query(`CREATE TABLE IF NOT EXISTS bn_kv (k text PRIMARY KEY, v jsonb NOT NULL);
        CREATE TABLE IF NOT EXISTS bn_opportunities (id text PRIMARY KEY, slug text UNIQUE NOT NULL, data jsonb NOT NULL);
        CREATE TABLE IF NOT EXISTS bn_donations (id text PRIMARY KEY, ref text UNIQUE NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), data jsonb NOT NULL);
        CREATE INDEX IF NOT EXISTS bn_donations_status ON bn_donations (status);
        CREATE TABLE IF NOT EXISTS bn_partners (id text PRIMARY KEY, data jsonb NOT NULL);`);
      const r = await c.query("SELECT 1 FROM bn_kv WHERE k='settings'");
      if (!r.rowCount) {
        const seed = readSeed();
        await c.query("INSERT INTO bn_kv (k, v) VALUES ('settings', $1)", [seed.settings]);
        for (const o of seed.opportunities) await c.query('INSERT INTO bn_opportunities (id, slug, data) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [o.id, o.slug, o]);
        for (const p of seed.partners) await c.query('INSERT INTO bn_partners (id, data) VALUES ($1,$2) ON CONFLICT DO NOTHING', [p.id, p]);
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }
  const ensure = () => (ready = ready || init().catch(e => { ready = null; throw e; }));
  const rows = async (sql, p) => { await ensure(); return (await q(sql, p)).rows; };

  return {
    kind: 'postgres',
    ensure,
    async getSettings() { return ((await rows("SELECT v FROM bn_kv WHERE k='settings'"))[0] || {}).v || {}; },
    async saveSettings(s) { await rows("INSERT INTO bn_kv (k,v) VALUES ('settings',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v", [s]); },
    async getAdmin() { return ((await rows("SELECT v FROM bn_kv WHERE k='admin'"))[0] || {}).v || null; },
    async createAdmin(a) { // only if none exists (race-safe)
      const r = await rows("INSERT INTO bn_kv (k,v) VALUES ('admin',$1) ON CONFLICT (k) DO NOTHING RETURNING k", [a]);
      return r.length > 0;
    },
    async saveAdmin(a) { await rows("UPDATE bn_kv SET v=$1 WHERE k='admin'", [a]); },

    async listOpportunities() { return (await rows('SELECT data FROM bn_opportunities')).map(r => r.data); },
    async getOpportunity(key) { return ((await rows('SELECT data FROM bn_opportunities WHERE id=$1 OR slug=$1 LIMIT 1', [key]))[0] || {}).data || null; },
    async slugTaken(slug, exceptId) { return (await rows('SELECT 1 FROM bn_opportunities WHERE slug=$1 AND id<>$2', [slug, exceptId])).length > 0; },
    async saveOpportunity(o) { await rows('INSERT INTO bn_opportunities (id,slug,data) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET slug=EXCLUDED.slug, data=EXCLUDED.data', [o.id, o.slug, o]); },
    async deleteOpportunity(id) { await rows('DELETE FROM bn_opportunities WHERE id=$1', [id]); },

    async listDonations() { return (await rows('SELECT data FROM bn_donations ORDER BY created_at DESC LIMIT 5000')).map(r => r.data); },
    async getDonation(key) { return ((await rows('SELECT data FROM bn_donations WHERE id=$1 OR ref=$1 LIMIT 1', [key]))[0] || {}).data || null; },
    async saveDonation(d) { await rows('INSERT INTO bn_donations (id,ref,status,created_at,data) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, data=EXCLUDED.data', [d.id, d.ref, d.status, d.createdAt, d]); },
    // atomically move a donation to "paid" (returns true only for the request that changed it)
    async markPaid(id, patch) {
      const r = await rows("UPDATE bn_donations SET status='paid', data = data || $2::jsonb || jsonb_build_object('status','paid') WHERE id=$1 AND status<>'paid' RETURNING id", [id, patch]);
      return r.length > 0;
    },
    async raisedMap() {
      const r = await rows("SELECT i->>'opportunityId' AS oid, SUM((i->>'amount')::numeric) AS s, COUNT(DISTINCT d.id) AS n FROM bn_donations d, jsonb_array_elements(d.data->'items') i WHERE d.status='paid' GROUP BY 1");
      const m = {}; r.forEach(x => { m[x.oid] = { sum: Number(x.s), count: Number(x.n) }; }); return m;
    },
    async opportunityHasDonations(id) { return (await rows("SELECT 1 FROM bn_donations d, jsonb_array_elements(d.data->'items') i WHERE i->>'opportunityId'=$1 LIMIT 1", [id])).length > 0; },

    async listPartners() { return (await rows('SELECT data FROM bn_partners')).map(r => r.data); },
    async savePartner(p) { await rows('INSERT INTO bn_partners (id,data) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data', [p.id, p]); },
    async deletePartner(id) { await rows('DELETE FROM bn_partners WHERE id=$1', [id]); }
  };
}

// ============================================================================
// JSON file backend
// ============================================================================
function fileBackend() {
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const DB_FILE = path.join(DATA_DIR, 'db.json');
  let state = null;
  function load() {
    if (state) return state;
    if (process.env.VERCEL) throw new Error('قاعدة البيانات غير مربوطة: أضف Neon من تبويب Storage في Vercel ثم أعد النشر (DATABASE_URL مفقود).');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_FILE)) {
      const seed = readSeed(); seed.donations = []; seed.admin = null;
      fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2));
    }
    state = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    ['opportunities', 'donations', 'partners'].forEach(k => { state[k] = state[k] || []; });
    state.settings = state.settings || {};
    return state;
  }
  function save() { const tmp = DB_FILE + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state, null, 2)); fs.renameSync(tmp, DB_FILE); }
  const clone = x => (x == null ? x : JSON.parse(JSON.stringify(x)));
  const upsert = (arr, item) => { const i = arr.findIndex(x => x.id === item.id); if (i >= 0) arr[i] = clone(item); else arr.push(clone(item)); };

  return {
    kind: 'file',
    async ensure() { load(); },
    async getSettings() { return clone(load().settings); },
    async saveSettings(s) { load().settings = clone(s); save(); },
    async getAdmin() { return clone(load().admin); },
    async createAdmin(a) { const d = load(); if (d.admin) return false; d.admin = clone(a); save(); return true; },
    async saveAdmin(a) { load().admin = clone(a); save(); },
    async listOpportunities() { return clone(load().opportunities); },
    async getOpportunity(key) { return clone(load().opportunities.find(o => o.id === key || o.slug === key) || null); },
    async slugTaken(slug, exceptId) { return load().opportunities.some(o => o.slug === slug && o.id !== exceptId); },
    async saveOpportunity(o) { upsert(load().opportunities, o); save(); },
    async deleteOpportunity(id) { const d = load(); d.opportunities = d.opportunities.filter(o => o.id !== id); save(); },
    async listDonations() { return clone(load().donations.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))); },
    async getDonation(key) { return clone(load().donations.find(x => x.id === key || x.ref === key) || null); },
    async saveDonation(dn) { upsert(load().donations, dn); save(); },
    async markPaid(id, patch) {
      const dn = load().donations.find(x => x.id === id);
      if (!dn || dn.status === 'paid') return false;
      Object.assign(dn, clone(patch), { status: 'paid' }); save(); return true;
    },
    async raisedMap() {
      const m = {};
      for (const dn of load().donations) {
        if (dn.status !== 'paid') continue;
        const seen = new Set();
        for (const it of dn.items) {
          m[it.opportunityId] = m[it.opportunityId] || { sum: 0, count: 0 };
          m[it.opportunityId].sum += Number(it.amount) || 0;
          if (!seen.has(it.opportunityId)) { m[it.opportunityId].count++; seen.add(it.opportunityId); }
        }
      }
      return m;
    },
    async opportunityHasDonations(id) { return load().donations.some(x => x.items.some(i => i.opportunityId === id)); },
    async listPartners() { return clone(load().partners); },
    async savePartner(p) { upsert(load().partners, p); save(); },
    async deletePartner(id) { const d = load(); d.partners = d.partners.filter(p => p.id !== id); save(); }
  };
}

const backend = DB_URL ? pgBackend() : fileBackend();

// ---- derived helpers --------------------------------------------------------
function withProgress(opp, rmap) {
  const r = (rmap && rmap[opp.id]) || { sum: 0, count: 0 };
  const raised = (Number(opp.raisedOffset) || 0) + r.sum;
  const target = Number(opp.target) || 0;
  const remaining = Math.max(target - raised, 0);
  const pct = target > 0 ? Math.min(100, Math.round((raised / target) * 100)) : 0;
  return Object.assign({}, opp, { raised, remaining, pct, donors: r.count, completed: target > 0 && raised >= target });
}
const byOrder = (a, b) => (a.order || 0) - (b.order || 0);

async function opportunitiesWithProgress() {
  const [list, rmap] = await Promise.all([backend.listOpportunities(), backend.raisedMap()]);
  return list.sort(byOrder).map(o => withProgress(o, rmap));
}
async function publicOpportunities() {
  return (await opportunitiesWithProgress()).filter(o => o.status === 'active' || o.status === 'completed');
}
async function opportunityWithProgress(key) {
  const o = await backend.getOpportunity(key);
  if (!o) return null;
  return withProgress(o, await backend.raisedMap());
}

module.exports = Object.assign({}, backend, { newId, withProgress, opportunitiesWithProgress, publicOpportunities, opportunityWithProgress, byOrder });
