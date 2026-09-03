// api/video-start.js
// Starts a real AI video generation job with Pixazo's free LTX model.
// Video generation takes time, so this endpoint just STARTS the job and
// returns a request ID. The frontend polls /api/video-status with that ID
// until the video is ready.
//
// PIXAZO_API_KEY lives only here as a server-side environment variable.
//
// NOTE: Pixazo's exact model_id/operation path for LTX is assumed as
// "ltx/v1/text-to-video" below based on their documented pattern
// (gateway.pixazo.ai/<model_id>/<operation>). If Pixazo returns a 404 or
// "model not found" error, check the exact model_id in your Pixazo
// dashboard/docs and update the MODEL_PATH constant below.

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '50kb'
    }
  }
};

const MODEL_PATH = 'ltx/v1/text-to-video';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.PIXAZO_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server is not configured. Add PIXAZO_API_KEY in your Vercel project settings.'
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
    return res.status(400).json({ error: 'A prompt describing the video is required.' });
  }
  if (prompt.length > 1000) {
    return res.status(400).json({ error: 'Prompt is too long.' });
  }

  try {
    const pixazoRes = await fetch(`https://gateway.pixazo.ai/${MODEL_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Ocp-Apim-Subscription-Key': apiKey
      },
      body: JSON.stringify({
        content: [{ type: 'text', text: prompt }]
      })
    });

    const data = await pixazoRes.json();

    if (!pixazoRes.ok) {
      const errMsg = (data && (data.error || data.message)) || 'Video generation request failed.';
      return res.status(pixazoRes.status).json({ error: errMsg });
    }

    const requestId = data.request_id || data.id;
    if (!requestId) {
      return res.status(500).json({ error: 'Pixazo did not return a request id.' });
    }

    return res.status(200).json({ id: requestId, state: 'pending' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reach the video generation service.' });
  }
}
