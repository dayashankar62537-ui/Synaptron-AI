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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt, steps: 4 }),
      signal: controller.signal
    });

    const type = r.headers.get('content-type') || '';
    let base64 = '';
    let mime = 'image/png';

    if (type.includes('application/json')) {
      const data = await r.json().catch(() => null);
      if (!r.ok || !data || !data.success) {
        console.error('Cloudflare image error', r.status, JSON.stringify(data && data.errors));
        return res.status(502).json({ error: 'Image could not be generated right now. Please try again in a minute.' });
      }
      base64 = data.result && data.result.image;
      if (!base64) return res.status(502).json({ error: 'No image was returned. Please try a different description.' });
    } else {
      if (!r.ok) {
        console.error('Cloudflare image error', r.status);
        return res.status(502).json({ error: 'Image could not be generated right now. Please try again in a minute.' });
      }
      const buf = Buffer.from(await r.arrayBuffer());
      base64 = buf.toString('base64');
      mime = type.startsWith('image/') ? type : 'image/png';
    }

    return res.status(200).json({ image: `data:${mime};base64,${base64}` });
  } catch (err) {
    console.error('Image generation failed', err && err.name);
    const msg = err && err.name === 'AbortError'
      ? 'Image generation took too long. Please try a simpler description.'
      : 'Image generation failed. Please try again in a minute.';
    return res.status(503).json({ error: msg });
  } finally {
    clearTimeout(timer);
  }
}
