// Aviqo AI - image generation through Cloudflare Workers AI (FLUX schnell).
// Save as api/generate-image.js. The browser sends { prompt, user: { email } }
// and gets back { image: "data:image/png;base64,..." }. Keys stay on the server.
//
// Vercel Environment Variables (Production):
//   CLOUDFLARE_API_TOKEN   - Cloudflare API token with Workers AI Edit permission
//   CLOUDFLARE_ACCOUNT_ID  - 32-character Account ID from the Cloudflare dashboard
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN - same store as chat (credits and plans)
//
// Plan rules:
//   - Free users: credits from the shared store (10 at start), 2 credits per image,
//     and at most DAILY_IMAGE_LIMIT images per day. Over the limit -> 402 with upgrade: true.
//   - Paid users: a key plan:<email> with value "paid" skips the credit and daily limits.
//   - If the credits store is down, images are allowed (fail open) and nothing is charged.

const MODEL = '@cf/black-forest-labs/flux-1-schnell';
const MAX_PROMPT = 500;
const TIMEOUT_MS = 55000;
const IMAGE_COST = 2;
const DAILY_IMAGE_LIMIT = 5;
const FREE_CREDITS = 10;

const ALLOWED_ORIGINS = [
  'https://synaptron-ai.vercel.app'
];

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ---- Upstash Redis (same store and key style as api/chat.js) ----
// ---- Credits store: Cloudflare Workers KV (free). Uses CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
// and CLOUDFLARE_KV_NAMESPACE_ID. Same command shape as the old Upstash helper, so callers did not change.
async function kvRequest(method, key, value, ttl) {
  const acc = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const ns = process.env.CLOUDFLARE_KV_NAMESPACE_ID;
  if (!acc || !token || !ns) throw new Error('Credits store is not configured');
  let url = `https://api.cloudflare.com/client/v4/accounts/${acc}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(key)}`;
  if (ttl) url += '?expiration_ttl=' + ttl;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const opts = { method, headers: { 'Authorization': 'Bearer ' + token } };
    if (method === 'PUT') { opts.headers['Content-Type'] = 'text/plain'; opts.body = String(value); }
    const r = await fetch(url, Object.assign(opts, { signal: ctrl.signal }));
    if (method === 'GET' && r.status === 404) return null;
    if (!r.ok) throw new Error('Credits store error ' + r.status);
    return method === 'GET' ? await r.text() : true;
  } finally {
    clearTimeout(timer);
  }
}

async function redisCmd(cmd) {
  const op = cmd[0];
  const key = cmd[1];
  const arg = cmd[2];
  // Daily image counters expire automatically after about 25 hours.
  const ttl = key.startsWith('imgday:') ? 90000 : undefined;
  if (op === 'GET') return await kvRequest('GET', key);
  if (op === 'SETNX') {
    const cur = await kvRequest('GET', key);
    if (cur === null) { await kvRequest('PUT', key, arg, ttl); return 1; }
    return 0;
  }
  if (op === 'DECRBY' || op === 'INCRBY' || op === 'INCR') {
    const delta = op === 'INCR' ? 1 : Number(arg) * (op === 'DECRBY' ? -1 : 1);
    const cur = Number(await kvRequest('GET', key)) || 0;
    const next = cur + delta;
    await kvRequest('PUT', key, String(next), ttl);
    return next;
  }
  if (op === 'EXPIRE') return 1; // TTL is set when the key is written
  throw new Error('Unsupported store command');
}

function creditKeyFor(user, ip) {
  const email = user && typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
  if (email.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { id: email, key: 'credits:' + email };
  return { id: null, key: 'credits:ip:' + ip };
}

async function isPaid(id) {
  if (!id) return false;
  const v = await redisCmd(['GET', 'plan:' + id]);
  return v === 'paid';
}

async function getCredits(key) {
  await redisCmd(['SETNX', key, String(FREE_CREDITS)]);
  return Number(await redisCmd(['GET', key])) || 0;
}

// Returns the new balance, or null if there are not enough credits.
async function spendCredits(key, cost) {
  await getCredits(key);
  const left = Number(await redisCmd(['DECRBY', key, String(cost)]));
  if (left < 0) {
    await redisCmd(['INCRBY', key, String(cost)]);
    return null;
  }
  return left;
}

async function refundCredits(key, cost) {
  try { await redisCmd(['INCRBY', key, String(cost)]); } catch (e) { console.error('Refund failed'); }
}

function dayKeyFor(id) {
  const day = new Date().toISOString().slice(0, 10);
  return 'imgday:' + id + ':' + day;
}

async function imagesToday(id) {
  return Number(await redisCmd(['GET', dayKeyFor(id)])) || 0;
}

async function countImage(id) {
  const k = dayKeyFor(id);
  const n = Number(await redisCmd(['INCR', k]));
  if (n === 1) await redisCmd(['EXPIRE', k, '90000']);
}

// ---- Cloudflare call with one retry for temporary failures ----
async function callCloudflare(token, accountId, prompt) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`;
  const scrub = (text) => String(text || '').split(token).join('[hidden]').split(accountId).join('[account]');
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, steps: 4 }),
        signal: controller.signal
      });
      const type = r.headers.get('content-type') || '';

      if (type.includes('application/json')) {
        const data = await r.json().catch(() => null);
        if (!r.ok || !data || !data.success) {
          const cfMsg = data && Array.isArray(data.errors) && data.errors[0] && data.errors[0].message;
          lastError = { status: r.status, message: scrub(cfMsg || ('Cloudflare returned HTTP ' + r.status)) };
        } else {
          const base64 = data.result && data.result.image;
          if (!base64) {
            lastError = { status: 502, message: 'Cloudflare returned no image data.' };
          } else {
            return { ok: true, image: 'data:image/png;base64,' + base64 };
          }
        }
      } else if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        const mime = type.startsWith('image/') ? type : 'image/png';
        return { ok: true, image: `data:${mime};base64,${buf.toString('base64')}` };
      } else {
        const text = (await r.text().catch(() => '')).slice(0, 200);
        lastError = { status: r.status, message: scrub('Cloudflare returned HTTP ' + r.status + (text ? ': ' + text : '')) };
      }
    } catch (err) {
      lastError = err && err.name === 'AbortError'
        ? { status: 504, message: 'Image generation timed out after 55 seconds. Try a simpler description.' }
        : { status: 503, message: 'Network error while calling Cloudflare: ' + scrub(err && err.message ? err.message : 'unknown') };
    } finally {
      clearTimeout(timer);
    }

    const retryable = lastError && (lastError.status === 429 || lastError.status >= 500);
    if (!retryable || attempt === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return { ok: false, status: lastError ? lastError.status : 502, message: lastError ? lastError.message : 'Image generation failed.' };
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  if (!token || !accountId) {
    return res.status(500).json({
      error: 'Image generation is not configured yet. Add CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in Vercel.'
    });
  }
  // The account ID is 32 hex characters. A pasted command or a token here breaks the URL and leaks the secret.
  if (!/^[a-f0-9]{32}$/i.test(accountId)) {
    console.error('CLOUDFLARE_ACCOUNT_ID has the wrong format');
    return res.status(500).json({
      error: 'Image setup error: CLOUDFLARE_ACCOUNT_ID must contain only the 32-character Account ID from the Cloudflare dashboard.'
    });
  }
  if (/\s/.test(token) || token.length < 20) {
    console.error('CLOUDFLARE_API_TOKEN has the wrong format');
    return res.status(500).json({
      error: 'Image setup error: CLOUDFLARE_API_TOKEN must contain only the API token value.'
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  const prompt = body && typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return res.status(400).json({ error: 'Please describe the image you want.' });
  if (prompt.length > MAX_PROMPT) {
    return res.status(400).json({ error: 'Image description is too long. Keep it under 500 characters.' });
  }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const who = creditKeyFor(body && body.user, ip);

  // ---- Plan, daily limit and credits (fail open if the store is down) ----
  let paid = false;
  let charged = false;
  let counted = false;
  try {
    paid = await isPaid(who.id);
    if (!paid && who.id) {
      if ((await imagesToday(who.id)) >= DAILY_IMAGE_LIMIT) {
        return res.status(402).json({
          error: `You have used your ${DAILY_IMAGE_LIMIT} free images for today. Upgrade to a paid plan to keep creating images.`,
          upgrade: true
        });
      }
    }
    if (!paid) {
      const left = await spendCredits(who.key, IMAGE_COST);
      if (left === null) {
        return res.status(402).json({
          error: 'You do not have enough credits for an image (it costs 2). Upgrade to a paid plan to keep creating.',
          credits: 0,
          upgrade: true
        });
      }
      charged = true;
    }
  } catch (e) {
    console.error('Credits store unavailable, allowing image', e && e.message);
    charged = false;
  }

  // ---- Generate ----
  const result = await callCloudflare(token, accountId, prompt);

  if (!result.ok) {
    if (charged) await refundCredits(who.key, IMAGE_COST);
    console.error('Cloudflare image failed', result.status);
    const status = result.status === 429 ? 429 : 502;
    return res.status(status).json({ error: result.message });
  }

  // Count the image for the daily limit only after it succeeded.
  if (!paid && who.id) {
    try { await countImage(who.id); counted = true; } catch (e) { console.error('Daily count failed'); }
  }

  return res.status(200).json({ image: result.image, model: MODEL, counted });
}
