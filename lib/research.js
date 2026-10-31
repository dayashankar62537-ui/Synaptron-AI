// Aviqo research intelligence: source classification, dates, claim context, claim checks,
// contradictions, self-audit and URL checks. Deterministic rules only. No model calls, no API keys.
import { percentChange, percentOf, CalcError } from './calc.js';

export const SOURCE_TYPE_LABELS = {
  government_primary: 'Government primary source',
  official_technical: 'Official technical report',
  scientific_paper: 'Scientific paper',
  independent_research: 'Independent research organisation',
  news: 'News source',
  commercial: 'Commercial source',
  secondary: 'Secondary source'
};
const PRIMARY_TYPES = new Set(['government_primary', 'official_technical', 'scientific_paper']);

const GOV_DOMAIN = /(^|\.)(gov|gov\.[a-z]{2}|nic\.in|who\.int|un\.org|imf\.org|worldbank\.org|oecd\.org|europa\.eu|census\.gov|bls\.gov|eia\.gov)$/i;
const SCI_DOMAIN = /(^|\.)(arxiv\.org|nature\.com|science\.org|ieee\.org|ieeexplore\.ieee\.org|sciencedirect\.com|springer\.com|link\.springer\.com|pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov|jstor\.org|acm\.org|plos\.org|pnas\.org|biorxiv\.org|medrxiv\.org|doi\.org|scholar\.google\.com|cell\.com|thelancet\.com|bmj\.com|wiley\.com|tandfonline\.com)$/i;
const INDEP_DOMAIN = /(^|\.)(pewresearch\.org|brookings\.edu|rand\.org|cfr\.org|chathamhouse\.org|iea\.org|ourworldindata\.org|gallup\.com|wri\.org|carbonbrief\.org|epi\.org)$/i;
const COMMERCIAL_DOMAIN = /(^|\.)(mckinsey\.com|gartner\.com|forrester\.com|statista\.com|deloitte\.com|pwc\.com|ey\.com|kpmg\.com|bcg\.com|hubspot\.com|salesforce\.com)$/i;
const NEWS_DOMAIN = /(^|\.)(reuters\.com|apnews\.com|bbc\.co\.uk|bbc\.com|bloomberg\.com|ft\.com|wsj\.com|theguardian\.com|nytimes\.com|thehindu\.com|ndtv\.com|indianexpress\.com|timesofindia\.indiatimes\.com|hindustantimes\.com|economictimes\.indiatimes\.com|livemint\.com|cnbc\.com|techcrunch\.com|theverge\.com|wired\.com|arstechnica\.com|espncricinfo\.com|espn\.com|forbes\.com|cnn\.com|aljazeera\.com)$/i;
const SECONDARY_DOMAIN = /(^|\.)(wikipedia\.org|britannica\.com|medium\.com|blogspot\.com|wordpress\.com|quora\.com|reddit\.com|substack\.com|tumblr\.com|youtube\.com|fandom\.com)$/i;

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
}
function pathOf(url) {
  try { return new URL(url).pathname.toLowerCase(); } catch (e) { return ''; }
}

// Classifies a source from its domain, path, title and text. Unknown sites are "secondary".
export function classifySource(source) {
  const domain = String(source.domain || hostOf(source.url)).toLowerCase();
  const path = pathOf(source.url);
  const title = String(source.title || '');
  const text = String(source.content || '');
  let type = 'secondary';
  if (GOV_DOMAIN.test(domain)) type = 'government_primary';
  else if (SCI_DOMAIN.test(domain)) type = 'scientific_paper';
  else if (INDEP_DOMAIN.test(domain)) type = 'independent_research';
  else if (COMMERCIAL_DOMAIN.test(domain)) type = 'commercial';
  else if (NEWS_DOMAIN.test(domain) || /\/news\//.test(path)) type = 'news';
  else if (SECONDARY_DOMAIN.test(domain)) type = 'secondary';
  else if (/technical report|white ?paper|specification|datasheet|documentation|api reference/i.test(title + ' ' + path) || /^(docs|developer|developers|learn)\./.test(domain)) type = 'official_technical';
  else if (/\/(pricing|products?|buy|shop|solutions)(\/|$)/.test(path) || /\b(our products?|request a demo|free trial|buy now)\b/i.test(text)) type = 'commercial';
  else if (/\.(org|edu)$/.test(domain) && /\b(report|study|survey|dataset|methodology)\b/i.test(title + ' ' + text)) type = 'independent_research';
  return { type, label: SOURCE_TYPE_LABELS[type], primary: PRIMARY_TYPES.has(type) };
}

// Dates without a time zone are read as UTC, so "12 March 2026" stays 12 March everywhere.
function isoDate(str) {
  const clean = String(str || '').trim().replace(/(\d+)(st|nd|rd|th)/, '$1');
  if (!clean) return null;
  const t = /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(clean) || /(Z|[+-]\d{2}:?\d{2}|UTC|GMT)$/i.test(clean) ? Date.parse(clean) : Date.parse(clean + ' UTC');
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

// Pulls the dates, period, author and publisher a page states. Missing values stay null.
export function extractSourceMeta(source) {
  const full = (String(source.content || '') + ' ' + String(source.raw || '').slice(0, 4000)).replace(/\s+/g, ' ');
  const upd = full.match(/\b(?:last (?:updated|modified|reviewed)|updated on|revised on|modified on)\s*[:\-]?\s*((?:\d{1,2}\s+)?[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|\d{4}-\d{2}-\d{2})/i);
  // The update date is removed first, so it is not mistaken for the measurement period.
  const text = upd ? full.replace(upd[0], ' ') : full;
  const period = text.match(/\b(FY\s?\d{2,4}(?:[-–\/]\d{2,4})?|Q[1-4]\s?(?:19|20)\d{2}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:19|20)\d{2}|(?:19|20)\d{2}\s*[-–]\s*(?:19|20)?\d{2}|(?:for|during|through|as of)\s+(?:the\s+(?:year|period)\s+)?(?:19|20)\d{2})\b/i);
  const author = text.match(/\b(?:[Aa]uthors?:|[Ww]ritten by|[Bb]y)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,2})\b/);
  return {
    publishedDate: isoDate(source.published),
    updatedDate: upd ? isoDate(upd[1]) : null,
    dataPeriod: period ? period[1].trim() : null,
    author: author ? author[1] : null,
    publisher: source.domain || hostOf(source.url) || null
  };
}

// Claim context: each claim is one of seven kinds. Projections are never treated as measurements.
export function classifyClaimContext(sentence, now = new Date()) {
  const s = String(sentence || '');
  const nowYear = now.getUTCFullYear();
  const years = (s.match(/\b(19|20)\d{2}\b/g) || []).map(Number);
  const maxYear = years.length ? Math.max(...years) : null;
  if (/\b(target|targets|goal|goals|aims? to|aim to|commit(?:s|ted)? to|pledg\w*|net[- ]zero by)\b/i.test(s)) return 'policy_target';
  if (/\b(i think|i believe|we believe|in my view|in my opinion|opinion|should|better than|worse than|best|worst|recommend\w*)\b/i.test(s)) return 'opinion';
  if (/\b(projected|projection|forecast\w*|predict\w*|expected to|is expected|outlook|scenario|could reach|will reach|will grow|will be|will have)\b/i.test(s) || (maxYear && maxYear > nowYear)) return 'projection';
  if (/\b(estimated?|approximately|roughly|about|around|circa|at least|ranges? from|between)\b/i.test(s)) return 'estimate';
  if (/\b(currently|as of|right now|today|now|latest|this year|this month|this week)\b/i.test(s) || maxYear === nowYear) return 'current';
  if ((maxYear && maxYear < nowYear) || /\b(was|were|had|historically|in the past|since)\b/i.test(s)) return 'historical';
  return 'unverified';
}

export const CONTEXT_LABELS = {
  historical: 'Historical fact',
  current: 'Current measurement',
  projection: 'Projection',
  estimate: 'Estimate',
  policy_target: 'Policy target',
  opinion: 'Opinion',
  unverified: 'Unverified claim'
};

const STOP = new Set(['about', 'after', 'again', 'also', 'because', 'been', 'before', 'being', 'between', 'could', 'during', 'each', 'from', 'have', 'into', 'more', 'most', 'only', 'other', 'over', 'same', 'some', 'such', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'very', 'were', 'what', 'when', 'where', 'which', 'while', 'will', 'with', 'would', 'your', 'said', 'says', 'according', 'report', 'source', 'data', 'shows', 'show', 'percent']);

function keywordsOf(text) {
  const words = String(text || '').toLowerCase().replace(/\[\d{1,2}\]/g, ' ').match(/[a-z]{4,}/g) || [];
  return Array.from(new Set(words.map((w) => w.replace(/s$/, '')).filter((w) => !STOP.has(w))));
}

function numbersIn(text) {
  const clean = String(text || '').replace(/(\d),(?=\d{3}\b)/g, '$1');
  return Array.from(new Set(clean.match(/\d+(?:\.\d+)?/g) || []));
}

const SCALE = { thousand: 1e3, lakh: 1e5, million: 1e6, crore: 1e7, billion: 1e9, trillion: 1e12 };

// Same number, different scale (5 million vs 5 billion) is a unit mismatch.
function scaleMismatch(claim, passage) {
  const scaleRe = /(\d+(?:\.\d+)?)\s*(thousand|lakh|million|crore|billion|trillion)\b/gi;
  const claimScales = [...String(claim).matchAll(scaleRe)];
  for (const m of claimScales) {
    const sameNumber = new RegExp('\\b' + m[1].replace('.', '\\.') + '\\s*(thousand|lakh|million|crore|billion|trillion)\\b', 'gi');
    for (const pm of String(passage).matchAll(sameNumber)) {
      if (pm[1].toLowerCase() !== m[2].toLowerCase()) return { claimed: m[2].toLowerCase(), found: pm[1].toLowerCase(), number: m[1] };
    }
  }
  return null;
}

// Values only: calendar years are removed, so two sources that both mention 2025 are not treated as agreeing.
function valueNumbers(text) {
  return numbersIn(text).filter((n) => !/^(19|20)\d{2}$/.test(n));
}

export function sentencesOf(text) {
  return String(text || '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length >= 30).slice(0, 300);
}

// Finds the passage in a source that best matches a claim.
export function bestPassage(claim, sourceText) {
  const kw = keywordsOf(claim);
  let best = { passage: '', overlap: 0, hits: 0 };
  if (!kw.length) return best;
  for (const sent of sentencesOf(sourceText)) {
    const low = sent.toLowerCase();
    const hits = kw.filter((k) => low.includes(k)).length;
    const overlap = hits / kw.length;
    if (overlap > best.overlap || (overlap === best.overlap && overlap > 0 && numbersIn(sent).length > numbersIn(best.passage).length)) {
      best = { passage: sent, overlap, hits };
    }
  }
  return best;
}

// Checks one claim against one cited source. Returns supported | partial | unit_mismatch | unsupported.
export function checkClaimAgainstSource(claim, source) {
  const sourceText = String(source.content || '') + ' ' + String(source.raw || '');
  const pass = bestPassage(claim, sourceText);
  const claimNums = numbersIn(claim);
  const passNums = numbersIn(pass.passage);
  const numsFound = claimNums.filter((n) => passNums.includes(n));
  const numsOk = claimNums.length === 0 || numsFound.length === claimNums.length;
  const mismatch = scaleMismatch(claim, pass.passage);
  let level = 'unsupported';
  if (mismatch) level = 'unit_mismatch';
  else if (pass.overlap >= 0.6 && numsOk) level = 'supported';
  else if (pass.overlap >= 0.34 || numsFound.length > 0) level = 'partial';
  return { sourceId: source.id, url: source.url, level, passage: pass.passage, overlap: Math.round(pass.overlap * 100) / 100, numbersMissing: claimNums.filter((n) => !passNums.includes(n)), unit: mismatch };
}

function shingles(text, k = 8) {
  const words = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  const set = new Set();
  for (let i = 0; i + k <= words.length; i++) set.add(words.slice(i, i + k).join(' '));
  return set;
}

// Sources that repeat the same text come from one original origin, so they count once.
export function originGroups(sources) {
  const parent = sources.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const sets = sources.map((s) => shingles(String(s.content || '') + ' ' + String(s.raw || '').slice(0, 3000)));
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      if (!sets[i].size || !sets[j].size) continue;
      let inter = 0;
      for (const x of sets[i]) if (sets[j].has(x)) inter++;
      if (inter / Math.min(sets[i].size, sets[j].size) >= 0.5) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  sources.forEach((s, i) => {
    const g = find(i);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s.id);
  });
  return Array.from(groups.values());
}

const COUNTRY_WORDS = ['india', 'china', 'usa', 'united states', 'europe', 'eu', 'uk', 'united kingdom', 'global', 'world', 'asia', 'africa', 'japan', 'brazil'];
const METHOD_WORDS = ['survey', 'model', 'estimate', 'census', 'sample', 'projection', 'forecast', 'audit', 'measured', 'modelled', 'modeled'];

// Explains why two sources with different numbers may differ.
export function explainDifference(a, b) {
  const reasons = [];
  const ya = a.publishedDate ? Number(a.publishedDate.slice(0, 4)) : null;
  const yb = b.publishedDate ? Number(b.publishedDate.slice(0, 4)) : null;
  if (a.publishedDate && b.publishedDate && a.publishedDate !== b.publishedDate) reasons.push('Publication dates differ (' + a.publishedDate + ' vs ' + b.publishedDate + ')');
  if (!ya || !yb) reasons.push('At least one source has no publication date');
  if (a.dataPeriod && b.dataPeriod && a.dataPeriod !== b.dataPeriod) reasons.push('Measurement periods differ (' + a.dataPeriod + ' vs ' + b.dataPeriod + ')');
  const pa = a.passage || '', pb = b.passage || '';
  const unitA = /%|percent/i.test(pa), unitB = /%|percent/i.test(pb);
  if (unitA !== unitB) reasons.push('One source reports a percentage and the other a count or amount');
  const geoA = COUNTRY_WORDS.filter((w) => pa.toLowerCase().includes(w));
  const geoB = COUNTRY_WORDS.filter((w) => pb.toLowerCase().includes(w));
  if (geoA.length && geoB.length && geoA.join() !== geoB.join()) reasons.push('Geographic coverage differs (' + geoA.join(', ') + ' vs ' + geoB.join(', ') + ')');
  const mA = METHOD_WORDS.filter((w) => pa.toLowerCase().includes(w));
  const mB = METHOD_WORDS.filter((w) => pb.toLowerCase().includes(w));
  if (mA.join() !== mB.join() && (mA.length || mB.length)) reasons.push('Methodology wording differs (' + (mA.join(', ') || 'none') + ' vs ' + (mB.join(', ') || 'none') + ')');
  if (!reasons.length) reasons.push('No difference in date, period, unit, geography or method was detected. The cause needs a manual check.');
  return reasons;
}

// Extracts the claims in an answer: sentences with a citation or a number, not questions or headings.
export function extractClaims(reply, now = new Date()) {
  const body = String(reply || '').replace(/```[\s\S]*?```/g, ' ').replace(/^#.*$/gm, ' ');
  const out = [];
  for (const raw of sentencesOf(body)) {
    if (raw.endsWith('?')) continue;
    const citedIds = Array.from(raw.matchAll(/\[(\d{1,2})\]/g), (m) => Number(m[1]));
    const text = raw.replace(/\[\d{1,2}\]/g, '').replace(/\s+/g, ' ').trim();
    if (!citedIds.length && !/\d/.test(text)) continue;
    if (text.length < 25) continue;
    out.push({ id: out.length + 1, text, citedIds: Array.from(new Set(citedIds)), context: classifyClaimContext(text, now) });
    if (out.length >= 12) break;
  }
  return out;
}

// Runs the claim pipeline. sources: all enriched sources with type and meta already attached.
export function verifyClaims(claims, sources) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const groups = originGroups(sources);
  const groupOf = new Map();
  groups.forEach((g, gi) => g.forEach((id) => groupOf.set(id, gi)));

  // Contradictions: sources whose best passage shares keywords with the claim but reports other numbers.
  const conflicts = [];
  for (const claim of claims) {
    const found = sources
      .map((s) => ({ s, pass: bestPassage(claim.text, String(s.content || '') + ' ' + String(s.raw || '')) }))
      .filter((x) => x.pass.overlap >= 0.5 && valueNumbers(x.pass.passage).length > 0);
    for (let i = 0; i < found.length; i++) {
      for (let j = i + 1; j < found.length; j++) {
        const A = found[i], B = found[j];
        const na = valueNumbers(A.pass.passage), nb = valueNumbers(B.pass.passage);
        if (na.some((x) => nb.includes(x))) continue;
        conflicts.push({
          claimId: claim.id,
          sourceA: { id: A.s.id, url: A.s.url, value: na.join(', '), passage: A.pass.passage },
          sourceB: { id: B.s.id, url: B.s.url, value: nb.join(', '), passage: B.pass.passage },
          reasons: explainDifference(Object.assign({}, A.s.meta, { passage: A.pass.passage }), Object.assign({}, B.s.meta, { passage: B.pass.passage }))
        });
      }
    }
  }
  const disputedClaims = new Set(conflicts.map((c) => c.claimId));

  const results = claims.map((claim) => {
    const cited = claim.citedIds.map((id) => byId.get(id)).filter(Boolean);
    const evals = cited.map((s) => checkClaimAgainstSource(claim.text, s));
    const supporting = evals.filter((e) => e.level === 'supported' || e.level === 'partial');
    const supportIds = supporting.map((e) => e.sourceId);
    const independent = new Set(supportIds.map((id) => groupOf.get(id))).size;
    const primary = supporting.some((e) => PRIMARY_TYPES.has(byId.get(e.sourceId).type));
    let status;
    let reason;
    const mismatch = evals.find((e) => e.level === 'unit_mismatch');
    if (!claim.citedIds.length) { status = 'unsupported'; reason = 'No source is cited for this claim.'; }
    else if (!cited.length) { status = 'unsupported'; reason = 'The cited source numbers do not match any retrieved source.'; }
    else if (mismatch) { status = 'disputed'; reason = 'Unit mismatch: the source says ' + mismatch.unit.found + ' where the answer says ' + mismatch.unit.claimed + '.'; }
    else if (disputedClaims.has(claim.id)) { status = 'disputed'; reason = 'Retrieved sources report different values for this claim.'; }
    else if (!supporting.length) { status = 'unsupported'; reason = 'The cited sources do not contain this statement.'; }
    else if (supporting.some((e) => e.level === 'supported') && (primary || independent >= 2)) { status = 'verified'; reason = primary ? 'Supported by a primary source.' : 'Supported by two or more independent sources.'; }
    else { status = 'partially_verified'; reason = 'Supported by one source only, or the passage is only partly matched.'; }
    return {
      id: claim.id,
      text: claim.text,
      context: claim.context,
      contextLabel: CONTEXT_LABELS[claim.context],
      status,
      reason,
      independentSources: independent,
      evidence: evals.map((e) => ({ sourceId: e.sourceId, url: e.url, level: e.level, passage: e.passage, numbersMissing: e.numbersMissing }))
    };
  });
  return { claims: results, conflicts };
}

// ---- URL checks ----
export function validateUrl(value) {
  let u;
  try { u = new URL(String(value)); } catch (e) { return { ok: false, reason: 'not a valid URL' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'only http and https are allowed' };
  if (u.username || u.password) return { ok: false, reason: 'URLs with credentials are not allowed' };
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return { ok: false, reason: 'local host' };
  if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h === '::1' || h.startsWith('[')) return { ok: false, reason: 'private address' };
  if (String(value).length > 2000) return { ok: false, reason: 'URL too long' };
  return { ok: true };
}

// Live check of a cited URL. Network errors are "unreachable", not "broken", so a slow site is not blamed.
export async function checkUrlLive(url, fetchImpl = fetch, timeoutMs = 4000) {
  const v = validateUrl(url);
  if (!v.ok) return { url, status: 'invalid', reason: v.reason };
  const attempt = async (method) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { method, redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': 'AviqoResearchCheck/1.0' } });
      return r.status;
    } finally { clearTimeout(timer); }
  };
  try {
    let code = await attempt('HEAD');
    if (code === 405 || code === 403 || code === 501) code = await attempt('GET');
    if (code === 404 || code === 410) return { url, status: 'broken', httpStatus: code };
    if (code === 401 || code === 403 || code === 429) return { url, status: 'blocked', httpStatus: code };
    if (code >= 500) return { url, status: 'unreachable', httpStatus: code };
    return { url, status: 'ok', httpStatus: code };
  } catch (e) {
    return { url, status: 'unreachable', reason: e && e.name === 'AbortError' ? 'timeout' : 'network error' };
  }
}

// Removes instruction-like text from web pages before the model reads it.
const INJECTION = /(ignore|disregard|forget)\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier|your)\s+(instructions?|prompts?|messages?|rules)|system prompt|you are now|new instructions|<\/?(system|script|iframe)[^>]*>/i;
export function sanitizeWebText(text) {
  return String(text || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .split('\n')
    .map((line) => (INJECTION.test(line) ? '[removed: instruction-like text from a web page]' : line))
    .join('\n');
}

// Small in-memory cache for search results. It only lives while a warm server instance stays alive.
export function createTtlCache(maxEntries = 100, ttlMs = 10 * 60 * 1000) {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (Date.now() > hit.until) { map.delete(key); return undefined; }
      return hit.value;
    },
    set(key, value) {
      if (map.size >= maxEntries) map.delete(map.keys().next().value);
      map.set(key, { value, until: Date.now() + ttlMs });
    },
    size() { return map.size; },
    clear() { map.clear(); }
  };
}

// ---- Self-audit ----
// Finds percentage statements like "from 100 to 121 ... 25%" and recomputes them.
export function auditCalculations(reply) {
  const issues = [];
  const text = String(reply || '');
  const pctRe = /from\s+([\d,]+(?:\.\d+)?)\s+(?:to|and)\s+([\d,]+(?:\.\d+)?)[^.%\n]{0,60}?(\d+(?:\.\d+)?)\s*(?:%|percent)/gi;
  for (const m of text.matchAll(pctRe)) {
    try {
      const computed = percentChange(m[1], m[2]).value;
      const reported = Number(m[3]);
      if (Math.abs(Math.abs(computed) - reported) > 0.5) {
        issues.push({ type: 'calculation', text: m[0], reported, computed: Math.abs(computed), formula: '(end - start) / start x 100', fix: 'The change from ' + m[1] + ' to ' + m[2] + ' is ' + Math.abs(computed) + '%, not ' + reported + '%.' });
      }
    } catch (e) { /* zero base: nothing to check */ }
  }
  const ofRe = /(\d+(?:\.\d+)?)\s*(?:%|percent)\s+of\s+([\d,]+(?:\.\d+)?)[^.\n]{0,30}?(?:is|=|equals|are)\s+([\d,]+(?:\.\d+)?)/gi;
  for (const m of text.matchAll(ofRe)) {
    const computed = percentOf(m[1], m[2].replace(/,/g, '')).value;
    const reported = Number(m[3].replace(/,/g, ''));
    if (Math.abs(computed - reported) > Math.max(0.5, Math.abs(computed) * 0.005)) {
      issues.push({ type: 'calculation', text: m[0], reported, computed, formula: 'percent / 100 x base', fix: m[1] + '% of ' + m[2] + ' is ' + computed + ', not ' + reported + '.' });
    }
  }
  return issues;
}

export function auditSources(sources, claims, now = new Date()) {
  const issues = [];
  const cited = new Set(claims.flatMap((c) => c.evidence.map((e) => e.sourceId)));
  for (const s of sources) {
    if (!cited.has(s.id)) continue;
    if (!s.meta || !s.meta.publishedDate) issues.push({ type: 'missing_date', sourceId: s.id, text: 'Source ' + s.id + ' has no publication date.' });
    const ref = (s.meta && (s.meta.updatedDate || s.meta.publishedDate));
    if (ref && (now - Date.parse(ref)) > 365 * 86400000) {
      const usedForCurrent = claims.some((c) => c.context === 'current' && c.evidence.some((e) => e.sourceId === s.id));
      if (usedForCurrent) issues.push({ type: 'outdated', sourceId: s.id, text: 'Source ' + s.id + ' is older than one year but is used for a current claim.' });
    }
  }
  for (const c of claims) {
    if (c.status === 'unsupported') issues.push({ type: 'unsupported_conclusion', claimId: c.id, text: c.reason });
  }
  return issues;
}

// Builds the evidence record the dashboard shows. Every number comes from the lists passed in.
export function buildEvidence({ searched, opened, sources, claims, conflicts, audit, stages, startedAt, finishedAt }) {
  const count = (status) => claims.filter((c) => c.status === status).length;
  return {
    metrics: {
      sourcesSearched: searched,
      sourcesOpened: opened,
      primarySources: sources.filter((s) => s.meta && PRIMARY_TYPES.has(s.type)).length,
      claimsChecked: claims.length,
      verified: count('verified'),
      partiallyVerified: count('partially_verified'),
      disputed: count('disputed'),
      unsupported: count('unsupported'),
      completionMs: Math.max(0, finishedAt - startedAt)
    },
    stages,
    claims,
    conflicts,
    audit
  };
}

export const STAGE_NAMES = ['Planning', 'Searching', 'Reading', 'Extracting', 'Cross-checking', 'Calculating', 'Writing', 'Completed'];

// Records real stage timings. A stage is "done", "skipped" or "failed", set by the code that ran it.
export function createStageTracker(start = Date.now()) {
  const stages = STAGE_NAMES.map((name) => ({ name, status: 'pending', ms: null }));
  let last = start;
  return {
    done(name, status = 'done') {
      const s = stages.find((x) => x.name === name);
      if (!s) return;
      const now = Date.now();
      s.status = status;
      s.ms = now - last;
      last = now;
    },
    list() { return stages.map((s) => Object.assign({}, s)); }
  };
}
