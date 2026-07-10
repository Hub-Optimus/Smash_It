// ============================================================
// Smash_It — AI Meeting Assistant
// api/ai.js — Vercel Node serverless function (Groq — free tier)
// ------------------------------------------------------------
// Switched from OpenAI back to Groq (free) at Cap's request —
// same GROQ_API_KEY already used on AceMock/TrustRoute, shares
// that account's daily free-tier limit.
//
// Groq's API is OpenAI-compatible (same request/response shape),
// so this file is otherwise identical to the OpenAI version —
// only the endpoint, model, and env var name changed.
//
// Accepts the full conversation history (not just a single
// question), so instructions given earlier in the chat ("answer
// as the ops lead managing both LOBs") keep applying to every
// later answer, automatic or typed — like a real chat.
// ============================================================

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'llama-3.3-70b-versatile'; // free tier

const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY_MESSAGES = 40;
const MAX_SOURCE_CHARS_EACH = 20000; // matches/exceeds the client's CONTEXT_BUDGET (18000) so a document sent whole is never re-truncated here
const MAX_SOURCES_TOTAL_CHARS = 45000;
const MAX_SOURCES = 6;

const SYSTEM_PROMPT = `You are Smash_It, a real-time AI meeting co-pilot, talking with the user in an ongoing chat. They are in a live meeting right now. You have background reference documents about their role and work — but you are NOT limited to only what's written there. Think of yourself as a sharp, quick-thinking professional colleague helping them respond confidently in the moment.

This is a real conversation with memory: if the user gives you an instruction earlier in the chat (e.g. "answer as the ops lead managing both LOBs", "keep answers under 3 sentences", "assume I'm talking to the board"), keep following it for every later message unless they say otherwise. Treat earlier turns as real context, not just background noise.

How to answer each new question:
1. If the documents directly answer it, use them as the basis of your answer. For anything computable from the documents (durations, totals, counts, dates), work it out carefully and precisely from what's actually given — don't approximate if the exact figures are right there.
2. If the documents contain related or adjacent information but not an exact answer, blend that context with your own reasoning to construct a natural, confident answer — the kind a competent professional would give on the spot. Do NOT say the documents don't cover it and do NOT refuse to answer.
3. If the documents have nothing relevant at all, answer from general professional reasoning for their apparent role and context. Still be concise and confident — never a dead end.
4. CRITICAL — do the work, don't invent the inputs. If the documents contain the underlying data needed to compute an answer (e.g. start/end dates to work out a duration, a list of employers to count), you MUST work it out precisely and state the result with confidence — refusing to do simple arithmetic or counting when the raw data is right there is a failure, not caution. Only say a figure "isn't available" when the underlying data itself is genuinely missing from the documents — never merely because it requires a calculation. Rules 2 and 3 above are for open-ended, judgment-style questions ("how do you approach X"); this rule is about concrete, checkable facts. Never invent a number, date, or fact that has no basis anywhere in the documents — but never withhold one you can actually compute, either.
5. Keep it meeting-ready: 2-5 sentences, natural spoken tone, no hedging like "it depends" unless truly necessary — unless an earlier instruction says otherwise.
6. "sources" = document names you actually drew on for THIS answer (empty array if none contributed).
7. "basis" = "document" if the answer came directly from the documents, "blended" if you combined documents with your own reasoning, "general" if you answered from reasoning alone with no real document support.

Respond with STRICT JSON only — no markdown, no code fences, no text outside the JSON object:
{"answer": "...", "sources": ["Doc name"], "basis": "document" | "blended" | "general"}`;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed. Use POST.' }); return; }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'API key not configured. Add GROQ_API_KEY in Vercel → Settings → Environment Variables, then redeploy.' });
    return;
  }

  const body = req.body || {};

  let history = Array.isArray(body.messages) ? body.messages : [];
  let sources = Array.isArray(body.sources) ? body.sources : [];

  history = history
    .filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim().length > 0; })
    .map(function (m) { return { role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }; })
    .slice(-MAX_HISTORY_MESSAGES);

  if (!history.length || history[history.length - 1].role !== 'user') {
    res.status(400).json({ error: 'No question to answer — the conversation must end with a user message.' });
    return;
  }
  if (history[history.length - 1].content.trim().length < 2) {
    res.status(400).json({ error: 'That message is too short.' });
    return;
  }

  sources = sources
    .filter(function (s) { return s && s.name && s.text && String(s.text).trim().length > 0; })
    .slice(0, MAX_SOURCES)
    .map(function (s) { return { name: String(s.name).slice(0, 120), text: String(s.text).slice(0, MAX_SOURCE_CHARS_EACH) }; });

  let total = 0;
  const docsBlock = [];
  for (let i = 0; i < sources.length; i++) {
    const remaining = MAX_SOURCES_TOTAL_CHARS - total;
    if (remaining <= 0) break;
    const text = sources[i].text.slice(0, remaining);
    total += text.length;
    docsBlock.push('[Source: ' + sources[i].name + ']\n' + text);
  }

  const docsMessage = docsBlock.length
    ? 'BACKGROUND DOCUMENTS (reference only — not a hard limit, relevant to the latest question):\n' + docsBlock.join('\n\n---\n\n')
    : 'BACKGROUND DOCUMENTS: none relevant to the latest question.';

  const payload = {
    model: MODEL,
    temperature: 0.4,
    max_tokens: 500,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'system', content: docsMessage }
    ].concat(history),
    response_format: { type: 'json_object' }
  };

  try {
    let resp = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(payload)
    });

    if (resp.status === 400) {
      const errText = await resp.text();
      if (/response_format|json_object/i.test(errText)) {
        delete payload.response_format;
        resp = await fetch(GROQ_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
          body: JSON.stringify(payload)
        });
      } else {
        res.status(400).json({ error: 'Groq rejected the request: ' + errText.slice(0, 400) });
        return;
      }
    }

    if (resp.status === 429) {
      res.status(429).json({ error: 'Groq rate limit reached (free tier). Wait a minute and try again — daily/minute limits reset automatically.' });
      return;
    }
    if (resp.status === 401) {
      res.status(401).json({ error: 'Groq rejected the API key. Check GROQ_API_KEY in Vercel → Settings → Environment Variables.' });
      return;
    }
    if (!resp.ok) {
      const errText = await resp.text();
      res.status(resp.status).json({ error: 'Groq API error ' + resp.status + ': ' + errText.slice(0, 400) });
      return;
    }

    const data = await resp.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
    if (!content) { res.status(502).json({ error: 'Groq returned an empty response. Try again.' }); return; }

    res.status(200).json({ content: content, model: MODEL, usage: data.usage || null });
  } catch (e) {
    res.status(500).json({ error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
