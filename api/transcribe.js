// api/transcribe.js
// Speech-to-text fallback for browsers without the Web Speech API.
// Receives one short recorded audio clip (raw body) and returns { text } from Groq Whisper.
// The key stays on the server: set GROQ_API_KEY in Vercel project settings.
// Nothing is stored. The audio is sent to Groq for transcription and dropped afterwards.

export const config = { api: { bodyParser: false }, maxDuration: 30 };

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;      // about 8 MB, roughly a few minutes of compressed speech
const MAX_TEXT_CHARS = 4000;
const MODEL = 'whisper-large-v3-turbo';
const ALLOWED_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav'];
// Language hints from the page's language picker. Unknown values fall back to automatic detection.
const LANG_HINT = { 'hi-IN': 'hi', 'en-IN': 'en', 'en-US': 'en', 'pa-IN': 'pa' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_AUDIO_BYTES) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(503).json({ error: 'Voice typing is not available right now.' });

  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.includes(type)) return res.status(415).json({ error: 'Unsupported audio type.' });

  let audio;
  try {
    audio = await readBody(req);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.status === 413 ? 'Recording is too long. Try a shorter clip.' : 'Could not read the recording.' });
  }
  if (!audio.length) return res.status(400).json({ error: 'Empty recording.' });

  const lang = LANG_HINT[String((req.query && req.query.lang) || '')];
  const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'mp4' : type.includes('wav') ? 'wav' : type.includes('mpeg') ? 'mp3' : 'webm';

  const form = new FormData();
  form.append('file', new Blob([audio], { type }), 'speech.' + ext);
  form.append('model', MODEL);
  form.append('response_format', 'json');
  form.append('temperature', '0');
  if (lang) form.append('language', lang);

  let upstream;
  try {
    upstream = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key },
      body: form,
      signal: AbortSignal.timeout(25000)
    });
  } catch (e) {
    console.error('Transcribe network error', e && e.message);
    return res.status(502).json({ error: 'Transcription failed. Please try again.' });
  }
  if (!upstream.ok) {
    console.error('Transcribe provider failed', JSON.stringify({ status: upstream.status }));
    return res.status(502).json({ error: 'Transcription failed. Please try again.' });
  }
  const data = await upstream.json().catch(() => ({}));
  const text = String(data.text || '').trim().slice(0, MAX_TEXT_CHARS);
  return res.status(200).json({ text });
}
