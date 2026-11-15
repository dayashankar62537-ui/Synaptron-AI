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
// Models write far more reliably in small batches. Each call asks for at most BATCH questions, batches run in
// parallel and any shortfall is topped up. A request can ask for up to MAX_QUESTIONS.
const BATCH = 10;
const MAX_QUESTIONS = 50;

// ---------- helpers ----------
export function norm(text) { return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
// Models often write maths as LaTeX. Turn it into plain Unicode so the paper prints cleanly.
const TEX_SYMBOLS = [
  ['\\\\text\\{([^{}]*)\\}', '$1'], ['\\\\mathrm\\{([^{}]*)\\}', '$1'], ['\\\\mathbf\\{([^{}]*)\\}', '$1'],
  ['\\\\frac\\{([^{}]*)\\}\\{([^{}]*)\\}', '($1)/($2)'], ['\\\\sqrt\\{([^{}]*)\\}', '√($1)'],
  ['\\\\(?:mid|vert)\\b', '|'], ['\\\\cup\\b', '∪'], ['\\\\cap\\b', '∩'], ['\\\\subseteq\\b', '⊆'], ['\\\\subset\\b', '⊂'],
  ['\\\\supseteq\\b', '⊇'], ['\\\\supset\\b', '⊃'], ['\\\\notin\\b', '∉'], ['\\\\in\\b', '∈'], ['\\\\times\\b', '×'],
  ['\\\\setminus\\b', '∖'], ['\\\\emptyset\\b', '∅'], ['\\\\varnothing\\b', '∅'], ['\\\\cdot\\b', '·'],
  ['\\\\(?:leq|le)\\b', '≤'], ['\\\\(?:geq|ge)\\b', '≥'], ['\\\\neq\\b', '≠'], ['\\\\infty\\b', '∞'], ['\\\\pi\\b', 'π'],
  ['\\\\Rightarrow\\b', '⇒'], ['\\\\Leftrightarrow\\b', '⇔'], ['\\\\to\\b', '→'], ['\\\\forall\\b', '∀'], ['\\\\exists\\b', '∃'],
  ['\\\\lor\\b', '∨'], ['\\\\land\\b', '∧'], ['\\\\neg\\b', '¬'], ['\\\\circ\\b', '∘'], ['\\\\deg\\b', '°'],
  ['\\^\\{2\\}', '²'], ['\\^\\{3\\}', '³'], ['\\^2\\b', '²'], ['\\^3\\b', '³'], ['\\^\\{c\\}', 'ᶜ'], ['\\^c\\b', 'ᶜ'],
  ['\\\\\\{', '{'], ['\\\\\\}', '}'], ['\\\\[{}]', ''], ['\\\\[,;!: ]', ' '], ['\\\\[()\\[\\]]', ''], ['\\\\\\$', '$']
];
export function texToPlain(v) {
  let out = String(v);
  if (!/[\\\\$^_]/.test(out)) return out;
  TEX_SYMBOLS.forEach(([pat, rep]) => { out = out.replace(new RegExp(pat.endsWith('\\b') ? pat + '\\s*' : pat, 'g'), rep); });
  out = out.replace(/\\\\([A-Za-z]+)/g, '$1').replace(/\$/g, '').replace(/\^\{([^{}]*)\}/g, '^$1').replace(/_\{([^{}]*)\}/g, '_$1');
  return out.replace(/[ \t]+/g, ' ').trim();
}
const str = (v, max) => (typeof v === 'string' ? texToPlain(v).trim().slice(0, max) : '');

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
  // Optional difficulty split for mixed papers, e.g. { easy: 30, medium: 50, hard: 20 }.
  const mixIn = r.difficultyMix && typeof r.difficultyMix === 'object' ? r.difficultyMix : null;
  cfg.difficultyMix = null;
  if (mixIn) {
    const mix = { easy: Number(mixIn.easy), medium: Number(mixIn.medium), hard: Number(mixIn.hard) };
    const valid = [mix.easy, mix.medium, mix.hard].every((x) => Number.isInteger(x) && x >= 0 && x <= 100);
    if (!valid || mix.easy + mix.medium + mix.hard !== 100) errors.push('Difficulty split must be whole numbers that add up to 100.');
    else cfg.difficultyMix = mix;
  }
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
  const total = Object.values(cfg.types).reduce((a, t) => a + t.count, 0);
  if (total > MAX_QUESTIONS) errors.push('A paper can have at most ' + MAX_QUESTIONS + ' questions in total.');
  if (!Object.keys(cfg.types).length) errors.push('Choose at least one question type.');
  else if (!errors.length && sum !== cfg.totalMarks) errors.push('Marks do not add up: questions give ' + sum + ' marks, but total is ' + cfg.totalMarks + '.');
  return { cfg, errors };
}

// A paper section list in the order the teacher expects.
export function activeTypes(cfg) { return TYPES.filter((t) => cfg.types[t]); }

// Checks one model paper against the config. Returns error strings (empty when valid).
// The model often gets the marking-scheme steps slightly wrong. Marks per question come from the config,
// so fix the steps to add up to them (scale, then put any rounding difference on the last step).
export function repairMarking(parsed, cfg) {
  const secs = parsed && Array.isArray(parsed.sections) ? parsed.sections : [];
  secs.forEach((sec) => {
    const t = sec && sec.type;
    if (!cfg.types[t] || !Array.isArray(sec.questions)) return;
    const want = cfg.types[t].marks;
    sec.questions.forEach((q) => {
      const steps = Array.isArray(q && q.marking) ? q.marking.filter((s) => s && typeof s === 'object') : [];
      if (!steps.length) return;
      const have = steps.reduce((a, s) => a + (Number(s.marks) || 0), 0);
      if (have === want && steps.every((s) => Number.isInteger(Number(s.marks)) && Number(s.marks) >= 1)) return;
      steps.forEach((s) => { s.marks = Math.max(1, Math.round(((Number(s.marks) || 0) * want) / (have || 1))); });
      let diff = want - steps.reduce((a, s) => a + s.marks, 0);
      const last = steps[steps.length - 1];
      last.marks = Math.max(1, last.marks + diff);
      q.marking = steps;
    });
  });
  return parsed;
}

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

// Models sometimes number options from 1, write a letter, or only give the answer text. Accept each of these.
export function resolveAnswerIndex(q, opts) {
  const text = q && typeof q.answer === 'string' ? norm(q.answer) : '';
  if (text) { const i = opts.findIndex((o) => norm(o) === text); if (i >= 0) return i; }
  const v = q ? q.answerIndex : undefined;
  if (isInt(v, 0, 3)) return v;
  if (isInt(v, 1, 4)) return v - 1;
  if (typeof v === 'string' && /^\s*[A-Da-d]\s*$/.test(v)) return 'ABCD'.indexOf(v.trim().toUpperCase());
  if (typeof v === 'string' && /^\s*[1-4]\s*$/.test(v)) return Number(v) - 1;
  return -1;
}

// MCQ generator: validates options, removes duplicates (within the batch and against avoid list), shuffles options.
export function cleanMcqs(items, count, avoid = [], rng = Math.random) {
  const seen = new Set(avoid.map(norm));
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const question = str(it && it.question, 500);
    const opts = Array.isArray(it && it.options) ? it.options.map((o) => str(o, 200)) : [];
    if (!question || opts.length !== 4 || opts.some((o) => !o) || new Set(opts.map(norm)).size !== 4) continue;
    const ai = resolveAnswerIndex(it, opts);
    if (ai < 0) continue;
    const key = norm(question);
    if (seen.has(key)) continue;
    seen.add(key);
    const order = [0, 1, 2, 3];
    for (let i = 3; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const pos = order.indexOf(ai);
    out.push({ no: out.length + 1, question, options: order.map((i) => opts[i]), answerLetter: 'ABCD'[pos], answer: opts[ai], explanation: str(it.explanation, 400) });
    if (out.length === count) break;
  }
  return out;
}

export function extractJson(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { /* try repair below */ }
  // Maths text often has LaTeX backslashes (\frac, \cup) that break JSON. Escape the invalid ones and retry.
  try { return JSON.parse(m[0].replace(/\\(?!["\\\/bfnrtu])/g, '\\\\')); } catch (e) { return null; }
}

// ---------- model call ----------
async function callModel(groqKey, system, user, maxTokens) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ model: TEACHER_MODEL, temperature: 0.4, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }, TEACHER_MODEL.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : {})),
      signal: ctrl.signal
    });
    if (!r.ok) throw new Error('model HTTP ' + r.status);
    const d = await r.json();
    return String((d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '');
  } finally { clearTimeout(timer); }
}

function difficultyText(cfg) {
  if (cfg.difficulty !== 'mixed') return cfg.difficulty;
  return cfg.difficultyMix ? 'mixed (about ' + cfg.difficultyMix.easy + '% easy, ' + cfg.difficultyMix.medium + '% medium, ' + cfg.difficultyMix.hard + '% hard)' : 'mixed (easy, medium and hard)';
}

// One model call writes one batch of one question type.
function questionPrompt(cfg, t, n, avoid, setName) {
  const shape = t === 'mcq'
    ? 'Each item: {"question","options":[4 distinct strings],"answer":"the exact text of the correct option","answerIndex":0-3,"explanation"}. Exactly one option is correct.'
    : 'Each item: {"question","answer","marking":[{"step","marks"}]} where the marks of the steps add up to ' + cfg.types[t].marks + '.';
  return {
    system: 'You write school exam questions for Indian students. Language: ' + LANGS[cfg.language] + '. Write maths in plain text or Unicode (for example A ∪ B, x², √2), never LaTeX and never backslashes. Output valid JSON only. '
      + 'Class ' + cfg.class + ', board ' + cfg.board + ', subject ' + cfg.subject + '. Use ONLY these chapters: ' + cfg.chapters.join('; ') + '. '
      + 'Difficulty: ' + difficultyText(cfg) + '. ' + (setName ? 'This is paper set ' + setName + '; make its questions different from other sets. ' : '')
      + 'Write exactly ' + n + ' questions. Question type: ' + TYPE_LABEL[t] + '. Cover different topics from the chapters. Every answer must be correct. '
      + 'Return ONLY JSON: {"questions":[...]} with ' + n + ' items. ' + shape + ' '
      + 'Do not repeat these questions: ' + JSON.stringify(avoid.slice(-60)) + '.',
    user: 'Write the questions now.'
  };
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Asks the model for one batch. Returns raw items (possibly none); the caller validates them.
async function askBatch(groqKey, cfg, t, n, avoid, setName) {
  const p = questionPrompt(cfg, t, n, avoid, setName);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await pause(1500);
    let raw = '';
    try { raw = await callModel(groqKey, p.system, p.user, 8000); } catch (e) { console.error('Teacher model call failed:', e.message); continue; }
    const parsed = extractJson(raw);
    if (parsed && Array.isArray(parsed.questions)) return parsed.questions;
    console.error('Teacher output not usable, length', raw.length, 'start:', String(raw).slice(0, 160));
  }
  return [];
}

// Runs fn over list with at most `limit` calls in flight, so the model provider is not flooded.
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => { while (next < list.length) { const i = next++; out[i] = await fn(list[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

function chunkSizes(n) {
  const out = [];
  for (let left = n; left > 0; left -= BATCH) out.push(Math.min(BATCH, left));
  return out;
}

// Returns a cleaned question for a type, or null when the model's item is unusable.
function cleanItem(t, q, cfg) {
  if (!q || typeof q !== 'object') return null;
  const question = str(q.question, 800);
  if (!question) return null;
  if (t === 'mcq') {
    const opts = Array.isArray(q.options) ? q.options.map((o) => str(o, 300)) : [];
    if (opts.length !== 4 || opts.some((o) => !o) || new Set(opts.map(norm)).size !== 4) return null;
    const ai = resolveAnswerIndex(q, opts);
    if (ai < 0) return null;
    return { question, options: opts, answerIndex: ai, explanation: str(q.explanation, 600) };
  }
  const answer = str(q.answer, 600);
  if (!answer) return null;
  repairMarking({ sections: [{ type: t, questions: [q] }] }, cfg);
  const steps = Array.isArray(q.marking) ? q.marking.filter((s) => s && typeof s === 'object') : [];
  if (!steps.length || steps.some((s) => !str(s.step, 300) || !isInt(Number(s.marks), 1, 10))) return null;
  if (steps.reduce((a, s) => a + Number(s.marks), 0) !== cfg.types[t].marks) return null;
  return { question, answer, marking: steps.map((s) => ({ step: str(s.step, 300), marks: Number(s.marks) })) };
}

// Fills every slot (one per paper set and question type, or one for the MCQ generator) with unique, valid questions.
// Batches run in parallel. A slot that is still short gets up to two top-up calls. Throws when a slot cannot be filled.
async function fillSlots(groqKey, cfg, slots, avoid) {
  const keys = new Set(avoid.map(norm));
  const usedText = avoid.slice();
  const accept = (slot, raws) => {
    for (const r of Array.isArray(raws) ? raws : []) {
      if (slot.items.length >= slot.need) break;
      const q = cleanItem(slot.type, r, cfg);
      if (!q) continue;
      const k = norm(q.question);
      if (keys.has(k)) continue;
      keys.add(k); usedText.push(q.question); slot.items.push(q);
    }
  };
  const jobs = [];
  slots.forEach((slot) => chunkSizes(slot.need).forEach((size) => jobs.push({ slot, size })));
  const first = await mapLimit(jobs, 4, (job) => askBatch(groqKey, cfg, job.slot.type, job.size + 2, [], job.slot.set));
  jobs.forEach((job, i) => accept(job.slot, first[i]));
  for (let round = 0; round < 2; round++) {
    const short = slots.filter((s) => s.items.length < s.need);
    if (!short.length) break;
    const extra = await mapLimit(short, 4, (slot) => askBatch(groqKey, cfg, slot.type, Math.min(BATCH, slot.need - slot.items.length + 2), usedText, slot.set));
    short.forEach((slot, i) => accept(slot, extra[i]));
  }
  slots.forEach((slot) => {
    if (slot.items.length < slot.need) {
      const where = slot.set ? ' for set ' + slot.set : '';
      throw Object.assign(new Error('Only ' + slot.items.length + ' of ' + slot.need + ' unique, valid ' + TYPE_LABEL[slot.type].toLowerCase() + where + ' could be made. Please try again, or check the chapters you entered.'), { code: 'generation' });
    }
    slot.items = slot.items.slice(0, slot.need);
  });
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

// Env values pasted into Vercel often carry spaces, newlines or quotes; strip them so the URL parses.
function cleanEnv(v) { return String(v || '').trim().replace(/^["']+|["']+$/g, '').trim(); }
// Credits store. Uses Upstash when it is configured and reachable. Otherwise it falls back to
// in-memory counters (free, no setup). Limits then apply per server instance and reset on restart.
const kvMemory = new Map();
function kvLocal(cmd) {
  const op = String(cmd[0]).toUpperCase(), key = cmd[1], a = cmd[2], b = cmd[3], c = cmd[4];
  const now = Date.now();
  const cur = kvMemory.get(key);
  const live = cur && (!cur.exp || cur.exp > now) ? cur : null;
  if (cur && !live) kvMemory.delete(key);
  switch (op) {
    case 'GET': return live ? live.v : null;
    case 'SET': {
      const exp = b && String(b).toUpperCase() === 'EX' ? now + Number(c) * 1000 : null;
      kvMemory.set(key, { v: String(a), exp });
      return 'OK';
    }
    case 'DEL': return kvMemory.delete(key) ? 1 : 0;
    case 'SETNX':
      if (live) return 0;
      kvMemory.set(key, { v: String(a), exp: null });
      return 1;
    case 'INCRBY':
    case 'DECRBY': {
      const n = Number(live ? live.v : 0) + (op === 'INCRBY' ? 1 : -1) * Number(a);
      kvMemory.set(key, { v: String(n), exp: live ? live.exp : null });
      return n;
    }
    default: throw new Error('Unsupported command ' + op);
  }
}
async function redisCmd(cmd) {
  const url = cleanEnv(process.env.UPSTASH_REDIS_REST_URL);
  const token = cleanEnv(process.env.UPSTASH_REDIS_REST_TOKEN);
  if (!url || !token) return kvLocal(cmd);
  try {
    const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || d.error) throw new Error('Credits store error: ' + (d && d.error ? String(d.error).slice(0, 160) : 'HTTP ' + r.status));
    return d.result;
  } catch (e) {
    console.error('Credits store unavailable, using in-memory counters:', e && e.message);
    return kvLocal(cmd);
  }
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
    if (!isInt(count, 1, MAX_QUESTIONS)) errs.push('MCQ count must be 1 to ' + MAX_QUESTIONS + '.');
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
      const cfg = normalized.cfg;
      const names = Array.from({ length: cfg.sets }, (_, i) => String.fromCharCode(65 + i));
      const slots = [];
      names.forEach((name) => activeTypes(cfg).forEach((t) => slots.push({ set: name, type: t, need: cfg.types[t].count, items: [] })));
      await fillSlots(groqKey, cfg, slots, []);
      const sets = names.map((name) => {
        const parsed = { sections: activeTypes(cfg).map((t) => ({ type: t, questions: slots.find((s) => s.set === name && s.type === t).items })) };
        const errs = validatePaper(parsed, cfg);
        if (errs.length) throw Object.assign(new Error('Could not build a valid paper: ' + errs[0]), { code: 'generation' });
        const built = buildSet(parsed, cfg, name);
        return { name, paper: built.paper, answerKey: built.answerKey };
      });
      result = { sets };
    } else {
      const want = normalized.count;
      const slot = { set: null, type: 'mcq', need: want, items: [] };
      await fillSlots(groqKey, normalized.cfg, [slot], normalized.avoid);
      const items = cleanMcqs(slot.items, want, []);
      result = { requested: want, questions: items.map((q) => ({ no: q.no, question: q.question, options: q.options })), answerKey: items.map((q) => ({ no: q.no, answerLetter: q.answerLetter, answer: q.answer, explanation: q.explanation })) };
    }
  } catch (e) {
    await refundCredits(creditKey, cost);
    console.error('Teacher generation failed', e && e.message);
    const msg = e && e.code === 'generation' ? e.message : 'Could not generate a valid result. Please try again, or check the chapters you entered.';
    return res.status(502).json({ error: msg });
  }
  return res.status(200).json(Object.assign({ ok: true, action, syllabusVerified: false, credits: left }, result));
}
