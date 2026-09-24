// /api/chat.js — Vercel serverless function (Node.js runtime)
// Powers the Study Assistant with real, live answers from Claude.
//
// SETUP (required):
//   1. Get an API key from https://console.anthropic.com
//   2. In your Vercel project: Settings -> Environment Variables
//      add  ANTHROPIC_API_KEY = sk-ant-...   (Production + Preview)
//   3. Redeploy. That's it — no other code changes needed.
//
// The key stays server-side only. It is never sent to the browser.

const SYSTEM_PROMPT = `You are the Study Assistant inside Aviqo AI — a real-time
study, research and tech-guidance companion for students.

How you help:
- Answer the student's actual question directly and clearly — never a generic
  or unrelated canned answer.
- For concepts (science, history, math, language, etc.): explain simply first,
  then add depth. Use a short concrete example wherever it helps understanding.
- For research questions: do a genuine deep dive — synthesize the key facts,
  note dates/figures accurately, and mention where information may be
  disputed or uncertain rather than guessing.
- For coding / tech questions: give a working, correctly-formatted code
  answer, explain *why* it works, and point out the likely mistake if the
  student is debugging.
- Keep the student's level in mind — ask a brief clarifying question only if
  the request is genuinely ambiguous, otherwise just answer.
- Use light Markdown: **bold** for key terms, \`code\` for inline code,
  triple-backtick fenced blocks for multi-line code, and "- " bullet points
  for lists. Keep paragraphs short.
- Be encouraging but honest — if you're not sure of something, say so instead
  of inventing facts.`;

const MODEL = 'claude-sonnet-5';

async function callClaude(apiKey, messages, withSearch) {
  const body = {
    model: MODEL,
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages
  };
  if (withSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }];
  }

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  const data = await r.json();
  if (!r.ok) {
    const err = new Error((data && data.error && data.error.message) || 'Anthropic API request failed');
    err.status = r.status;
    err.raw = data;
    throw err;
  }
  return data;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed', message: 'Use POST.' });
    return;
  }

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.status(500).json({
        error: 'missing_api_key',
        message: "ANTHROPIC_API_KEY isn't set on the server. Add it in Vercel's Environment Variables and redeploy."
      });
      return;
    }

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const messages = Array.isArray(body && body.messages) ? body.messages : null;
    const deepSearch = !!(body && body.deepSearch);

    if (!messages || !messages.length) {
      res.status(400).json({ error: 'bad_request', message: 'No conversation messages were sent.' });
      return;
    }

    // Anthropic only accepts role: "user" | "assistant" with string content.
    const cleanMessages = messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: m.content }));

    let data;
    try {
      data = await callClaude(apiKey, cleanMessages, deepSearch);
    } catch (e) {
      // If web search isn't available on this key/plan, fall back to a
      // normal answer instead of failing the whole request.
      if (deepSearch) {
        data = await callClaude(apiKey, cleanMessages, false);
      } else {
        throw e;
      }
    }

    const blocks = data.content || [];
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n\n').trim();
    const usedSearch = blocks.some(b => b.type === 'server_tool_use' || b.type === 'web_search_tool_result');

    res.status(200).json({
      text: text || "I couldn't put together an answer that time — could you try rephrasing the question?",
      usedSearch
    });
  } catch (err) {
    const status = err && err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    res.status(status).json({
      error: 'server_error',
      message: (err && err.message) || 'Something went wrong talking to the AI.'
    });
  }
};
