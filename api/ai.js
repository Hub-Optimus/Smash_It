// ============================================================
// Smash_It — AI Meeting Assistant
// api/ai.js — Vercel Node serverless function (Groq — free tier)
// ------------------------------------------------------------
// v10 — SIMPLIFIED "ANSWER LIKE CHATGPT" MODE
//
// Cap's diagnosis: the document-delivery pipeline (docs pinned as
// 📎 messages inside state.history) was already working correctly —
// the CV really was reaching the model every time. The bug was the
// SYSTEM PROMPT: a dense stack of numbered "CRITICAL" rules plus a
// forced response_format:"json_object" was making the model overly
// literal/cautious (a known pattern on JSON-mode + rule-heavy
// prompts), so it kept saying "not available" with the answer
// sitting right in front of it.
//
// Fix: removed the rule stack and the forced JSON mode entirely.
// The model is now told to just answer naturally, the way ChatGPT
// would, using whatever is in the conversation (including any 📎
// documents) — no special-cased instructions for counting, refusing,
// or preferring "prepared answers." A light JSON wrapper is still
// *requested* (not forced) so the existing source-chip / basis-dot
// UI keeps working — but nothing breaks if the model ignores it,
// since the client already falls back to plain text gracefully.
//
// Document/history transport (pinning, trimming, char budgets) is
// UNCHANGED — that part was never broken.
// ============================================================

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'llama-3.3-70b-versatile'; // free tier

const MAX_MESSAGE_CHARS = 70000; // must fit a whole pinned 📎 document message — the old 2000 cap would silently chop uploads
const MAX_HISTORY_MESSAGES = 50; // up to 40 conversational turns + up to 5 pinned document messages, with headroom

const SYSTEM_PROMPT = `You are Smash_It, a helpful AI assistant sitting alongside the user during a live meeting. Talk to them the way ChatGPT would: naturally, directly, and conversationally — read the whole conversation and just answer.

The user may share reference documents in this chat — they appear as messages starting with 📎 "Uploaded document", containing the document's full text. Treat those exactly like a file someone handed you in a normal chat: read them, quote them, and compute from them (counts, totals, dates, durations, whatever's asked) whenever relevant, the same way you normally would. No special caution beyond what you'd normally apply — if the information is there, use it and answer with confidence.

This is a real conversation with memory: if the user gave you an instruction earlier in the chat about how to answer (tone, role, length, "assume I'm talking to the board," etc.), keep following it for later messages too, unless they say otherwise.

Answer plainly and confidently, matching length to the question — a quick factual lookup gets a sentence or two, an open-ended question gets a fuller answer. If something genuinely isn't anywhere in the conversation or documents and can't reasonably be worked out, just say so briefly and move on — don't dwell on it or over-explain what you can't find.

Format your reply as JSON:
{"answer": "your natural reply here", "sources": ["doc name", ...], "basis": "document" | "blended" | "general"}
- sources: names of any 📎 documents you actually drew on for this answer (empty array if none)
- basis: "document" if the answer came mainly from an uploaded document, "blended" if you combined a document with your own reasoning, "general" if you answered from general knowledge with no real document support
If for any reason you can't format it as JSON, plain text is fine too.`;

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

  const payload = {
    model: MODEL,
    temperature: 0.6,
    max_tokens: 800,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }].concat(history)
    // Note: no response_format:"json_object" here on purpose — forcing
    // JSON mode is the likely cause of the over-literal "not available"
    // answers. We ask nicely for JSON in the prompt instead; the client
    // already falls back to plain text gracefully if it doesn't parse.
  };

  try {
    const resp = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(payload)
    });

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
