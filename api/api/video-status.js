// api/video-status.js
// Checks the status of a Pixazo video generation job started by
// /api/video-start, using Pixazo's unified status endpoint.
// GET /api/video-status?id=xxxx

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.PIXAZO_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server is not configured.' });
  }

  const id = req.query && req.query.id ? String(req.query.id) : '';
  if (!id) {
    return res.status(400).json({ error: 'Generation id is required.' });
  }

  try {
    const pixazoRes = await fetch(`https://gateway.pixazo.ai/v2/requests/status/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey
      }
    });

    const data = await pixazoRes.json();

    if (!pixazoRes.ok) {
      const errMsg = (data && (data.error || data.message)) || 'Could not check video status.';
      return res.status(pixazoRes.status).json({ error: errMsg });
    }

    // Map Pixazo's status values to what the frontend expects.
    const status = (data.status || '').toUpperCase();
    let state = 'pending';
    if (status === 'COMPLETED') state = 'completed';
    else if (status === 'FAILED' || status === 'ERROR') state = 'failed';

    const videoUrl = (data.output && Array.isArray(data.output.media_url) && data.output.media_url[0])
      ? data.output.media_url[0]
      : null;

    return res.status(200).json({
      state,
      video: videoUrl,
      failure_reason: data.error || null
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reach the video generation service.' });
  }
}
