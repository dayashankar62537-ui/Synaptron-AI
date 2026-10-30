// Aviqo AI - image generation through Cloudflare Workers AI (FLUX schnell).
// Save as api/generate-image.js. The browser sends { prompt } and gets back
// { image: "data:image/png;base64,..." }. Keys stay on the server.
//
// Vercel Environment Variables needed (Production):
//   CLOUDFLARE_API_TOKEN   - Cloudflare API token with "Workers AI: Read" and "Edit"
//   CLOUDFLARE_ACCOUNT_ID  - your Cloudflare account ID (Dashboard > Workers & Pages > right sidebar)

const MODEL = '@cf/black-forest-labs/flux-1-schnell';
const MAX_PROMPT = 500;
const TIMEOUT_MS = 55000;

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

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) {
    return res.status(500).json({
      error: 'Image generation is not configured yet. Add CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in Vercel.'
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

  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${MODEL}`;

  // One automatic retry for temporary failures (rate limit or server error).
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
          lastError = { status: r.status, message: cfMsg || ('Cloudflare returned HTTP ' + r.status) };
        } else {
          const base64 = data.result && data.result.image;
          if (!base64) {
            lastError = { status: 502, message: 'Cloudflare returned no image data.' };
          } else {
            return res.status(200).json({ image: 'data:image/png;base64,' + base64, model: MODEL });
          }
        }
      } else if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        const mime = type.startsWith('image/') ? type : 'image/png';
        return res.status(200).json({ image: `data:${mime};base64,${buf.toString('base64')}`, model: MODEL });
      } else {
        const text = (await r.text().catch(() => '')).slice(0, 200);
        lastError = { status: r.status, message: 'Cloudflare returned HTTP ' + r.status + (text ? ': ' + text : '') };
      }
    } catch (err) {
      lastError = err && err.name === 'AbortError'
        ? { status: 504, message: 'Image generation timed out after 55 seconds. Try a simpler description.' }
        : { status: 503, message: 'Network error while calling Cloudflare: ' + (err && err.message ? err.message : 'unknown') };
    } finally {
      clearTimeout(timer);
    }

    const retryable = lastError && (lastError.status === 429 || lastError.status >= 500);
    if (!retryable || attempt === 2) break;
    console.error('Cloudflare image attempt failed, retrying', lastError.status);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  console.error('Cloudflare image failed', lastError && lastError.status, lastError && lastError.message);
  const status = lastError && lastError.status >= 400 && lastError.status < 600 ? (lastError.status === 429 ? 429 : 502) : 502;
  return res.status(status).json({ error: lastError ? lastError.message : 'Image generation failed.' });
}
