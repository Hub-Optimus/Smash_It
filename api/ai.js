// ============================================================
// Smash_It — AI Meeting Assistant
// api/ai.js — Vercel Node serverless function
// ------------------------------------------------------------
// v11 — DYNAMIC MULTI-PROVIDER MODE
//
// Cap kept hitting Groq's free-tier rate limit mid-meeting. Rather than
// hardcoding one provider and needing a code change + redeploy every time
// he wants to try another, the client now sends which provider to use
// (groq / openai / anthropic) and, optionally, his own API key and a
// model override — picked from the "AI Provider & API Key" panel in the
// app itself (sidebar picker or account menu). No env vars need to
// change and nothing needs to be redeployed to switch providers.
//
// Backward compatible: if the client sends no provider (older cached
// page) or no key, this falls back to Groq using GROQ_API_KEY from
// Vercel env vars — exactly today's behavior.
//
// Document/history transport (pinning, trimming, char budgets) is
// UNCHANGED from v10 — that part was already correct.
// ============================================================

const MAX_MESSAGE_CHARS = 70000; // must fit a whole pinned 📎 document message
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

const PROVIDERS = {
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    defaultModel: 'llama-3.3-70b-versatile',
    envKey: 'GROQ_API_KEY',
    shape: 'openai'
  },
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o-mini',
    envKey: 'OPENAI_API_KEY',
    shape: 'openai'
  },
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-sonnet-5',
    envKey: 'ANTHROPIC_API_KEY',
    shape: 'anthropic'
  }
};

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Anthropic requires strictly alternating user/assistant turns with no two
// same-role messages in a row. Our history should already alternate, but
// this merges any accidental repeats defensively rather than letting the
// whole request fail on a formatting technicality.
function mergeConsecutiveRoles(history) {
  const out = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (out.length && out[out.length - 1].role === m.role) {
      out[out.length - 1].content += '\n\n' + m.content;
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  if (out.length && out[0].role !== 'user') out.shift();
  return out;
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed. Use POST.' }); return; }

  const body = req.body || {};

  const providerName = PROVIDERS[body.provider] ? body.provider : 'groq';
  const provider = PROVIDERS[providerName];

  // Client-supplied key wins (from the in-app AI Settings panel); falls
  // back to the matching server env var so nothing breaks if unset.
  const apiKey = (typeof body.apiKey === 'string' && body.apiKey.trim()) || process.env[provider.envKey];
  if (!apiKey) {
    res.status(500).json({
      error: (providerName === 'groq' ? 'Groq' : providerName === 'openai' ? 'OpenAI' : 'Anthropic') +
        ' API key not configured. Add your own key in the app\'s AI Provider settings, or set ' + provider.envKey + ' in Vercel → Settings → Environment Variables.'
    });
    return;
  }

  const model = (typeof body.model === 'string' && body.model.trim()) || provider.defaultModel;

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

  let fetchUrl = provider.url;
  let headers = { 'Content-Type': 'application/json' };
  let payload;

  if (provider.shape === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    payload = {
      model: model,
      max_tokens: 800,
      temperature: 0.6,
      system: SYSTEM_PROMPT,
      messages: mergeConsecutiveRoles(history)
    };
  } else {
    headers.Authorization = 'Bearer ' + apiKey;
    payload = {
      model: model,
      temperature: 0.6,
      max_tokens: 800,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }].concat(history)
      // No forced response_format/json mode — asked for nicely in the
      // prompt instead. The client already falls back to plain text
      // gracefully if a reply doesn't parse as JSON.
    };
  }

  try {
    const resp = await fetch(fetchUrl, { method: 'POST', headers: headers, body: JSON.stringify(payload) });

    if (resp.status === 429) {
      res.status(429).json({ error: (providerName === 'groq' ? 'Groq' : providerName) + ' rate limit reached. Wait a bit and try again, or switch providers in AI Settings.' });
      return;
    }
    if (resp.status === 401 || resp.status === 403) {
      res.status(resp.status).json({ error: (providerName === 'groq' ? 'Groq' : providerName) + ' rejected the API key. Check it in AI Settings.' });
      return;
    }
    if (!resp.ok) {
      const errText = await resp.text();
      res.status(resp.status).json({ error: providerName + ' API error ' + resp.status + ': ' + errText.slice(0, 400) });
      return;
    }

    const data = await resp.json();
    let content = '';
    if (provider.shape === 'anthropic') {
      const blocks = Array.isArray(data.content) ? data.content : [];
      content = blocks.filter(function (b) { return b && b.type === 'text'; }).map(function (b) { return b.text; }).join('\n').trim();
    } else {
      content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
    }
    if (!content) { res.status(502).json({ error: providerName + ' returned an empty response. Try again.' }); return; }

    res.status(200).json({ content: content, model: model, provider: providerName, usage: data.usage || null });
  } catch (e) {
    res.status(500).json({ error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
