// api/chat.js
// Secure backend endpoint — deployed on Vercel.
// API keys live ONLY here, as server-side environment variables:
//   GROQ_API_KEY        -> chat (text + vision)
//   API_NINJAS_KEY      -> image generation (API Ninjas Text-to-Image)
// They are never sent to the browser or the frontend JavaScript.
//
// Supports plain text messages, an optional attached image (base64 from the
// browser) using a vision-capable Groq model, and image GENERATION when the
// user asks for it (via API Ninjas).

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
const VISION_MODEL = 'qwen/qwen3.6-27b';

// Detects requests like "generate an image of a cat", "make a picture of...",
// "image banao ...", "photo bana do ..."
function wantsImageGeneration(text) {
  const t = text.toLowerCase();
  const verb = /(generate|create|make|draw|design|produce|paint|banao|bana\s?do|bana\s?de|banado|banana)/;
  const noun = /(image|picture|photo|pic|illustration|logo|wallpaper|artwork|tasveer|tasvir)/;
  return verb.test(t) && noun.test(t);
}

// Turns "generate an image of a red car" into "a red car" (falls back to full text).
function extractImagePrompt(text) {
  const m = text.match(/(?:image|picture|photo|pic|illustration|logo|wallpaper|artwork)\s+(?:of|for|showing|with|about)\s+(.+)/i);
  const prompt = (m ? m[1] : text).trim();
  return prompt.slice(0, 500);
}

async function generateImageWithApiNinjas(prompt, apiKey) {
  const url =
    'https://api.api-ninjas.com/v1/texttoimage?width=512&height=512&text=' +
    encodeURIComponent(prompt);

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
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }

  const contentType = (r.headers.get('content-type') || '').toLowerCase();

  // Case 1: raw image bytes
  if (contentType.startsWith('image/')) {
    const buf = Buffer.from(await r.arrayBuffer());
    return {
      mimeType: contentType.split(';')[0],
      data: buf.toString('base64')
    };
  }

  // Case 2: base64 text (plain string or JSON-wrapped string)
  let text = (await r.text()).trim();
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string') text = parsed;
    else if (parsed && typeof parsed.image === 'string') text = parsed.image;
  } catch (_) {}
  text = text.replace(/^"|"$/g, '').replace(/^data:image\/[a-z]+;base64,/, '');

  if (!text) throw new Error('Image generation returned empty data.');
  return { mimeType: 'image/jpeg', data: text };
}

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

  // ---- Image generation (API Ninjas) ----
  // Only when the user did not attach a photo and is clearly asking for a new image.
  if (!image && message && wantsImageGeneration(message)) {
    const ninjasKey = process.env.API_NINJAS_KEY;
    if (!ninjasKey) {
      return res.status(500).json({
        error: 'Image generation is not configured. Add API_NINJAS_KEY in your Vercel project settings.'
      });
    }
    try {
      const generated = await generateImageWithApiNinjas(extractImagePrompt(message), ninjasKey);
      return res.status(200).json({
        reply: 'Here is your generated image.',
        image: generated // { mimeType, data } -> show as data:<mimeType>;base64,<data>
      });
    } catch (err) {
      return res.status(err.status || 500).json({
        error: err.message || 'Image generation failed.'
      });
    }
  }

  const systemPrompt =
    "You are Aviqo AI, the assistant for a product called Aviqo AI " +
    "(tagline: The All-In-One Super AI). You help users with general questions, " +
    "planning, and explaining what Aviqo AI can do — image generation, video " +
    "generation, website building, app building, study help, and personal " +
    "assistant tasks. Be warm, concise, and professional. Format your answers " +
    "for easy reading: when explaining more than one point, step, or option, " +
    "use short bullet points (each starting with '- ') instead of one long " +
    "paragraph. Keep each bullet to a single short line where possible. Use " +
    "plain text only — no markdown symbols like ** or #. If a user attaches a " +
    "photo, you can describe or discuss it, but you cannot generate, edit, or " +
    "return a new image file — clearly say so if asked, and offer to help in " +
    "text/plan form instead. Image generation is available: if a user wants a " +
    "new image, tell them to ask like 'generate an image of ...'. If a user " +
    "asks you to literally generate a video, a website, or an app file, clearly " +
    "say that live generation for that capability is still being connected. " +
    "Never claim to have created a real file, download link, or attachment that " +
    "doesn't actually exist.";

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
