// Meta Conversions API proxy.
// Recebe eventos do navegador e encaminha para o Graph API com user_data hashed.
// Pareado com o Pixel client-side via event_id (deduplicação).
// Sem META_CAPI_TOKEN configurado -> retorna 200 com {skipped:true} (no-op gracioso).

import crypto from 'node:crypto';

const GRAPH_VERSION = 'v18.0';
// Pixel ID vem da env var META_PIXEL_ID (Netlify Site settings → Environment)
function getPixelId() {
  return process.env.META_PIXEL_ID || '';
}

function sha256(value) {
  if (value === null || value === undefined) return undefined;
  const v = String(value).trim().toLowerCase();
  if (!v) return undefined;
  return crypto.createHash('sha256').update(v).digest('hex');
}

function normalizePhoneDigits(phone) {
  if (!phone) return '';
  let d = String(phone).replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d;
}

function clientIPFrom(headers) {
  const xff = headers['x-forwarded-for'] || headers['X-Forwarded-For'];
  if (xff) return xff.split(',')[0].trim();
  return headers['x-nf-client-connection-ip'] || headers['client-ip'] || '';
}

export const handler = async (event) => {
  // CORS preflight (we expect same-origin POSTs but this keeps it forgiving)
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: 'Method Not Allowed' };
  }

  const token = process.env.META_CAPI_TOKEN;
  const pixelId = getPixelId();
  if (!token || !pixelId) {
    // Graceful no-op while you generate the token / set the Pixel ID.
    return {
      statusCode: 200,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        skipped: true,
        reason: !token ? 'META_CAPI_TOKEN not set' : 'META_PIXEL_ID not set'
      })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: corsHeaders(), body: 'Invalid JSON' };
  }

  const {
    name,
    custom = false,
    params = {},
    event_id,
    event_source_url,
    client_user_agent,
    fbp,
    fbc,
    user_data: incomingUserData = {}
  } = payload;

  if (!name || !event_id) {
    return { statusCode: 400, headers: corsHeaders(), body: 'Missing name or event_id' };
  }

  // The admin dashboard hits this with name '__probe__' just to check whether the
  // token is configured. Don't waste a real CAPI call (and don't pollute the Pixel).
  if (name === '__probe__') {
    return {
      statusCode: 200,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, probe: true })
    };
  }

  const userData = {
    client_ip_address: clientIPFrom(event.headers || {}),
    client_user_agent: client_user_agent || event.headers['user-agent'] || ''
  };
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;

  // Hash phone / email if provided so Meta can match users without leaking PII
  const phoneDigits = normalizePhoneDigits(incomingUserData.phone);
  if (phoneDigits) userData.ph = sha256(phoneDigits);
  if (incomingUserData.email) userData.em = sha256(incomingUserData.email);

  // Strip non-Pixel params from custom_data
  const customData = { ...params };
  delete customData.event_id; // we send it at the top level

  const body = {
    data: [{
      event_name: name,
      event_time: Math.floor(Date.now() / 1000),
      event_id,
      event_source_url: event_source_url || '',
      action_source: 'website',
      user_data: userData,
      custom_data: customData
    }],
    access_token: token
  };

  // Test Events: se META_TEST_EVENT_CODE estiver setado, eventos aparecem
  // na aba "Test Events" do Events Manager (não vão pro tráfego de produção).
  const testCode = process.env.META_TEST_EVENT_CODE;
  if (testCode) body.test_event_code = testCode;

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${pixelId}/events`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    return {
      statusCode: res.ok ? 200 : 502,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: res.ok, status: res.status, response: safeJSON(text) })
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: String(err) })
    };
  }
};

function safeJSON(text) {
  try { return JSON.parse(text); } catch (e) { return text; }
}
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
