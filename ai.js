/* =====================================================================
   School Sync - AI engine (no Electron inside, so it can be tested alone)
   Providers, tried in order:  Groq (very fast)  ->  Gemini  ->  local Ollama
   Chat:  text goes to Groq first; images/PDFs go to Gemini first.
   PDFs:  Gemini reads the PDF itself; if Gemini is busy/out of quota, the
          PDF text is extracted and Groq reads that instead.
   ===================================================================== */
const GROQ_BASE = process.env.SS_GROQ_BASE || 'https://api.groq.com/openai/v1';
const GEMINI_BASE = process.env.SS_GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta';
const OLLAMA_BASE = process.env.SS_OLLAMA_BASE || 'http://localhost:11434/v1';
const GROQ_MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-20b'];
const GROQ_VISION = 'meta-llama/llama-4-scout-17b-16e-instruct';
const FIRST_BYTE_MS = Number(process.env.SS_FIRST_BYTE_MS) || 15000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const THINK = [{ thinkingConfig: { thinkingBudget: 0 } }, { thinkingConfig: { thinkingLevel: 'minimal' } }, {}];

function createAI({ loadSettings, patchSettings, log }) {
  const dead = new Set();      // models that answered 404 / decommissioned
  const goodCfg = {};          // gemini model -> index into THINK that worked
  let lastGemini = loadSettings().lastModel || '';
  const geminiModels = () => {
    const all = [lastGemini, 'gemini-3.8-flash', 'gemini-flash-latest', 'gemini-2.5-flash'].filter((x, i, a) => x && a.indexOf(x) === i);
    const ok = all.filter((m) => !dead.has('g:' + m));
    if (!ok.length) { all.forEach((m) => dead.delete('g:' + m)); return all; }
    return ok;
  };
  const groqModels = () => { const ok = GROQ_MODELS.filter((m) => !dead.has('q:' + m)); if (!ok.length) { GROQ_MODELS.forEach((m) => dead.delete('q:' + m)); return GROQ_MODELS; } return ok; };
  const rememberGemini = (m) => { if (lastGemini !== m) { lastGemini = m; try { patchSettings({ lastModel: m }); } catch {} } };

  /* fetch that gives up if nothing arrives in FIRST_BYTE_MS (a hanging connection used to freeze the chat) */
  async function fetchT(url, opts, outer, ms = FIRST_BYTE_MS) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (outer) { if (outer.aborted) ctl.abort(); else outer.addEventListener('abort', onAbort, { once: true }); }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms);
    try {
      const res = await fetch(url, { ...opts, signal: ctl.signal });
      clearTimeout(timer);
      return res;
    } catch (e) {
      clearTimeout(timer);
      if (timedOut) { const err = new Error('no answer in ' + ms / 1000 + 's'); err.timeout = true; throw err; }
      throw e;
    } finally { if (outer) outer.removeEventListener('abort', onAbort); }
  }
  const isAbort = (e, outer) => outer && outer.aborted;

  /* ---------- convert Gemini-style contents -> OpenAI messages ---------- */
  function toOpenAI(system, contents) {
    const msgs = [{ role: 'system', content: system || '' }];
    let hasImage = false;
    for (const c of contents) {
      const role = c.role === 'model' ? 'assistant' : 'user';
      const text = (c.parts || []).filter((p) => p.text != null).map((p) => p.text).join('\n');
      const imgs = (c.parts || []).filter((p) => p.inline_data && /^image\//.test(p.inline_data.mime_type));
      if (imgs.length && role === 'user') {
        hasImage = true;
        msgs.push({ role, content: [{ type: 'text', text: text || 'Look at this image.' }, ...imgs.map((p) => ({ type: 'image_url', image_url: { url: `data:${p.inline_data.mime_type};base64,${p.inline_data.data}` } }))] });
      } else msgs.push({ role, content: text });
    }
    return { msgs, hasImage };
  }

  /* read an SSE stream; calls onText for every piece. returns true if any text came */
  async function readSSE(res, pick, onText) {
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '', got = false;
    const handle = (line) => {
      line = line.trim(); if (!line.startsWith('data:')) return;
      const d = line.slice(5).trim(); if (!d || d === '[DONE]') return;
      try { const t = pick(JSON.parse(d)); if (t) { got = true; onText(t); } } catch {}
    };
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
    }
    if (buf) handle(buf);
    return got;
  }

  /* ---------- provider: any OpenAI-compatible server (Groq, Ollama) ---------- */
  async function chatOpenAI({ name, base, key, models, deadPrefix, contents, system, onText, outer, vision }) {
    const { msgs, hasImage } = toOpenAI(system, contents);
    const list = hasImage ? [vision] : models;
    if (!list || !list[0]) return { ok: false, err: name + ': cannot read images' };
    let err = '';
    for (const model of list) {
      let res;
      try {
        res = await fetchT(base + '/chat/completions', {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
          body: JSON.stringify({ model, messages: msgs, stream: true, temperature: 0.7, max_tokens: 2048 })
        }, outer);
      } catch (e) { if (isAbort(e, outer)) throw e; err = name + ': ' + (e.timeout ? e.message : (e.cause?.code === 'ECONNREFUSED' ? 'not running' : e.message)); if (e.timeout) return { ok: false, err }; break; }
      if (res.status === 401 || res.status === 403) return { ok: false, err: name + ': the key was rejected (check it in Setup > AI)' };
      if (res.status === 404 || res.status === 400) { const t = (await res.text()).slice(0, 160); dead.add(deadPrefix + model); err = name + ' ' + model + ': ' + t; continue; }
      if (res.status === 429 || res.status >= 500) { err = name + ' is busy (' + res.status + ')'; continue; } // try the next (smaller) model
      if (!res.ok) { err = name + ' ' + res.status; continue; }
      const got = await readSSE(res, (j) => j.choices?.[0]?.delta?.content, onText);
      if (!got) { err = name + ': empty answer'; continue; }
      return { ok: true, model };
    }
    return { ok: false, err: err || name + ' failed' };
  }

  /* ---------- provider: Gemini ---------- */
  async function chatGemini({ key, contents, system, onText, outer }) {
    let lastErr = '';
    for (const model of geminiModels()) {
      for (let ci = goodCfg[model] || 0; ci < THINK.length; ci++) {
        let res;
        try {
          res = await fetchT(`${GEMINI_BASE}/models/${model}:streamGenerateContent?alt=sse&key=${key}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ systemInstruction: { parts: [{ text: system || '' }] }, contents, generationConfig: { temperature: 0.8, maxOutputTokens: 4096, ...THINK[ci] } })
          }, outer);
        } catch (e) { if (isAbort(e, outer)) throw e; return { ok: false, err: 'Gemini: ' + (e.timeout ? e.message : e.message) }; }
        if (res.status === 404) { dead.add('g:' + model); lastErr = 'Gemini ' + model + ' not available'; break; }
        if (res.status === 429 || res.status >= 500) { lastErr = res.status === 429 ? 'Gemini: free quota used up for now (429)' : 'Gemini is busy (' + res.status + ')'; break; }
        if (!res.ok) {
          const t = (await res.text()).slice(0, 200);
          if (res.status === 400 && /API.?KEY/i.test(t)) return { ok: false, err: 'Gemini: the key was rejected (check it in Setup > AI)' };
          if (res.status === 403) return { ok: false, err: 'Gemini: the key was rejected (403)' };
          lastErr = 'Gemini ' + res.status; continue; // dislikes the thinking setting -> next one
        }
        const got = await readSSE(res, (j) => (j.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join(''), onText);
        if (!got) { lastErr = 'Gemini: empty answer'; break; }
        goodCfg[model] = ci; rememberGemini(model);
        return { ok: true, model };
      }
    }
    return { ok: false, err: lastErr || 'Gemini failed' };
  }

  /* ---------- streaming chat (Sync AI) ---------- */
  async function chat({ contents, system, onText, outer }) {
    const s = loadSettings();
    const hasFile = contents.some((c) => (c.parts || []).some((p) => p.inline_data));
    const gem = () => s.geminiKey ? { name: 'Gemini', run: () => chatGemini({ key: s.geminiKey, contents, system, onText, outer }) } : null;
    const grq = () => s.groqKey ? { name: 'Groq', run: () => chatOpenAI({ name: 'Groq', base: GROQ_BASE, key: s.groqKey, models: groqModels(), deadPrefix: 'q:', contents, system, onText, outer, vision: GROQ_VISION }) } : null;
    const oll = () => s.ollamaModel ? { name: 'Local model', run: () => chatOpenAI({ name: 'Local model', base: OLLAMA_BASE, key: '', models: [s.ollamaModel], deadPrefix: 'o:', contents, system, onText, outer }) } : null;
    const order = (hasFile ? [gem(), grq(), oll()] : [grq(), gem(), oll()]).filter(Boolean);
    if (!order.length) return { ok: false, err: 'Add a free Groq key (fastest) or a Gemini key in Setup > AI first.' };
    const errs = [];
    for (const p of order) {
      const r = await p.run();
      if (r.ok) return r;
      errs.push(r.err);
    }
    return { ok: false, err: errs.join(' · ') };
  }

  async function warm() {
    const s = loadSettings();
    try {
      if (s.groqKey) await fetchT(GROQ_BASE + '/models', { headers: { Authorization: 'Bearer ' + s.groqKey } });
      else if (s.geminiKey) await fetchT(`${GEMINI_BASE}/models?pageSize=1&key=${s.geminiKey}`, {});
      return true;
    } catch { return false; }
  }

  /* ---------- PDF -> items ---------- */
  const pdfPrompt = (notes, order) => {
    const today = new Date().toISOString().slice(0, 10);
    return `This is a school PDF (weekly plan, schedule, notice or homework list). Today is ${today}.
Extract what the student must study or bring. Return JSON only:
{"items":[{"title":"short title","date":"YYYY-MM-DD","books":[{"subject":"Science","book":"Science Student Book, Workbook","lessons":"Lesson one, Lesson two"}],"extras":"","notes":""}]}
Rules:
- One item per date. If the whole PDF is for one date or one week, make ONE item and copy the PDF's own title.
- "books" has ONE object per subject with three fields:
  "subject": the subject name, ALWAYS in English (for example Science, Maths, Arabic, German, Religion), even if the PDF writes it in Arabic.
  "book": the book(s) the student must bring for that subject (textbook, workbook, notebook, reader...), exactly as the PDF names them. If the PDF does not name the book, write "<Subject> book". Separate several books with a comma.
  "lessons": the content to study (lesson/unit/page names) separated by a normal comma ",". Keep lesson names in their original language, short, no filler words like "lesson" or "unit" unless part of the name.
- "extras": other things to bring that belong to no subject (sports kit, art supplies, calculator, signed paper...). Leave "" if none.
- Never join different subjects in one entry and never use " | ".
${/H\.?L/i.test(String(order || '')) ? '- "English O.L" and "English H.L" are two DIFFERENT subjects. Never merge them: write a separate entry for each, named exactly "English O.L" and "English H.L". If the PDF only says English for one of them, decide from the context.' : ''}
- Leave "notes" empty unless there is an important warning.
- If no date is written, use the nearest upcoming school day (Sunday to Thursday).
${notes ? '\nSTUDENT INFO - follow strictly: ' + notes + '\nIf a single line mixes content for different religions or languages, split it and keep ONLY the part that applies to this student. Skip every subject that does not apply to this student.' : ''}`;
  };
  const normalize = (parsed, order) => {
    const orderList = String(order || '').split(/[,،\n]/).map((x) => x.trim()).filter(Boolean);
    const clean = (x) => String(x || '').replace(/\s+/g, ' ').trim();
    parsed.forEach((it) => {
      const rows = (it.books || []).map((b) => {
        if (typeof b === 'string') return { text: b, subject: b.split(':')[0] };
        const subject = clean(b.subject), book = clean(b.book), lessons = clean(b.lessons);
        const text = subject + ': ' + (book ? '📘 ' + book : '') + (book && lessons ? ' — ' : '') + lessons;
        return { text, subject };
      });
      if (orderList.length) {
        const rank = (sub) => { sub = String(sub).replace(/\(.*\)/, '').trim(); const k = orderList.findIndex((o) => sub.includes(o) || o.includes(sub)); return k < 0 ? 999 : k; };
        rows.forEach((r, n) => { r.n = n; });
        rows.sort((x, y) => rank(x.subject) - rank(y.subject) || x.n - y.n);
      }
      it.books = rows.map((r) => r.text);
      if (clean(it.extras)) it.books.push('🎒 Also bring: ' + clean(it.extras));
    });
    return parsed;
  };
  const parseItems = (text) => {
    let t = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const j = JSON.parse(t || '{"items":[]}');
    return Array.isArray(j) ? j : (j.items || []);
  };

  async function pdfGemini(base64, s, quick) {
    const prompt = pdfPrompt(s.studentNotes, s.subjectOrder);
    let lastErr = '', busy = false;
    for (let round = 0; round < (quick ? 1 : 3); round++) {
      for (const model of geminiModels()) {
        for (let ci = goodCfg[model] || 0; ci < THINK.length; ci++) {
          const res = await fetchT(`${GEMINI_BASE}/models/${model}:generateContent?key=${s.geminiKey}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: 'application/pdf', data: base64 } }, { text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 4096, ...THINK[ci] } })
          }, null, 45000).catch((e) => { if (e.timeout) { busy = true; lastErr = 'Gemini is not answering'; return null; } throw e; });
          if (!res) break;
          if (res.status === 404) { lastErr = model + ' not available'; dead.add('g:' + model); break; }
          if ([429, 500, 502, 503, 504].includes(res.status)) { busy = true; lastErr = 'Gemini is busy (' + res.status + ')'; log(`${model} is busy (${res.status}), trying the next one...`, 'err'); if (!quick) await sleep(2000); break; }
          if (res.status === 400 && THINK[ci].thinkingConfig) continue;
          if (!res.ok) throw new Error('Gemini ' + res.status + ': ' + (await res.text()).slice(0, 200));
          const j = await res.json();
          const text = (j.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
          goodCfg[model] = ci; rememberGemini(model);
          return { items: parseItems(text), model };
        }
      }
      if (!busy) break;
      if (round < (quick ? 0 : 2)) { log('Gemini is busy, trying again in 8 seconds...', 'err'); await sleep(8000); busy = false; }
    }
    throw new Error(busy ? 'Gemini is too busy right now.' : 'No Gemini model available (' + lastErr + '). Check your API key at aistudio.google.com');
  }

  async function pdfText(base64) {
    let pdfParse; try { pdfParse = require('pdf-parse'); } catch { throw new Error('PDF text reader is not installed (run npm install)'); }
    const d = await pdfParse(Buffer.from(base64, 'base64'));
    return String(d.text || '').replace(/[ \t]+\n/g, '\n').trim();
  }

  async function pdfGroq(base64, s) {
    const text = await pdfText(base64);
    if (text.length < 40) throw new Error('This PDF is a scan/picture, so only Gemini can read it');
    const msgs = [{ role: 'system', content: 'You output JSON only.' }, { role: 'user', content: pdfPrompt(s.studentNotes, s.subjectOrder) + '\n\n----- PDF TEXT -----\n' + text.slice(0, 28000) }];
    let err = '';
    for (const model of groqModels()) {
      const res = await fetchT(GROQ_BASE + '/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.groqKey },
        body: JSON.stringify({ model, messages: msgs, temperature: 0, max_tokens: 4096, response_format: { type: 'json_object' } })
      }, null, 40000).catch((e) => { err = 'Groq: ' + e.message; return null; });
      if (!res) break;
      if (res.status === 401 || res.status === 403) throw new Error('Groq key was rejected');
      if ([404, 400].includes(res.status)) { dead.add('q:' + model); err = 'Groq ' + model; continue; }
      if (res.status === 429 || res.status >= 500) { err = 'Groq is busy (' + res.status + ')'; continue; }
      if (!res.ok) { err = 'Groq ' + res.status; continue; }
      const j = await res.json();
      return { items: parseItems(j.choices?.[0]?.message?.content), model };
    }
    throw new Error(err || 'Groq failed');
  }

  async function analyzePdf(base64) {
    const s = loadSettings(); const t0 = Date.now(); const errs = [];
    if (!s.geminiKey && !s.groqKey) throw new Error('Add a Groq or Gemini key first (Setup > AI)');
    const tryG = async () => { const r = await pdfGemini(base64, s, !!s.groqKey); return r; };
    const tryQ = async () => { const r = await pdfGroq(base64, s); return r; };
    const order = [];
    if (s.geminiKey) order.push(['Gemini', tryG]);
    if (s.groqKey) order.push(['Groq', tryQ]);
    for (const [name, fn] of order) {
      try {
        const r = await fn();
        log(`AI (${r.model}) finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`, 'ok');
        return normalize(r.items, s.subjectOrder);
      } catch (e) { errs.push(e.message); if (order.length > 1 && name === 'Gemini') log(e.message + ' - trying Groq instead...', 'err'); }
    }
    throw new Error(errs.join(' · '));
  }

  return { chat, warm, analyzePdf };
}

module.exports = { createAI };
