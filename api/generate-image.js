// Aviqo AI - image generation through Cloudflare Workers AI (FLUX schnell).
// Save as api/generate-image.js. The browser sends { prompt, aspect, user: { email } }
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
//   - Credits are refunded whenever the image is not produced (provider error, timeout, crash).

// Vercel default timeout is too short for an image model. Keep this above BUDGET_MS.
export const config = { maxDuration: 60 };

const MODEL = '@cf/black-forest-labs/flux-1-schnell';
const MAX_PROMPT = 500;
const TIMEOUT_MS = 30000;   // one provider attempt
const BUDGET_MS = 50000;    // whole request, leaves room under maxDuration
const IMAGE_COST = 2;
const DAILY_IMAGE_LIMIT = 5;
const FREE_CREDITS = 10;

// Model capabilities. The provider documents only prompt and steps for FLUX.1 schnell, so the
// width/height we send are requested per image and CHECKED against the returned PNG header.
// A resolution level is enabled only when its scale is a number here (null = not supported).
const MODEL_CAPS = {
  label: 'FLUX.1 schnell',
  aspects: {
    '1:1': [1024, 1024],
    '16:9': [1344, 768],
    '9:16': [768, 1344],
    '4:3': [1024, 768],
    '3:4': [768, 1024],
    '4:5': [896, 1120]   // kept for the Design Studio page
  },
  resolutions: { standard: 1, high: null, max: null }
};
const ASPECT_LABELS = { auto: 'Auto', '1:1': 'Square (1:1)', '16:9': 'Landscape (16:9)', '9:16': 'Portrait (9:16)', '4:3': 'Standard (4:3)', '3:4': 'Portrait Photo (3:4)', '4:5': 'Portrait (4:5)' };
const RESOLUTION_LABELS = { standard: 'Standard', high: 'High Resolution', max: 'Maximum Available' };
const ASPECTS = MODEL_CAPS.aspects;

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
async function redisCmd(cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Credits store is not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
      signal: controller.signal
    });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || d.error) throw new Error('Credits store error');
    return d.result;
  } finally {
    clearTimeout(timer);
  }
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

// Reads width and height from the PNG header of a data URL. Null if it is not a PNG.
function pngSize(dataUrl) {
  const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[1].slice(0, 64), 'base64');
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// What the UI may offer for this model. Sent by GET /api/generate-image.
function capabilities() {
  return {
    model: MODEL_CAPS.label,
    defaults: { aspect: 'auto', resolution: 'standard' },
    aspects: [{ id: 'auto', label: ASPECT_LABELS.auto, enabled: true }].concat(
      ['1:1', '16:9', '9:16', '4:3', '3:4'].map((id) => ({ id, label: ASPECT_LABELS[id], enabled: true }))
    ),
    resolutions: Object.keys(RESOLUTION_LABELS).map((id) => {
      const on = MODEL_CAPS.resolutions[id] !== null && MODEL_CAPS.resolutions[id] !== undefined;
      return on
        ? { id, label: RESOLUTION_LABELS[id], enabled: true }
        : { id, label: RESOLUTION_LABELS[id], enabled: false, reason: 'Not supported by ' + MODEL_CAPS.label + ' here. Only the standard size is verified.' };
    }),
    note: 'Each result reports the size the provider actually returned.'
  };
}

// ---- Cloudflare call. Retries once on 429/5xx/network errors, never past the request budget. ----
async function callCloudflare(token, accountId, prompt, size, deadline) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`;
  const scrub = (text) => String(text || '').split(token).join('[hidden]').split(accountId).join('[account]');
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const left = deadline - Date.now();
    if (left < 4000) {
      lastError = lastError || { status: 504, message: 'Image generation timed out. Please try again with a shorter description.' };
      break;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(TIMEOUT_MS, left));
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(size ? { prompt, steps: 4, width: size[0], height: size[1] } : { prompt, steps: 4 }),
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
          if (!base64 || typeof base64 !== 'string') {
            lastError = { status: 502, message: 'The image model returned no image. Please try again.' };
          } else {
            return { ok: true, image: 'data:image/png;base64,' + base64 };
          }
        }
      } else if (r.ok) {
        // Raw image bytes (some models return binary instead of JSON)
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length === 0) {
          lastError = { status: 502, message: 'The image model returned an empty file. Please try again.' };
        } else {
          const mime = type.startsWith('image/') ? type : 'image/png';
          return { ok: true, image: `data:${mime};base64,${buf.toString('base64')}` };
        }
      } else {
        const text = (await r.text().catch(() => '')).slice(0, 200);
        lastError = { status: r.status, message: scrub('Cloudflare returned HTTP ' + r.status + (text ? ': ' + text : '')) };
      }
    } catch (err) {
      lastError = err && err.name === 'AbortError'
        ? { status: 504, message: 'Image generation timed out. Please try again, or use a simpler description.' }
        : { status: 503, message: 'Could not reach the image service. Please try again in a moment.' };
      console.error('Image provider network error', scrub(err && err.name), scrub(err && err.message));
    } finally {
      clearTimeout(timer);
    }

    const retryable = lastError && (lastError.status === 429 || lastError.status >= 500);
    if (!retryable || attempt === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return { ok: false, status: lastError ? lastError.status : 502, message: lastError ? lastError.message : 'Image generation failed.' };
}

// ---- Request handling. `state` records a charge so it can be refunded on any failure. ----
async function handleImage(req, res, state) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') return res.status(200).json(capabilities());
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  if (!token || !accountId) {
    console.error('Image not configured', JSON.stringify({ hasToken: !!token, hasAccountId: !!accountId }));
    return res.status(500).json({
      error: 'Image generation is not configured yet. Add CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in Vercel.',
      code: 'not_configured'
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

  // Validate the settings BEFORE any credits are spent.
  const aspect = body && body.aspect ? String(body.aspect) : 'auto';
  if (aspect !== 'auto' && !Object.prototype.hasOwnProperty.call(ASPECTS, aspect)) {
    return res.status(400).json({ error: 'Choose Auto, 1:1, 16:9, 9:16, 4:3 or 3:4.' });
  }
  const resolution = body && body.resolution ? String(body.resolution) : 'standard';
  if (!Object.prototype.hasOwnProperty.call(RESOLUTION_LABELS, resolution)) {
    return res.status(400).json({ error: 'Choose Standard, High Resolution or Maximum Available.' });
  }
  const scale = MODEL_CAPS.resolutions[resolution];
  if (scale === null || scale === undefined) {
    return res.status(400).json({ error: RESOLUTION_LABELS[resolution] + ' is not supported by ' + MODEL_CAPS.label + '. Choose Standard.' });
  }
  // Auto sends no size, so the model's own default is used. Otherwise the size is requested.
  const size = aspect === 'auto' ? null : ASPECTS[aspect].map((v) => Math.round((v * scale) / 8) * 8);

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const who = creditKeyFor(body && body.user, ip);

  // ---- Plan, daily limit and credits (fail open if the store is down) ----
  let paid = false;
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
      state.charged = true;
      state.key = who.key;
    }
  } catch (e) {
    console.error('Credits store unavailable, allowing image', e && e.message);
  }

  // ---- Generate ----
  const deadline = Date.now() + BUDGET_MS;
  let result = await callCloudflare(token, accountId, prompt, size, deadline);
  let fellBack = false;
  // If the model rejects or fails with a requested size, retry once with its default size. The response says so.
  if (!result.ok && size && result.status !== 429) {
    result = await callCloudflare(token, accountId, prompt, null, deadline);
    fellBack = true;
  }

  if (!result.ok) {
    if (state.charged) { await refundCredits(state.key, IMAGE_COST); state.charged = false; }
    // The provider error is logged in full (token and account ID already removed) so it can be read in Vercel logs.
    console.error('Image provider failed', JSON.stringify({ providerStatus: result.status, message: result.message, model: MODEL, sizeRequested: !!size, fellBack, promptChars: prompt.length }));
    const status = result.status === 429 ? 429 : (result.status === 504 ? 504 : 502);
    const code = result.status === 429 ? 'rate_limited' : (result.status === 504 ? 'timeout' : 'provider_error');
    return res.status(status).json({ error: result.message, code, providerStatus: result.status, credited: false });
  }

  // Count the image for the daily limit only after it succeeded.
  if (!paid && who.id) {
    try { await countImage(who.id); counted = true; } catch (e) { console.error('Daily count failed'); }
  }

  // The size is confirmed only when the returned PNG has exactly the requested width and height.
  const actual = pngSize(result.image);
  const sizeApplied = !!size && !fellBack && !!actual && actual.w === size[0] && actual.h === size[1];
  return res.status(200).json({
    image: result.image,
    model: MODEL,
    counted,
    aspect,
    resolution,
    requested: { aspect, resolution, width: size ? size[0] : null, height: size ? size[1] : null },
    width: actual ? actual.w : null,
    height: actual ? actual.h : null,
    sizeApplied
  });
}

export default async function handler(req, res) {
  const state = { charged: false, key: null };
  try {
    return await handleImage(req, res, state);
  } catch (err) {
    console.error('generate-image crashed', err && err.stack ? err.stack : (err && err.message));
    if (state.charged && state.key) await refundCredits(state.key, IMAGE_COST);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Image generation failed on the server. Your credits were not charged. Please try again.', code: 'server_error', credited: false });
    }
  }
}
