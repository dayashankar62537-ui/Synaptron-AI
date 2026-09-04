// api/chat.js
// Secure backend endpoint — deployed on Vercel.
// The Groq API key lives ONLY here, as a server-side environment variable
// (GROQ_API_KEY). It is never sent to the browser, never appears in the
// page source, and never appears in the frontend JavaScript.
//
// Supports plain text messages AND an optional attached image (sent as
// base64 from the browser) using a vision-capable Groq model.

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '4mb'
    }
  }
};

const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

// Text-only model — fast and solid for general conversation.
const TEXT_MODEL = 'openai/gpt-oss-20b';
// Vision-capable model — used automatically when the user attaches a photo.
// Check https://console.groq.com/docs/models for the current vision model
// name if this one is ever retired.
const VISION_MODEL = 'qwen/qwen3.6-27b';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server is not configured. Add GROQ_API_KEY in your Vercel project settings.'
    });
  }

  let message = '';
  let image = null; // { mimeType, data } — data is base64 WITHOUT the data: prefix

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    message = (body && body.message) ? String(body.message).trim() : '';

    if (body && body.image && body.image.data && body.image.mimeType) {
      if (!ALLOWED_IMAGE_TYPES.includes(body.image.mimeType)) {
        return res.status(400).json({ error: 'Unsupported image type.' });
      }
      if (body.image.data.length > 4_000_000) {
        return res.status(400).json({ error: 'Image is too large. Please use an image under 3MB.' });
      }
      image = { mimeType: body.image.mimeType, data: body.image.data };
    }
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request body.' });
  }

  if (!message && !image) {
    return res.status(400).json({ error: 'Message or image is required.' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'Message is too long.' });
  }

  const systemPrompt =
    "You are Synaptron AI, the assistant for a product called Synaptron AI " +
    "(tagline: The All-In-One Super AI). You help users with general questions, " +
    "planning, and explaining what Synaptron AI can do — image generation, video " +
    "generation, website building, app building, study help, and personal " +
    "assistant tasks. Be warm, concise, and professional. If a user attaches a " +
    "photo, you can describe or discuss it, but you cannot generate, edit, or " +
    "return a new image file — clearly say so if asked, and offer to help in " +
    "text/plan form instead. If a user asks you to literally generate an image, a " +
    "video, a website, or an app file, clearly say that live generation for that " +
    "capability is still being connected (real image generation via a separate " +
    "service may already be available — mention that if relevant). Never claim " +
    "to have created a real file, download link, or attachment that doesn't " +
    "actually exist.";

  const model = image ? VISION_MODEL : TEXT_MODEL;

  let userContent;
  if (image) {
    userContent = [];
    if (message) userContent.push({ type: 'text', text: message });
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:${image.mimeType};base64,${image.data}` }
    });
  } else {
    userContent = message;
  }

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ],
        temperature: 0.7,
        max_completion_tokens: 512
      })
    });

    const data = await groqRes.json();

    if (!groqRes.ok) {
      const errMsg = (data && data.error && data.error.message) || 'Groq API request failed.';
      return res.status(groqRes.status).json({ error: errMsg });
    }

    const reply =
      data?.choices?.[0]?.message?.content ||
      "Sorry, I couldn't generate a response just now. Please try again.";

    return res.status(200).json({ reply });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reach Groq API.' });
  }
}
