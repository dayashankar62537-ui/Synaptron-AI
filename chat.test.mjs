// Run with:  node --test chat.test.mjs
// (put this file next to api/chat.js and make sure package.json has "type": "module")
// All network calls are mocked, so no API keys or internet are needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { __resetRateLimits } from './chat.js';

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
function mockReq(body, ip = '1.1.1.1') {
  return { method: 'POST', body, headers: { 'x-forwarded-for': ip } };
}

// Installs a fake fetch. `groq(messages, call)` returns the reply text (or a Response-like override).
function installFetch({ groq, tavily }) {
  const calls = { groq: [], tavily: [] };
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (String(url).includes('groq.com')) {
      calls.groq.push(body);
      const out = groq ? groq(body.messages, calls.groq.length) : 'ok';
      if (out && out.__status) {
        return { ok: false, status: out.__status, json: async () => ({ error: { message: 'limit' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: out } }] }) };
    }
    if (String(url).includes('tavily.com')) {
      calls.tavily.push(body);
      const results = tavily ? tavily(body) : [];
      return { ok: true, status: 200, json: async () => ({ results }) };
    }
    throw new Error('unexpected url ' + url);
  };
  return calls;
}

const OFFICIAL = { title: 'Official docs', url: 'https://docs.example.com/page', content: 'The limit is 100 requests per minute.' };
const BLOG = { title: 'A blog', url: 'https://blog.example.org/post', content: 'People say the limit is about 100.' };

test.beforeEach(() => {
  __resetRateLimits();
  process.env.GROQ_API_KEY = 'test-groq';
  process.env.TAVILY_API_KEY = 'test-tavily';
});

// ---------- error handling and validation ----------
test('rejects non-POST requests', async () => {
  const res = mockRes();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 405);
});

test('explains how to fix a missing GROQ key', async () => {
  delete process.env.GROQ_API_KEY;
  const res = mockRes();
  await handler(mockReq({ message: 'hi' }), res);
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /GROQ_API_KEY/);
});

test('validates empty, too long and bad-image requests', async () => {
  installFetch({});
  let res = mockRes();
  await handler(mockReq({}), res);
  assert.equal(res.statusCode, 400);

  res = mockRes();
  await handler(mockReq({ message: 'x'.repeat(4001) }), res);
  assert.equal(res.statusCode, 400);

  res = mockRes();
  await handler(mockReq({ message: 'hi', image: { mimeType: 'image/gif', data: 'AAAA' } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Unsupported image/);
});

test('provider overload becomes a friendly 503', async () => {
  installFetch({ groq: () => ({ __status: 429 }) });
  const res = mockRes();
  await handler(mockReq({ message: 'hello' }), res);
  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /busy/i);
});

test('rate limit blocks the 21st request in a minute', async () => {
  installFetch({});
  let last;
  for (let i = 0; i < 21; i++) {
    last = mockRes();
    await handler(mockReq({ message: 'hi' }, '9.9.9.9'), last);
  }
  assert.equal(last.statusCode, 429);
  const other = mockRes();
  await handler(mockReq({ message: 'hi' }, '8.8.8.8'), other);
  assert.equal(other.statusCode, 200); // another visitor is not affected
});

// ---------- modes ----------
test('quick mode never calls web search; unknown mode falls back to quick', async () => {
  const calls = installFetch({ groq: () => '4' });
  let res = mockRes();
  await handler(mockReq({ message: '2+2?', mode: 'quick' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.searched, false);
  assert.equal(calls.tavily.length, 0);

  res = mockRes();
  await handler(mockReq({ message: 'hello', mode: 'not-a-mode' }), res);
  assert.equal(res.body.mode, 'quick');
  assert.match(calls.groq.at(-1).messages[0].content, /MODE: QUICK ANSWER/);
});

test('each mode injects its own instructions', async () => {
  const calls = installFetch({ groq: () => 'fine' });
  const expect = {
    solver: /MODE: PROBLEM SOLVER/, study: /MODE: STUDY/, coding: /MODE: CODING ASSISTANT/,
    data: /MODE: DATA ANALYST/, creative: /MODE: CREATIVE STUDIO/, file: /MODE: FILE ANALYSIS/
  };
  for (const [mode, re] of Object.entries(expect)) {
    __resetRateLimits();
    await handler(mockReq({ message: 'go', mode }), mockRes());
    assert.match(calls.groq.at(-1).messages[0].content, re, mode);
  }
});

// ---------- web search and citations ----------
test('web mode returns real sources and keeps only valid citations', async () => {
  const calls = installFetch({
    groq: (messages) => (messages[0].content.includes('Rewrite')
      ? 'api rate limit'
      : 'The limit is 100 per minute [1]. Some blogs agree [2] but one claim is unsupported [9].'),
    tavily: () => [OFFICIAL, BLOG]
  });
  const res = mockRes();
  await handler(mockReq({ message: 'What is the API rate limit?', mode: 'web' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.searched, true);
  assert.equal(calls.tavily.length, 1);
  assert.deepEqual(res.body.sources.map((s) => s.domain), ['docs.example.com', 'blog.example.org']);
  assert.equal(res.body.sources[0].url, OFFICIAL.url);
  assert.ok(res.body.reply.includes('[1]') && res.body.reply.includes('[2]'));
  assert.ok(!res.body.reply.includes('[9]'), 'invented citation number must be removed');

  const system = calls.groq.at(-1).messages[0].content;
  assert.match(system, /WEB_RESULTS/);
  assert.match(system, /untrusted/i);
  assert.match(system, /overrides any earlier statement/);
});

test('web search follow-up is rewritten using conversation history', async () => {
  const calls = installFetch({
    groq: (m) => (m[0].content.includes('Rewrite') ? 'Vercel function timeout limit' : 'answer [1]'),
    tavily: () => [OFFICIAL]
  });
  const res = mockRes();
  await handler(mockReq({
    message: 'what about its timeout?', mode: 'web',
    history: [{ role: 'user', content: 'Tell me about Vercel functions' }, { role: 'assistant', content: 'They run serverless code.' }]
  }), res);
  assert.equal(calls.tavily[0].query, 'Vercel function timeout limit');
});

test('without TAVILY_API_KEY the answer is honest about having no live search', async () => {
  delete process.env.TAVILY_API_KEY;
  const calls = installFetch({ groq: () => 'From general knowledge.' });
  const res = mockRes();
  await handler(mockReq({ message: 'latest iPhone price', mode: 'web' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.searched, false);
  assert.deepEqual(res.body.sources, []);
  assert.match(res.body.reply, /TAVILY_API_KEY/);
  assert.match(calls.groq.at(-1).messages[0].content, /no results are available/);
});

test('deep research plans queries, searches each, de-duplicates and reports steps', async () => {
  const calls = installFetch({
    groq: (m) => {
      if (m[0].content.includes('plan web research')) return '{"queries":["topic overview","topic risks"]}';
      return '## Summary\nFindings [1][2][3].\n';
    },
    tavily: (b) => (b.query === 'topic overview' ? [OFFICIAL, BLOG] : [OFFICIAL, { title: 'Third', url: 'https://third.example.net/x', content: 'more' }])
  });
  const res = mockRes();
  await handler(mockReq({ message: 'Research this topic', mode: 'deep' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(calls.tavily.length, 2);
  assert.ok(calls.tavily.every((c) => c.search_depth === 'advanced'));
  assert.equal(res.body.sources.length, 3, 'duplicate URL must be merged');
  assert.ok(res.body.steps.length >= 3);
  assert.match(calls.groq.at(-1).messages[0].content, /## Limitations and open questions/);
});

test('deep research is limited to 5 reports per 10 minutes', async () => {
  installFetch({ groq: (m) => (m[0].content.includes('plan web research') ? '{"queries":["q"]}' : 'report [1]'), tavily: () => [OFFICIAL] });
  let res;
  for (let i = 0; i < 6; i++) {
    res = mockRes();
    await handler(mockReq({ message: 'research', mode: 'deep' }, '7.7.7.7'), res);
  }
  assert.equal(res.statusCode, 429);
});

// ---------- file analysis ----------
test('attached file text is passed as untrusted data and truncation is flagged', async () => {
  const calls = installFetch({ groq: () => 'Summary: row 2 shows 40.' });
  const res = mockRes();
  await handler(mockReq({
    message: 'Summarize', mode: 'file',
    file: { name: 'sales.csv', text: 'month,amount\nJan,10\nFeb,40\n' + 'x'.repeat(50000) }
  }), res);
  assert.equal(res.statusCode, 200);
  const system = calls.groq.at(-1).messages[0].content;
  assert.match(system, /sales\.csv/);
  assert.match(system, /Feb,40/);
  assert.match(system, /untrusted/i);
  assert.match(system, /truncated/);
});

test('file mode without a file tells the model nothing is attached', async () => {
  const calls = installFetch({ groq: () => 'Please attach a file.' });
  await handler(mockReq({ message: 'Summarize my file', mode: 'file' }), mockRes());
  assert.match(calls.groq.at(-1).messages[0].content, /No file text is attached/);
});
