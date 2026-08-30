// api/chat.js
// Secure backend endpoint — deployed on Vercel.
// The Gemini API key lives ONLY here, as a server-side environment variable
// (GEMINI_API_KEY). It is never sent to the browser, never appears in the
// page source, and never appears in the frontend JavaScript.

export default async function handler(req, res) {
  // Allow only POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server is not configured. Add GEMINI_API_KEY in your Vercel project settings.'
    });
  }

  let message = '';
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    message = (body && body.message) ? String(body.message).trim() : '';
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request body.' });
  }

  if (!message) {
    return res.status(400).json({ error: 'Message is required.' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'Message is too long.' });
  }

  const MODEL = 'gemini-3.6-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  const systemInstruction = {
    parts: [{
      text:
        "You are Synaptron AI, the assistant for a product called Synaptron AI " +
        "(tagline: The All-In-One Super AI). You help users with general questions, " +
        "planning, and explaining what Synaptron AI can do — image generation, video " +
        "generation, website building, app building, study help, and personal " +
        "assistant tasks. Be warm, concise, and professional. If a user asks you to " +
        "literally generate an image, a video, a website, or an app file, clearly say " +
        "that live generation for that capability is still being connected, and offer " +
        "to help in text/plan form instead. Never claim to have created a real file, " +
        "download link, or attachment that doesn't actually exist."
    }]
  };

  try {
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        system_instruction: systemInstruction,
        contents: [
          { role: 'user', parts: [{ text: message }] }
        ],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 512
        }
      })
    });

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      const errMsg = (data && data.error && data.error.message) || 'Gemini API request failed.';
      return res.status(geminiRes.status).json({ error: errMsg });
    }

    const reply =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Sorry, I couldn't generate a response just now. Please try again.";

    return res.status(200).json({ reply });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reach Gemini API.' });
  }
}
