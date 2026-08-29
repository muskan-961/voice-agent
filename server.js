import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { SLIDES, buildInstructions, CHANGE_SLIDE_TOOL } from './slides.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Primary default provider — used whenever the client's llmConfig is
// blank (e.g. the page's LLM Settings panel left empty). Any
// OpenAI-compatible chat-completions endpoint works; defaults to OpenAI.
const DEFAULT_BASE_URL = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const DEFAULT_MODEL = process.env.LLM_MODEL || 'gpt-5.6-luna';
const DEFAULT_API_KEY = process.env.LLM_API_KEY || '';

// Dedicated Groq fallback — kept separate from the primary default above
// so that automatic rate-limit fallback (see the client's
// handleTurnFailure) always has somewhere real to switch to, regardless
// of which provider is configured as primary. GROQ_MODEL is kept as an
// alias for backwards compatibility with earlier .env files.
const GROQ_FALLBACK_BASE_URL = 'https://api.groq.com/openai/v1';
const GROQ_FALLBACK_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GROQ_FALLBACK_API_KEY = process.env.GROQ_API_KEY || '';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/slides', (req, res) => {
  res.json(SLIDES);
});

// llmConfig.useFallback routes to the dedicated Groq credentials above
// instead of the primary default — set by the client once it's detected
// the primary provider is rate limited.
function resolveLlmConfig(llmConfig = {}) {
  if (llmConfig.useFallback) {
    return { baseUrl: GROQ_FALLBACK_BASE_URL, model: GROQ_FALLBACK_MODEL, apiKey: GROQ_FALLBACK_API_KEY };
  }
  return {
    baseUrl: (llmConfig.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: llmConfig.model || DEFAULT_MODEL,
    apiKey: llmConfig.apiKey || DEFAULT_API_KEY,
  };
}

async function callLLM(messages, { forceNoTools = false, llmConfig = {} } = {}) {
  const { baseUrl, model, apiKey } = resolveLlmConfig(llmConfig);

  const body = {
    model,
    messages,
    temperature: 0.6,
  };
  if (!forceNoTools) {
    body.tools = [CHANGE_SLIDE_TOOL];
    body.tool_choice = 'auto';
  }
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  // Not every provider guarantees a valid JSON body on every status code
  // (a rate-limit response in particular can come back as plain text or
  // empty) — parsing blindly here would throw before r.status ever gets
  // attached to the error, silently downgrading e.g. a 429 into a generic
  // 500 and breaking rate-limit detection downstream.
  const rawBody = await r.text();
  let data;
  try {
    data = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    data = { error: { message: rawBody || `HTTP ${r.status} with no response body` } };
  }
  if (!r.ok) {
    const err = new Error(data.error?.message || `LLM API error (HTTP ${r.status})`);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  // baseUrl/model are what we resolved and sent; data.model (when present)
  // is the provider's own echo of what it actually ran — more
  // authoritative, since it's not just our own request construction.
  return { data, baseUrl, model: data.model || model };
}

// Stateless chat turn: client sends the running conversation back each time
// (as returned by the previous call) plus the new user utterance. The AI
// decides whether to call change_slide, then produces a spoken reply.
// llmConfig (apiKey/model/baseUrl) comes from the request body — it's used
// only for this single outbound call and is never logged or persisted.
app.post('/api/chat', async (req, res) => {
  try {
    const { userText, llmConfig = {} } = req.body;
    if (!resolveLlmConfig(llmConfig).apiKey) {
      return res.status(400).json({
        error: llmConfig.useFallback
          ? 'No Groq fallback API key configured on the server (set GROQ_API_KEY in .env).'
          : 'No API key configured. Add one in the page\'s LLM Settings, or set an API key in .env on the server.',
      });
    }

    let convo =
      Array.isArray(req.body.messages) && req.body.messages.length
        ? req.body.messages
        : [{ role: 'system', content: buildInstructions(SLIDES) }];

    if (userText) {
      convo.push({ role: 'user', content: userText });
    }

    let { data, baseUrl, model } = await callLLM(convo, { llmConfig });
    if (!data?.choices?.[0]?.message) {
      // A 200 response missing the expected shape (moderation refusal,
      // provider quirk, etc.) would otherwise throw a raw, unclassifiable
      // TypeError below — surface it as a clear, client-classifiable error
      // instead of a confusing generic crash.
      throw new Error(
        `LLM returned an unexpected response shape (no choices[0].message). Raw: ${JSON.stringify(data).slice(0, 300)}`
      );
    }
    let assistantMsg = data.choices[0].message;
    convo.push(assistantMsg);

    let slideIndex = null;
    if (assistantMsg.tool_calls?.length) {
      for (const call of assistantMsg.tool_calls) {
        if (call.function.name === 'change_slide') {
          let args = {};
          try {
            args = JSON.parse(call.function.arguments);
          } catch {
            // ignore malformed args
          }
          if (Number.isInteger(args.index) && SLIDES[args.index]) {
            slideIndex = args.index;
          }
          convo.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ success: true, now_showing: slideIndex }),
          });
        }
      }
      // Second pass so the model can produce a spoken reply now that the
      // tool result is in context, without calling change_slide again.
      ({ data, baseUrl, model } = await callLLM(convo, { forceNoTools: true, llmConfig }));
      assistantMsg = data.choices[0].message;
      convo.push(assistantMsg);
    }

    res.json({ reply: assistantMsg.content, slideIndex, messages: convo, provider: { baseUrl, model } });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.data || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Voice slides app running at http://localhost:${PORT}`);
});
