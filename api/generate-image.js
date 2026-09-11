// api/generate-image.js
// Secure backend endpoint — deployed on Vercel.
// The OpenAI API key lives ONLY here, as a server-side environment variable
// (OPENAI_API_KEY). It is never sent to the browser, never appears in the
// page source, and never appears in the frontend JavaScript.

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb'
    }
  }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server is not configured. Add OPENAI_API_KEY in your Vercel project settings.'
    });
  }

  let prompt = '';
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    prompt = (body && body.prompt) ? String(body.prompt).trim() : '';
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request body.' });
  }

  if (!prompt) {
    return res.status(400).json({ error: 'A prompt describing the image is required.' });
  }
  if (prompt.length > 1000) {
    return res.status(400).json({ error: 'Prompt is too long.' });
  }

  try {
    const openaiRes = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt,
        size: '1024x1024',
        quality: 'low',
        n: 1
      })
    });

    const data = await openaiRes.json();

    if (!openaiRes.ok) {
      const errMsg = (data && data.error && data.error.message) || 'Image generation failed.';
      return res.status(openaiRes.status).json({ error: errMsg });
    }

    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      return res.status(500).json({ error: 'No image was returned.' });
    }

    return res.status(200).json({ image: `data:image/png;base64,${b64}` });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reach OpenAI API.' });
  }
}
