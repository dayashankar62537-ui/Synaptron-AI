# Aviqo AI: Phase 1 setup

## Files
| File | Status | What changed |
|---|---|---|
| `api/chat.js` | changed | 9 modes, Tavily web search with numbered sources, Deep Research, text-file analysis, rate limiting, validation, model fallback |
| `chat.html` | changed | Mode selector, source cards, clickable [n] citations, "how this was researched" steps, chat history sent to the server, TXT/CSV/MD/JSON attach |
| `api/chat.test.mjs` | new | 14 automated tests (network mocked) |
| `vercel.json` | new | Allows Deep Research to run up to 60 s. If you already have a vercel.json, merge the `functions` block |

## Environment variables (Vercel > Project > Settings > Environment Variables)
| Name | Required | Purpose |
|---|---|---|
| `GROQ_API_KEY` | yes (already set) | AI model |
| `TAVILY_API_KEY` | for Web Search and Deep Research | Get a free key at tavily.com. Without it those modes still answer, but say clearly that live search is not set up |
| `GROQ_STRONG_MODEL` | optional | Model for Deep Research, Problem Solver, Coding, Data. Default `openai/gpt-oss-120b` |

Redeploy after adding variables.

## Run the tests
Put `chat.test.mjs` next to `chat.js`, make sure `package.json` has `"type": "module"`, then:
`node --test chat.test.mjs`

## Working now (with GROQ_API_KEY only)
Quick, Problem Solver, Study, Coding, File Analysis (TXT/CSV/MD/JSON text and images), Data Analyst, Creative; follow-up context; rate limiting; error messages.

## Needs TAVILY_API_KEY
Web Search and Deep Research (sources, citations, research steps).

## Not built yet (needs extra services)
- Accounts, saved projects, cloud chat history (needs a database such as Supabase; chats are still saved per browser)
- PDF and DOCX reading (needs a parsing library on the server)
- Vector search over many documents
- Streaming replies, stop-generation button, multilingual voice input
- Agent task planning with confirmations (nothing consequential can be triggered yet)

## Known limits
- Rate limiting is in-memory, so it is per server instance (good against bursts, not a hard global cap).
- Citations are only as good as the search results; the server removes [n] numbers that do not exist, but cannot check that a source supports a claim.
- Code and calculations are reasoned by the model, not executed.
