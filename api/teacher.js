// api/teacher.js
// Teacher Mode backend: Question Paper (with answer key and marking scheme) and MCQ generator.
// Reuses the same Upstash credits (credits:<email>) and GROQ_API_KEY as chat. Keys never reach the browser.
// Output is validated on the server: marks must add up to the requested total, and MCQs must have 4 distinct options.
// Nothing is stored. The syllabus is not verified; chapters are used exactly as the teacher typed them.

export const config = { maxDuration: 60 };

const TEACHER_MODEL = process.env.TEACHER_MODEL || 'openai/gpt-oss-20b';
const TYPES = ['mcq', 'short', 'long', 'numerical'];
const TYPE_LABEL = { mcq: 'Multiple choice questions', short: 'Short answer questions', long: 'Long answer questions', numerical: 'Numerical questions' };
const DIFFS = ['easy', 'medium', 'hard', 'mixed'];
const BOARDS = ['CBSE', 'PSEB', 'Other'];
const LANGS = { en: 'English', hi: 'Hindi (Devanagari)', hinglish: 'Hinglish (Hindi in Roman script)' };
const MAX_SETS = 3;
const SIGNED_IN_COST_PER_CALL = 2;
const FREE_CREDITS = 10;

// ---------- helpers ----------
export function norm(text) { return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Shared fields: class, board, subject, chapters, difficulty, language. Returns { cfg, errors }.
export function normalizeBase(raw) {
  const errors = [];
  const r = raw && typeof raw === 'object' ? raw : {};
  const cfg = {
    class: Number(r.class),
    board: str(r.board, 20),
    subject: str(r.subject, 60),
    chapters: Array.isArray(r.chapters) ? r.chapters.map((c) => str(c, 120)).filter(Boolean) : [],
    difficulty: str(r.difficulty, 10) || 'mixed',
    language: str(r.language, 12) || 'en'
  };
  if (!isInt(cfg.class, 1, 12)) errors.push('Class must be between 1 and 12.');
  if (!BOARDS.includes(cfg.board)) errors.push('Board must be CBSE, PSEB or Other.');
  if (!cfg.subject) errors.push('Subject is required.');
  if (!cfg.chapters.length || cfg.chapters.length > 15) errors.push('Enter 1 to 15 chapters.');
  if (!DIFFS.includes(cfg.difficulty)) errors.push('Difficulty must be easy, medium, hard or mixed.');
  if (!LANGS[cfg.language]) errors.push('Language must be en, hi or hinglish.');
  return { cfg, errors };
}

// Teacher's paper input. Returns { cfg, errors }.
export function normalizeConfig(raw) {
  const base = normalizeBase(raw);
  const errors = [...base.errors];
  const r = raw && typeof raw === 'object' ? raw : {};
  const cfg = Object.assign(base.cfg, {
    totalMarks: Number(r.totalMarks),
    durationMinutes: Number(r.durationMinutes),
    sets: r.sets === undefined ? 1 : Number(r.sets),
    types: {}
  });
  if (!isInt(cfg.totalMarks, 5, 200)) errors.push('Total marks must be a whole number from 5 to 200.');
  if (!isInt(cfg.durationMinutes, 10, 240)) errors.push('Duration must be 10 to 240 minutes.');
  if (!isInt(cfg.sets, 1, MAX_SETS)) errors.push('Paper sets must be 1 to ' + MAX_SETS + '.');
  let sum = 0;
  for (const t of TYPES) {
    const src = r.types && r.types[t];
    if (!src) continue;
    const count = Number(src.count);
    const marks = Number(src.marks);
    if (!isInt(count, 0, 50)) { errors.push(TYPE_LABEL[t] + ': count must be 0 to 50.'); continue; }
    if (count === 0) continue;
    if (!isInt(marks, 1, 10)) { errors.push(TYPE_LABEL[t] + ': marks per question must be 1 to 10.'); continue; }
    cfg.types[t] = { count, marks };
    sum += count * marks;
  }
  if (!Object.keys(cfg.types).length) errors.push('Choose at least one question type.');
  else if (!errors.length && sum !== cfg.totalMarks) errors.push('Marks do not add up: questions give ' + sum + ' marks, but total is ' + cfg.totalMarks + '.');
  return { cfg, errors };
}

// A paper section list in the order the teacher expects.
export function activeTypes(cfg) { return TYPES.filter((t) => cfg.types[t]); }

// Checks one model paper against the config. Returns error strings (empty when valid).
export function validatePaper(parsed, cfg) {
  const errors = [];
  const want = activeTypes(cfg);
  const sections = parsed && Array.isArray(parsed.sections) ? parsed.sections : null;
  if (!sections || sections.length !== want.length) return ['Section count is wrong.'];
  const seen = new Set();
  sections.forEach((sec, si) => {
    const t = want[si];
    const qs = sec && Array.isArray(sec.questions) ? sec.questions : [];
    if (sec.type !== t) errors.push('Section ' + (si + 1) + ' should be ' + t + '.');
    if (qs.length !== cfg.types[t].count) errors.push(TYPE_LABEL[t] + ': expected ' + cfg.types[t].count + ' questions, got ' + qs.length + '.');
    qs.forEach((q) => {
      const text = norm(q && q.question);
      if (!text) errors.push('A question is empty.');
      if (text && seen.has(text)) errors.push('Duplicate question in paper.');
      seen.add(text);
      if (t === 'mcq') {
        const opts = Array.isArray(q.options) ? q.options.map((o) => str(o, 300)) : [];
        if (opts.length !== 4 || opts.some((o) => !o) || new Set(opts.map(norm)).size !== 4) errors.push('MCQ needs exactly 4 distinct options.');
        if (!isInt(q.answerIndex, 0, 3)) errors.push('MCQ answerIndex must be 0 to 3.');
      } else {
        if (!str(q.answer, 600)) errors.push('Question is missing its answer.');
        const steps = Array.isArray(q.marking) ? q.marking : [];
        if (!steps.length || steps.some((s) => !s || !str(s.step, 300) || !isInt(Number(s.marks), 1, 10))) {
          errors.push('Marking steps are missing or invalid.');
        } else if (steps.reduce((a, s) => a + Number(s.marks), 0) !== cfg.types[t].marks) {
          errors.push('Marking steps do not add up to ' + cfg.types[t].marks + ' marks.');
        }
      }
    });
  });
  return errors;
}

// Fixed marks come from the config, never from the model. Options are shuffled so the answer is not always A.
// rng is injectable for tests. Returns the student paper (no answers) and the separate answer key.
export function buildSet(parsed, cfg, name, rng = Math.random) {
  const paper = { set: name, class: cfg.class, board: cfg.board, subject: cfg.subject, totalMarks: cfg.totalMarks, durationMinutes: cfg.durationMinutes, sections: [] };
  const key = { set: name, items: [] };
  let no = 0;
  activeTypes(cfg).forEach((t, si) => {
    const sec = { type: t, label: TYPE_LABEL[t], marks: cfg.types[t].marks, questions: [] };
    parsed.sections[si].questions.forEach((q) => {
      no += 1;
      const marks = cfg.types[t].marks;
      if (t === 'mcq') {
        const opts = q.options.map((o) => str(o, 300));
        const order = opts.map((_, i) => i);
        for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
        const shuffled = order.map((i) => opts[i]);
        const answerPos = order.indexOf(q.answerIndex);
        sec.questions.push({ no, marks, question: str(q.question, 800), options: shuffled });
        key.items.push({ no, type: t, marks, answer: shuffled[answerPos], answerLetter: 'ABCD'[answerPos], explanation: str(q.explanation, 600) });
      } else {
        sec.questions.push({ no, marks, question: str(q.question, 800) });
        key.items.push({ no, type: t, marks, answer: str(q.answer, 600), marking: q.marking.map((s) => ({ step: str(s.step, 300), marks: Number(s.marks) })) });
      }
    });
    paper.sections.push(sec);
  });
  return { paper, answerKey: key };
}

// MCQ generator: validates options, removes duplicates (within the batch and against avoid list), shuffles options.
export function cleanMcqs(items, count, avoid = [], rng = Math.random) {
  const seen = new Set(avoid.map(norm));
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const question = str(it && it.question, 500);
    const opts = Array.isArray(it && it.options) ? it.options.map((o) => str(o, 200)) : [];
    if (!question || opts.length !== 4 || opts.some((o) => !o) || new Set(opts.map(norm)).size !== 4) continue;
    if (!isInt(it.answerIndex, 0, 3)) continue;
    const key = norm(question);
    if (seen.has(key)) continue;
    seen.add(key);
    const order = [0, 1, 2, 3];
    for (let i = 3; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const pos = order.indexOf(it.answerIndex);
    out.push({ no: out.length + 1, question, options: order.map((i) => opts[i]), answerLetter: 'ABCD'[pos], answer: opts[it.answerIndex], explanation: str(it.explanation, 400) });
    if (out.length === count) break;
  }
  return out;
}

export function extractJson(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

// ---------- model call ----------
async function callModel(groqKey, system, user, maxTokens) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: TEACHER_MODEL, temperature: 0.4, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: ctrl.signal
    });
    if (!r.ok) throw new Error('model HTTP ' + r.status);
    const d = await r.json();
    return String((d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '');
  } finally { clearTimeout(timer); }
}

function paperPrompt(cfg, name, avoid) {
  const specs = activeTypes(cfg).map((t) => '- ' + TYPE_LABEL[t] + ': exactly ' + cfg.types[t].count + ' questions, ' + cfg.types[t].marks + ' mark(s) each.').join('\n');
  return {
    system: 'You write school exam questions for Indian students. Language: ' + LANGS[cfg.language] + '. '
      + 'Class ' + cfg.class + ', board ' + cfg.board + ', subject ' + cfg.subject + '. Use ONLY these chapters: ' + cfg.chapters.join('; ') + '. '
      + 'Difficulty: ' + cfg.difficulty + (cfg.difficulty === 'mixed' ? ' (mix easy, medium and hard)' : '') + '. This is paper set ' + name + '; make its questions different from other sets.\n'
      + 'Sections, in this exact order:\n' + specs + '\n'
      + 'Return ONLY JSON: {"sections":[{"type":"mcq"|"short"|"long"|"numerical","questions":[...]}]}. '
      + 'MCQ question: {"question","options":[4 distinct strings],"answerIndex":0-3,"explanation"}. '
      + 'Other questions: {"question","answer","marking":[{"step","marks"}]} where the step marks add up to the marks per question. '
      + 'Every answer must be correct. Do not repeat these questions: ' + JSON.stringify(avoid.slice(0, 40)) + '.',
    user: 'Write the paper now.'
  };
}

function mcqPrompt(cfg, count, avoid) {
  return {
    system: 'You write multiple choice questions for Indian school students. Language: ' + LANGS[cfg.language] + '. Class ' + cfg.class + ', board ' + cfg.board + ', subject ' + cfg.subject + '. '
      + 'Use ONLY these chapters: ' + cfg.chapters.join('; ') + '. Difficulty: ' + cfg.difficulty + '. '
      + 'Return ONLY JSON: {"questions":[{"question","options":[4 distinct strings],"answerIndex":0-3,"explanation"}]} with ' + count + ' questions. Exactly one option is correct. Every answer must be correct. Do not repeat these questions: ' + JSON.stringify(avoid.slice(0, 40)) + '.',
    user: 'Write the questions now.'
  };
}

// Calls the model up to `attempts` times, returning the first parsed result that passes `check`.
async function generateValid(groqKey, prompt, check, attempts = 2) {
  let lastErr = 'no valid output';
  for (let i = 0; i < attempts; i++) {
    let raw = '';
    try { raw = await callModel(groqKey, prompt.system, prompt.user, 3500); } catch (e) { lastErr = e.message; continue; }
    const parsed = extractJson(raw);
    if (!parsed) { lastErr = 'not json'; continue; }
    const err = check(parsed);
    if (!err || (Array.isArray(err) && !err.length)) return parsed;
    lastErr = Array.isArray(err) ? err[0] : err;
  }
  throw Object.assign(new Error(lastErr), { code: 'generation' });
}

// ---------- credits and limits (same keys as chat) ----------
const rateBuckets = new Map();
export function rateLimited(ip, limit = 12, windowMs = 60000) {
  const now = Date.now();
  const e = rateBuckets.get(ip);
  if (!e || now - e.start > windowMs) { rateBuckets.set(ip, { start: now, count: 1 }); return false; }
  e.count += 1;
  return e.count > limit;
}
export function __resetRateLimits() { rateBuckets.clear(); }

async function redisCmd(cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Credits store is not configured');
  const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d || d.error) throw new Error('Credits store error');
  return d.result;
}
async function spendCredits(key, cost) {
  await redisCmd(['SETNX', key, String(FREE_CREDITS)]);
  const left = Number(await redisCmd(['DECRBY', key, String(cost)]));
  if (left < 0) { await redisCmd(['INCRBY', key, String(cost)]); return null; }
  return left;
}
async function refundCredits(key, cost) { try { await redisCmd(['INCRBY', key, String(cost)]); } catch (e) { console.error('Teacher refund failed', e && e.message); } }
function emailOf(body) {
  const e = body && body.user && typeof body.user.email === 'string' ? body.user.email.trim().toLowerCase() : '';
  return e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}
function clientIp(req) {
  const f = req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
  return f ? String(f).split(',')[0].trim() : ((req.socket && req.socket.remoteAddress) || 'unknown');
}

// ---------- handler ----------
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; } catch (e) { return res.status(400).json({ error: 'Invalid request body.' }); }
  const email = emailOf(body);
  if (!email) return res.status(401).json({ error: 'Sign in to use Teacher Mode.' });
  if (rateLimited(clientIp(req))) return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return res.status(503).json({ error: 'Teacher Mode is not available right now.' });

  const action = body.action;
  if (action !== 'paper' && action !== 'mcq') return res.status(400).json({ error: 'action must be "paper" or "mcq".' });

  let cost;
  let result;
  let normalized;
  if (action === 'paper') {
    normalized = normalizeConfig(body.config);
    if (normalized.errors.length) return res.status(400).json({ error: normalized.errors.join(' ') });
    cost = SIGNED_IN_COST_PER_CALL * normalized.cfg.sets;
  } else {
    const b = normalizeBase(body.config);
    const count = Number(body.count);
    const errs = b.errors.slice();
    if (!isInt(count, 1, 30)) errs.push('MCQ count must be 1 to 30.');
    if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    normalized = { cfg: b.cfg, count, avoid: Array.isArray(body.avoid) ? body.avoid.map((x) => str(x, 500)).filter(Boolean).slice(0, 200) : [] };
    cost = SIGNED_IN_COST_PER_CALL;
  }

  const creditKey = 'credits:' + email;
  let left;
  try { left = await spendCredits(creditKey, cost); } catch (e) { console.error('Teacher credits error:', e && e.message); return res.status(503).json({ error: 'Credits are not available right now.' }); }
  if (left === null) return res.status(402).json({ error: 'Not enough credits for this request.' });

  try {
    if (action === 'paper') {
      const sets = [];
      const usedTexts = [];
      for (let i = 0; i < normalized.cfg.sets; i++) {
        const name = String.fromCharCode(65 + i);
        const prompt = paperPrompt(normalized.cfg, name, usedTexts);
        const parsed = await generateValid(groqKey, prompt, (p) => validatePaper(p, normalized.cfg));
        const built = buildSet(parsed, normalized.cfg, name);
        built.paper.sections.forEach((s) => s.questions.forEach((q) => usedTexts.push(q.question)));
        sets.push({ name, paper: built.paper, answerKey: built.answerKey });
      }
      result = { sets };
    } else {
      const want = normalized.count;
      const prompt = mcqPrompt(normalized.cfg, want + 3, normalized.avoid);
      const parsed = await generateValid(groqKey, prompt, (p) => {
        const got = cleanMcqs(p && p.questions, want, normalized.avoid);
        return got.length >= want ? [] : ['Not enough unique valid MCQs.'];
      });
      const items = cleanMcqs(parsed.questions, want, normalized.avoid);
      result = { questions: items.map((q) => ({ no: q.no, question: q.question, options: q.options })), answerKey: items.map((q) => ({ no: q.no, answerLetter: q.answerLetter, answer: q.answer, explanation: q.explanation })) };
    }
  } catch (e) {
    await refundCredits(creditKey, cost);
    console.error('Teacher generation failed', e && e.message);
    return res.status(502).json({ error: 'Could not generate a valid result. Please try again, or check the chapters you entered.' });
  }
  return res.status(200).json(Object.assign({ ok: true, action, syllabusVerified: false, credits: left }, result));
}
