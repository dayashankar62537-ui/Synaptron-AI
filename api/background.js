// api/remove-background.js
// Background removal via API Ninjas (Remove Background).
// Key lives only in the Vercel env variable API_NINJAS_KEY.
// Receives { image: { mimeType, data } } (data = base64 without prefix)
// Returns   { image: "data:image/png;base64,..." }

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } }
};

const ALLOWED = ['image/png', 'image/jpeg', 'image/webp'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.API_NINJAS_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server is not configured. Add API_NINJAS_KEY in your Vercel project settings.'
    });
  }

  let img = null;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    img = body && body.image;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request body.' });
  }

  if (!img || !img.data || !img.mimeType) {
    return res.status(400).json({ error: 'Please attach an image first.' });
  }
  if (!ALLOWED.includes(img.mimeType)) {
    return res.status(400).json({ error: 'Unsupported image type.' });
  }

  try {
    const bytes = Buffer.from(img.data, 'base64');
    const form = new FormData();
    form.append('image_file', new Blob([bytes], { type: img.mimeType }), 'photo');

    const r = await fetch('https://api.api-ninjas.com/v1/removebg', {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey },
      body: form
    });

    if (!r.ok) {
      let msg = 'Background removal failed.';
      try {
        const j = await r.json();
        if (j && j.error) msg = j.error;
      } catch (_) {}
      return res.status(r.status).json({ error: msg });
    }

    const ct = (r.headers.get('content-type') || '').toLowerCase();
    let mimeType = 'image/png';
    let b64;

    if (ct.startsWith('image/')) {
      mimeType = ct.split(';')[0];
      b64 = Buffer.from(await r.arrayBuffer()).toString('base64');
    } else {
      let text = (await r.text()).trim();
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed === 'string') text = parsed;
        else if (parsed && typeof parsed.image === 'string') text = parsed.image;
      } catch (_) {}
      b64 = text.replace(/^"|"$/g, '').replace(/^data:image\/[a-z]+;base64,/, '');
    }

    if (!b64) return res.status(500).json({ error: 'Background removal returned empty data.' });
    return res.status(200).json({ image: `data:${mimeType};base64,${b64}` });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reach image service.' });
  }
}
