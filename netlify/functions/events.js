// Server-side event log: cross-device source-of-truth for ALL behaviour
// (page views, section views, clicks, video milestones, etc.).
//
// Storage strategy (simple, fits a podcast studio LP):
// - Single Blob "log" holds the last MAX_LOG events as a JSON array.
// - POST appends an event (read-modify-write). Race conditions can
//   under-count by a tiny margin under heavy concurrency, which is
//   acceptable for analytics.
// - GET re-aggregates the log on every request — keeps the writer
//   path cheap and the read path always reflects exact current
//   state.
//
// Auth on GET/DELETE: Bearer token equal to env var ADMIN_PWD_HASH
// (same SHA-256 hash that gates the client-side admin login).

import { getStore } from '@netlify/blobs';

const STORE_NAME = 'events_v1';
const LOG_KEY = 'log';
const MAX_LOG = 5000;
const RECENT_FOR_DASHBOARD = 200;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

function clientIPFrom(headers) {
  const xff = headers['x-forwarded-for'] || headers['X-Forwarded-For'];
  if (xff) return xff.split(',')[0].trim();
  return headers['x-nf-client-connection-ip'] || headers['client-ip'] || '';
}

function isAuthorized(event) {
  const expected = process.env.ADMIN_PWD_HASH;
  if (!expected) return false;
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return m[1].trim().toLowerCase() === expected.trim().toLowerCase();
}

function openStore() {
  const siteID = process.env.NETLIFY_BLOBS_SITE_ID;
  const blobsToken = process.env.NETLIFY_BLOBS_TOKEN;
  return (siteID && blobsToken)
    ? getStore({ name: STORE_NAME, siteID, token: blobsToken, consistency: 'strong' })
    : getStore(STORE_NAME);
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  const store = openStore();

  // ── POST: any visitor logs an event ────────────────────────────
  if (event.httpMethod === 'POST') {
    let payload;
    try { payload = JSON.parse(event.body || '{}'); }
    catch (e) {
      return { statusCode: 400, headers: corsHeaders(), body: 'Invalid JSON' };
    }
    const name = (payload.name || '').toString().trim();
    if (!name) {
      return { statusCode: 400, headers: corsHeaders(), body: 'name required' };
    }
    const ts = Date.now();
    const record = {
      ts,
      name,
      meta: payload.meta || null,
      session: payload.session || null,
      utm: payload.utm || null,
      ip: clientIPFrom(event.headers || {}),
      ua: (event.headers['user-agent'] || '').slice(0, 200)
    };

    try {
      const log = (await store.get(LOG_KEY, { type: 'json' })) || { items: [] };
      log.items.unshift(record);
      if (log.items.length > MAX_LOG) log.items.length = MAX_LOG;
      await store.setJSON(LOG_KEY, log);
    } catch (err) {
      return {
        statusCode: 500,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: String(err) })
      };
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true })
    };
  }

  // ── GET: admin pulls aggregated data for the dashboard ─────────
  if (event.httpMethod === 'GET') {
    if (!isAuthorized(event)) {
      return {
        statusCode: 401,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'unauthorized' })
      };
    }
    try {
      const log = (await store.get(LOG_KEY, { type: 'json' })) || { items: [] };
      const items = log.items || [];
      const agg = aggregate(items);
      return {
        statusCode: 200,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, total_in_log: items.length, ...agg })
      };
    } catch (err) {
      return {
        statusCode: 500,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: String(err) })
      };
    }
  }

  // ── DELETE: admin wipe for testing ─────────────────────────────
  if (event.httpMethod === 'DELETE') {
    if (!isAuthorized(event)) {
      return { statusCode: 401, headers: corsHeaders(), body: 'unauthorized' };
    }
    try {
      await store.setJSON(LOG_KEY, { items: [] });
      return {
        statusCode: 200,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, wiped: true })
      };
    } catch (err) {
      return {
        statusCode: 500,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: String(err) })
      };
    }
  }

  return { statusCode: 405, headers: corsHeaders(), body: 'Method Not Allowed' };
};

// ---------------------------------------------------------------
// Aggregation: rebuilds the same data shape the local dashboard already
// renders (events, sessions, recent, utms, videos, diagnostic, vitals).
// Front-end render functions need zero changes.
// ---------------------------------------------------------------

function aggregate(items) {
  const events = {};
  const sessions = new Set();
  const utms = { source: {}, medium: {}, campaign: {} };
  const videos = {};
  const diagnostic = { q1: {}, q2: {}, q3: {}, plans: {} };

  for (const ev of items) {
    if (!ev || !ev.name) continue;
    events[ev.name] = (events[ev.name] || 0) + 1;
    if (ev.session) sessions.add(ev.session);

    // UTM bucketization on session-creation events (page_view fires once per session)
    if (ev.name === 'pagina_visitada') {
      const u = ev.utm || (ev.meta && ev.meta.utm) || {};
      ['source', 'medium', 'campaign'].forEach((dim) => {
        const key = (u['utm_' + dim] && String(u['utm_' + dim]).trim()) || 'direto';
        utms[dim][key] = (utms[dim][key] || 0) + 1;
      });
    }

    // Per-video aggregates
    const isVideo = ev.name === 'video_marco_assistido' || ev.name === 'video_fechado'
                 || ev.name === 'video_terminou'        || ev.name === 'abriu_episodio_player';
    if (isVideo && ev.meta && ev.meta.epId) {
      const k = ev.meta.epId;
      if (!videos[k]) videos[k] = { id: k, title: ev.meta.title || '', badge: ev.meta.ep || '', maxPercent: 0, opens: 0, plays: 0, milestones: [] };
      const v = videos[k];
      if (ev.meta.title) v.title = ev.meta.title;
      if (ev.meta.ep) v.badge = ev.meta.ep;
      if (typeof ev.meta.percent === 'number' && ev.meta.percent > v.maxPercent) v.maxPercent = ev.meta.percent;
      if (ev.name === 'video_marco_assistido' && typeof ev.meta.percent === 'number' && v.milestones.indexOf(ev.meta.percent) === -1) {
        v.milestones.push(ev.meta.percent);
      }
      if (ev.name === 'abriu_episodio_player') v.opens = (v.opens || 0) + 1;
      if (ev.name === 'video_fechado') v.plays = (v.plays || 0) + 1;
    }

    // Diagnostic answers
    if (ev.name === 'diagnostico_completo' && ev.meta) {
      const ans = ev.meta.answers || {};
      ['1', '2', '3'].forEach((q) => {
        const val = ans[q];
        if (val) diagnostic['q' + q][val] = (diagnostic['q' + q][val] || 0) + 1;
      });
      if (ev.meta.plan) diagnostic.plans[ev.meta.plan] = (diagnostic.plans[ev.meta.plan] || 0) + 1;
    }
  }

  // Recent for the dashboard list (newest first, capped)
  const recent = items.slice(0, RECENT_FOR_DASHBOARD).map((it) => ({
    name: it.name,
    meta: it.meta,
    ts: it.ts
  }));

  return {
    events,
    sessions: Array.from(sessions),
    recent,
    utms,
    videos,
    diagnostic,
    server: true
  };
}
