// api/generate-image.js
// Image generation via API Ninjas (Text-to-Image).
// Key lives only in the Vercel env variable API_NINJAS_KEY.
// Returns { image: "data:image/jpeg;base64,..." } which index.html displays.

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

  let prompt = '';
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    prompt = (body && body.prompt) ? String(body.prompt).trim() : '';
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request body.' });
  }

  if (!prompt) return res.status(400).json({ error: 'Prompt is required.' });
  if (prompt.length > 1000) return res.status(400).json({ error: 'Prompt is too long.' });

  // "generate an image of a red car" -> "a red car"
  const m = prompt.match(/(?:image|picture|photo|pic|illustration|logo|poster|artwork|thumbnail)\s+(?:of|for|showing|with|about)\s+(.+)/i);
  const cleaned = (m ? m[1] : prompt).slice(0, 500);

  try {
    const url =
      'https://api.api-ninjas.com/v1/texttoimage?width=512&height=512&text=' +
      encodeURIComponent(cleaned);

    const r = await fetch(url, {
      method: 'GET',
      headers: { 'X-Api-Key': apiKey, 'Accept': 'image/jpg' }
    });

    if (!r.ok) {
      let msg = 'Image generation failed.';
      try {
        const j = await r.json();
        if (j && j.error) msg = j.error;
      } catch (_) {}
      return res.status(r.status).json({ error: msg });
    }

    const contentType = (r.headers.get('content-type') || '').toLowerCase();
    let mimeType = 'image/jpeg';
    let b64;

    if (contentType.startsWith('image/')) {
      // raw image bytes
      mimeType = contentType.split(';')[0];
      b64 = Buffer.from(await r.arrayBuffer()).toString('base64');
    } else {
      // base64 text (plain or JSON-wrapped)
      let text = (await r.text()).trim();
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed === 'string') text = parsed;
        else if (parsed && typeof parsed.image === 'string') text = parsed.image;
      } catch (_) {}
      b64 = text.replace(/^"|"$/g, '').replace(/^data:image\/[a-z]+;base64,/, '');
    }

    if (!b64) return res.status(500).json({ error: 'Image generation returned empty data.' });

    return res.status(200).json({ image: `data:${mimeType};base64,${b64}` });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reach image service.' });
  }
}
