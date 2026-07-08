// ============================================================
// Smash_It — AI Meeting Assistant
// api/ai.js — Vercel Node serverless function (OpenAI)
// ------------------------------------------------------------
// NOTE: earlier versions of this file used `runtime: 'edge'`.
// Vercel changed how edge functions behave and that broke this
// endpoint (500 / FUNCTION_INVOCATION_FAILED). This version runs
// on the standard Node.js serverless runtime instead — no config
// export needed, and req.body is already parsed by Vercel.
// ============================================================

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini'; // fast + cheap, good for real-time meeting answers

const MAX_QUESTION_CHARS = 2000;
const MAX_TRANSCRIPT_CHARS = 1600;
const MAX_SOURCE_CHARS_EACH = 9000;
const MAX_SOURCES_TOTAL_CHARS = 30000;
const MAX_SOURCES = 6;

const SYSTEM_PROMPT = `You are Smash_It, a real-time AI meeting co-pilot. The person you're helping is in a live meeting right now and just got asked a question (or wants to ask one themselves). You have background reference documents about their role and work — but you are NOT limited to only what's written there. Think of yourself as a sharp, quick-thinking professional colleague helping them respond confidently in the moment.

How to answer:
1. If the documents directly answer the question, use them as the basis of your answer.
2. If the documents contain related or adjacent information but not an exact answer, blend that context with your own reasoning to construct a natural, confident answer — the kind a competent professional would give on the spot. Do NOT say the documents don't cover it and do NOT refuse to answer.
3. If the documents have nothing relevant at all, answer from general professional reasoning for their apparent role and context. Still be concise and confident — never a dead end.
4. Keep it meeting-ready: 2-5 sentences, natural spoken tone, no hedging like "it depends" unless truly necessary.
5. "sources" = document names you actually drew on (empty array if none contributed).
6. "basis" = "document" if the answer came directly from the documents, "blended" if you combined documents with your own reasoning, "general" if you answered from reasoning alone with no real document support.

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

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'API key not configured. Add OPENAI_API_KEY in Vercel → Settings → Environment Variables, then redeploy.' });
    return;
  }

  const body = req.body || {};

  let question = (body.question || '').toString().trim();
  const transcriptContext = (body.transcriptContext || '').toString().slice(0, MAX_TRANSCRIPT_CHARS);
  let sources = Array.isArray(body.sources) ? body.sources : [];

  if (!question || question.length < 4) {
    res.status(400).json({ error: 'Question is empty or too short.' });
    return;
  }
  question = question.slice(0, MAX_QUESTION_CHARS);

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

  const userMessage =
    (docsBlock.length ? 'BACKGROUND DOCUMENTS (reference only — not a hard limit):\n' + docsBlock.join('\n\n---\n\n') + '\n\n' : 'BACKGROUND DOCUMENTS: none provided.\n\n') +
    (transcriptContext ? 'MEETING CONTEXT (recent transcript, for reference only):\n' + transcriptContext + '\n\n' : '') +
    'QUESTION ASKED IN THE MEETING:\n' + question;

  const payload = {
    model: MODEL,
    temperature: 0.4,
    max_tokens: 500,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage }
    ],
    response_format: { type: 'json_object' }
  };

  try {
    let resp = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(payload)
    });

    if (resp.status === 400) {
      const errText = await resp.text();
      if (/response_format|json_object/i.test(errText)) {
        delete payload.response_format;
        resp = await fetch(OPENAI_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
          body: JSON.stringify(payload)
        });
      } else {
        res.status(400).json({ error: 'OpenAI rejected the request: ' + errText.slice(0, 400) });
        return;
      }
    }

    if (resp.status === 429) {
      res.status(429).json({ error: 'OpenAI rate limit or quota reached. Wait a moment and try again, or check your OpenAI billing.' });
      return;
    }
    if (resp.status === 401) {
      res.status(401).json({ error: 'OpenAI rejected the API key. Check OPENAI_API_KEY in Vercel → Settings → Environment Variables.' });
      return;
    }
    if (!resp.ok) {
      const errText = await resp.text();
      res.status(resp.status).json({ error: 'OpenAI API error ' + resp.status + ': ' + errText.slice(0, 400) });
      return;
    }

    const data = await resp.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
    if (!content) { res.status(502).json({ error: 'OpenAI returned an empty response. Try again.' }); return; }

    res.status(200).json({ content: content, model: MODEL, usage: data.usage || null });
  } catch (e) {
    res.status(500).json({ error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
