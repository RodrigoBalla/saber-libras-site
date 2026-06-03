// Lead store: cross-device source-of-truth for leads.
// POST /leads      → public (rate-limit-light), saves a lead to Netlify Blobs
// GET  /leads      → admin-only (Bearer auth), returns all leads + aggregates
// DELETE /leads    → admin-only, clears the store (rare; for testing)
//
// Auth on GET/DELETE: client must send Authorization: Bearer <SHA-256 hex>
// where the hex equals the env var ADMIN_PWD_HASH (same value already in
// the client-side auth gate, also enforced server-side here so the data
// can't be scraped by an unauth'd client).

import { getStore } from '@netlify/blobs';

const STORE_NAME = 'leads';

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

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  // Netlify Blobs runtime auto-injection isn't reliable here, so we
  // fall back to explicit siteID + token from env vars when present.
  const siteID = process.env.NETLIFY_BLOBS_SITE_ID;
  const blobsToken = process.env.NETLIFY_BLOBS_TOKEN;
  const store = (siteID && blobsToken)
    ? getStore({ name: STORE_NAME, siteID, token: blobsToken, consistency: 'strong' })
    : getStore(STORE_NAME);

  // ── POST: anyone can submit a lead (it's behind consent + form anyway) ──
  if (event.httpMethod === 'POST') {
    let payload;
    try { payload = JSON.parse(event.body || '{}'); }
    catch (e) {
      return { statusCode: 400, headers: corsHeaders(), body: 'Invalid JSON' };
    }

    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 10);
    const key = `lead_${ts}_${rand}`;

    const record = {
      id: key,
      ts,
      iso: new Date(ts).toISOString(),
      ip: clientIPFrom(event.headers || {}),
      user_agent: event.headers['user-agent'] || '',
      // Lead fields (pass through whatever client sent)
      nome:           payload.nome || '',
      whatsapp:       payload.whatsapp || '',
      data_desejada:  payload.data_desejada || '',
      plano:          payload.plano || '',
      cupom:          payload.cupom || '',
      mensagem:       payload.mensagem || '',
      fonte:          payload.fonte || '',
      utm_source:     payload.utm_source || '',
      utm_medium:     payload.utm_medium || '',
      utm_campaign:   payload.utm_campaign || '',
      utm_content:    payload.utm_content || '',
      utm_term:       payload.utm_term || ''
    };

    try {
      await store.setJSON(key, record);
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
      body: JSON.stringify({ ok: true, id: key })
    };
  }

  // ── GET: admin-only listing + aggregates ──
  if (event.httpMethod === 'GET') {
    if (!isAuthorized(event)) {
      return {
        statusCode: 401,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'unauthorized' })
      };
    }

    try {
      const { blobs } = await store.list();
      const leads = [];
      for (const blob of blobs) {
        try {
          const val = await store.get(blob.key, { type: 'json' });
          if (val) leads.push(val);
        } catch (e) {}
      }
      // Newest first
      leads.sort((a, b) => (b.ts || 0) - (a.ts || 0));

      const aggregate = aggregateLeads(leads);

      return {
        statusCode: 200,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, total: leads.length, leads, aggregate })
      };
    } catch (err) {
      return {
        statusCode: 500,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: String(err) })
      };
    }
  }

  // ── DELETE: admin-only wipe (handy for tests) ──
  if (event.httpMethod === 'DELETE') {
    if (!isAuthorized(event)) {
      return { statusCode: 401, headers: corsHeaders(), body: 'unauthorized' };
    }
    try {
      const { blobs } = await store.list();
      for (const blob of blobs) {
        try { await store.delete(blob.key); } catch (e) {}
      }
      return {
        statusCode: 200,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, wiped: blobs.length })
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

function aggregateLeads(leads) {
  const total = leads.length;
  const by = (key) => {
    const buckets = {};
    for (const l of leads) {
      const k = (l[key] || '').toString().trim() || '-';
      buckets[k] = (buckets[k] || 0) + 1;
    }
    return buckets;
  };
  const today = new Date(); today.setHours(0,0,0,0);
  const last7 = today.getTime() - 6 * 86400000;
  const series7 = {};
  for (let i = 0; i < 7; i++) {
    const d = new Date(last7 + i * 86400000);
    const k = d.toISOString().slice(0, 10);
    series7[k] = 0;
  }
  for (const l of leads) {
    const k = new Date(l.ts || 0).toISOString().slice(0, 10);
    if (k in series7) series7[k]++;
  }
  return {
    total,
    by_plano:        by('plano'),
    by_fonte:        by('fonte'),
    by_utm_source:   by('utm_source'),
    by_utm_campaign: by('utm_campaign'),
    last_7_days:     series7
  };
}
