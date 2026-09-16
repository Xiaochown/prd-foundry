#!/usr/bin/env node
/**
 * PRD Foundry — backend proxy (OpenAI-compatible).
 * Mirrors the original server's /api/* contract so the static SPA works
 * anywhere a Node server can run (local, VPS, Vercel serverless).
 *
 * No dependencies: Node >= 18 (global fetch, AbortSignal.timeout).
 *
 * Endpoints implemented:
 *   POST /api/account/me          -> {user:null} (guest mode)
 *   POST /api/models              -> {models:[...]}            (proxy GET {baseUrl}/models)
 *   POST /api/model-test          -> {verified,requestedModel,reportedModel,latencyMs}
 *   POST /api/generate-stream     -> SSE stage/done/error       (4 docs: prd.md, design.md, userflow.md, tasks.md)
 *   POST /api/followup            -> {questions:[...], usage}
 *   POST /api/consistency         -> {issues:[...], usage}
 *   POST /api/revise              -> {proposal:{file,section,replacement}, usage}
 *   POST /api/assist              -> {message, usage}
 *
 * Security:
 *   - SSRF guard: only https public endpoints unless ALLOW_PRIVATE=1
 *   - MOCK_UPSTREAM="host|target,host2|target2" (only when ALLOW_PRIVATE=1)
 *     rewrites the provider host for local E2E testing.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1';
const MOCK_UPSTREAM = new Map(
  (process.env.MOCK_UPSTREAM || '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .map(pair => { const [a, b] = pair.split('|'); return [a, b]; })
);
const DOCS = ['prd.md', 'design.md', 'userflow.md', 'tasks.md'];
const DOC_LABELS = {
  'prd.md': 'PRD (Product Requirements Document)',
  'design.md': 'Design system & UI direction',
  'userflow.md': 'User flow & journeys',
  'tasks.md': 'Task breakdown (developer-ready)',
};

/* ---------------- SSRF guard ---------------- */
function checkTarget(baseUrl) {
  let u;
  try { u = new URL(baseUrl); } catch { return 'Base URL tidak valid. / Invalid base URL.'; }
  if (!/^https?:$/.test(u.protocol)) return 'Base URL harus http(s). / Base URL must be http(s).';
  if (MOCK_UPSTREAM.has(u.hostname) && ALLOW_PRIVATE) return null; // test-mode rewrite
  if (u.protocol !== 'https:' && !ALLOW_PRIVATE) return 'Gunakan HTTPS untuk melindungi API key. / Use HTTPS to protect your API key.';
  if (!ALLOW_PRIVATE) {
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return 'Endpoint lokal diblokir. / Local endpoints are blocked.';
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
      const p = h.split('.').map(Number);
      if (p[0] === 10 || p[0] === 127 || (p[0] === 192 && p[1] === 168) ||
          (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || p[0] === 0) return 'Endpoint privat diblokir. / Private endpoints are blocked.';
    }
  }
  return null;
}

function resolveBaseUrl(baseUrl) {
  if (!ALLOW_PRIVATE) return baseUrl;
  const u = new URL(baseUrl);
  if (MOCK_UPSTREAM.has(u.hostname)) {
    const target = new URL(MOCK_UPSTREAM.get(u.hostname));
    u.protocol = target.protocol;
    u.host = target.host;
  }
  return u.toString();
}

/* ---------------- upstream helpers ---------------- */
function bearer(apiKey) { return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }; }
const trimSlash = s => (s || '').replace(/\/+$/, '');

async function upstreamJson(baseUrl, apiKey, path, payload, signal, extraHeaders = {}) {
  const res = await fetch(trimSlash(resolveBaseUrl(baseUrl)) + path, {
    method: 'POST',
    headers: { ...bearer(apiKey), ...extraHeaders },
    body: JSON.stringify(payload),
    signal,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || data?.error || `Upstream ${res.status}`;
    const err = new Error(msg); err.status = res.status; err.data = data; throw err;
  }
  return data;
}

function usageOf(u = {}) {
  return {
    promptTokens: u.prompt_tokens ?? null,
    completionTokens: u.completion_tokens ?? null,
    totalTokens: u.total_tokens ?? null,
    cost: null,
  };
}

/* ---------------- endpoint handlers ---------------- */
async function hAccount() { return { status: 200, json: { user: null } }; }

async function hModels(body) {
  const { baseUrl, apiKey } = body.provider || {};
  const bad = checkTarget(baseUrl);
  if (bad) return { status: 400, json: { error: bad } };
  console.log(`[models] fetching ${baseUrl}/models`);
  const t0 = Date.now();
  const res = await fetch(trimSlash(resolveBaseUrl(baseUrl)) + '/models', {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20000),
  });
  console.log(`[models] upstream responded in ${Date.now() - t0}ms status=${res.status}`);
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || data?.error || `Upstream ${res.status}`;
    return { status: 500, json: { error: msg } };
  }
  const list = Array.isArray(data?.data) ? data.data.map(m => m.id ?? m) : [];
  if (!list.length) return { status: 500, json: { error: 'Penyedia tidak mengembalikan model. / The provider returned no models.' } };
  return { status: 200, json: { models: list } };
}

async function hModelTest(body) {
  const { baseUrl, apiKey, model } = body.provider || {};
  const bad = checkTarget(baseUrl);
  if (bad) return { status: 400, json: { error: bad } };
  const t0 = Date.now();
  try {
    const data = await upstreamJson(baseUrl, apiKey, '/chat/completions', {
      model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, temperature: 0, stream: false,
    }, AbortSignal.timeout(30000));
    const latencyMs = Date.now() - t0;
    const reportedModel = data?.model || data?.model_id || data?.id || model;
    return { status: 200, json: { verified: true, requestedModel: model, reportedModel, latencyMs } };
  } catch (err) {
    return { status: 500, json: { error: err.message || 'Test gagal. / Test failed.' } };
  }
}

/* Prompt builders */
function briefText(brief = {}, language = 'id') {
  const L = language === 'en'
    ? { idea: 'Idea', audience: 'Audience', problem: 'Problem', features: 'Features', style: 'Design' }
    : { idea: 'Ide', audience: 'Pengguna', problem: 'Masalah', features: 'Fitur', style: 'Desain' };
  return Object.entries(L).map(([k, label]) => `- ${label}: ${(brief[k] || '').trim()}`).filter(x => !x.endsWith(':')).join('\n');
}

function docInstructions(language) {
  return language === 'en'
    ? `Wrap every document in markers:
<!-- PRDFOUNDRY:BEGIN prd.md -->
...document content...
<!-- PRDFOUNDRY:END prd.md -->
Use these four files, in this order: prd.md, design.md, userflow.md, tasks.md. Every document must be complete, self-contained markdown.`
    : `Bungkus setiap dokumen dengan marker:
<!-- PRDFOUNDRY:BEGIN prd.md -->
...isi dokumen...
<!-- PRDFOUNDRY:END prd.md -->
Gunakan empat file ini, urut: prd.md, design.md, userflow.md, tasks.md. Setiap dokumen harus lengkap, markdown mandiri.`;
}

function buildGeneratePrompt(body) {
  const { brief = {}, language = 'id', template = '', mode = 'generate', reasoning = 'low', polish = false } = body;
  const langName = language === 'en' ? 'English' : 'Bahasa Indonesia';
  const depth = (body.depth === 'advanced' || (brief.features || '').length > 200) ? 'advanced' : 'simple';
  const maxLen = depth === 'advanced'
    ? 'Setiap dokumen: 12.000–18.000 karakter, sangat mendalam, siap dikerjakan developer.'
    : 'Setiap dokumen: 1.500–5.000 karakter, padat dan actionable.';
  const reason = reasoning === 'minimal' ? 'Answer directly, minimal deliberation.'
    : reasoning === 'low' ? 'Moderate reasoning.'
    : reasoning === 'medium' ? 'Think carefully about trade-offs.'
    : reasoning === 'high' ? 'Deep reasoning with explicit trade-off analysis.'
    : 'Maximum reasoning depth; explore alternatives explicitly.';
  const task = mode === 'revise' ? 'You are revising the existing documents below.' : 'You are creating a full product planning pack from a brief.';
  const polishInstr = polish ? 'Finally polish everything: keep all documents consistent with each other (same terminology, same feature names, aligned scope).' : '';
  return [
    `You are PRD Foundry, a product planning engine. ${task}`,
    `Write the planning pack in ${langName}.`,
    `Template direction: ${template || 'generic SaaS'}.`,
    maxLen,
    reason,
    polishInstr,
    '',
    '## Brief',
    briefText(brief, language),
    '',
    '## Required output',
    docInstructions(language),
    'Do not add text outside the markers.',
  ].join('\n');
}

function buildFollowupPrompt(body) {
  const { brief = {}, language = 'id' } = body;
  return [
    `You are a product coach. Read this brief and ask UP TO 3 sharp clarifying questions that materially change the resulting plan.`,
    `Respond with ONLY a JSON array of strings, e.g. ["Question 1", "Question 2"]. Write the questions in ${language === 'en' ? 'English' : 'Bahasa Indonesia'}.`,
    '',
    '## Brief',
    briefText(brief, language),
  ].join('\n');
}

function buildConsistencyPrompt(body) {
  const { brief = {}, documents = {}, language = 'id' } = body;
  const docsBlock = DOCS.map(f => `--- ${f} ---\n${(documents[f] || '').slice(0, 12000)}`).join('\n\n');
  return [
    `You are a strict plan consistency reviewer. Compare the four documents below against each other and against the brief.`,
    `Find real inconsistencies: conflicting scope, renamed features, contradictory user flows, mismatched tech assumptions, missing pieces. Ignore trivial style issues.`,
    `Respond with ONLY a JSON array of issue objects, max 8: [{"severity":"critical"|"warning"|"info","file":"prd.md"|"design.md"|"userflow.md"|"tasks.md","detail":"..."}]`,
    `Write detail in ${language === 'en' ? 'English' : 'Bahasa Indonesia'}. If everything is consistent, return [].`,
    '',
    '## Brief',
    briefText(brief, language),
    '',
    '## Documents',
    docsBlock,
  ].join('\n');
}

function buildRevisePrompt(body) {
  const { brief = {}, documents = {}, language = 'id', file, section, instruction } = body;
  const heading = section?.heading || '(unknown section)';
  return [
    `You are revising one section of a planning document.`,
    `File: ${file}. Section heading: "${heading}".`,
    `User instruction: "${instruction}".`,
    `Rewrite ONLY that section's markdown content (no heading prefix needed — the heading stays). Respond with ONLY the replacement markdown, nothing else.`,
    `Keep the same style as the rest of the document. Write in ${language === 'en' ? 'English' : 'Bahasa Indonesia'}.`,
    '',
    '## Current section body',
    (section?.body || '').slice(0, 8000),
    '',
    '## Project brief',
    briefText(brief, language),
  ].join('\n');
}

function buildAssistPrompt(body) {
  const { brief = {}, documents = {}, language = 'id', message } = body;
  const docsBlock = DOCS.map(f => `--- ${f} ---\n${(documents[f] || '').slice(0, 6000)}`).join('\n\n');
  return [
    `You are an AI planning assistant embedded in PRD Foundry. Answer the user's question about their product plan. Be concrete and reference the documents. Write in ${language === 'en' ? 'English' : 'Bahasa Indonesia'}.`,
    '',
    '## Brief',
    briefText(brief, language),
    '',
    '## Documents',
    docsBlock,
    '',
    `## User question`,
    message,
  ].join('\n');
}

async function hFollowup(body) {
  const { provider = {}, brief = {}, language = 'id' } = body;
  const bad = checkTarget(provider.baseUrl);
  if (bad) return { status: 400, json: { error: bad } };
  try {
    const data = await upstreamJson(provider.baseUrl, provider.apiKey, '/chat/completions', {
      model: provider.model, messages: [
        { role: 'system', content: buildFollowupPrompt({ brief, language }) },
        { role: 'user', content: 'Generate the follow-up questions now.' },
      ], temperature: 0.4, max_tokens: 400,
    }, AbortSignal.timeout(45000));
    const raw = data?.choices?.[0]?.message?.content || '[]';
    let questions = [];
    try { questions = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch { /* fallback below */ }
    if (!Array.isArray(questions) || !questions.length) {
      questions = raw.split('\n').map(s => s.replace(/^\s*[-*\d.\]]+\s*/, '').trim()).filter(s => s.length > 8).slice(0, 3);
    }
    return { status: 200, json: { questions: questions.slice(0, 3), usage: usageOf(data?.usage) } };
  } catch (err) {
    return { status: 500, json: { error: err.message || 'Permintaan gagal. / Request failed.' } };
  }
}

async function hConsistency(body) {
  const { provider = {}, brief = {}, documents = {}, language = 'id' } = body;
  const bad = checkTarget(provider.baseUrl);
  if (bad) return { status: 400, json: { error: bad } };
  try {
    const data = await upstreamJson(provider.baseUrl, provider.apiKey, '/chat/completions', {
      model: provider.model, messages: [
        { role: 'system', content: buildConsistencyPrompt({ brief, documents, language }) },
        { role: 'user', content: 'Run the consistency review now.' },
      ], temperature: 0.2, max_tokens: 1500,
    }, AbortSignal.timeout(60000));
    const raw = data?.choices?.[0]?.message?.content || '[]';
    let issues = [];
    try { issues = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch { /* fallback */ }
    if (!Array.isArray(issues)) issues = [];
    issues = issues.filter(i => i && typeof i.file === 'string' && DOCS.includes(i.file))
      .map(i => ({ severity: ['critical', 'warning', 'info'].includes(i.severity) ? i.severity : 'info', file: i.file, detail: String(i.detail || '').slice(0, 500) }));
    return { status: 200, json: { issues, usage: usageOf(data?.usage) } };
  } catch (err) {
    return { status: 500, json: { error: err.message || 'Permintaan gagal. / Request failed.' } };
  }
}

async function hRevise(body) {
  const { provider = {}, brief = {}, documents = {}, language = 'id', file, section, instruction } = body;
  const bad = checkTarget(provider.baseUrl);
  if (bad) return { status: 400, json: { error: bad } };
  try {
    const data = await upstreamJson(provider.baseUrl, provider.apiKey, '/chat/completions', {
      model: provider.model, messages: [
        { role: 'system', content: buildRevisePrompt({ brief, documents, language, file, section, instruction }) },
        { role: 'user', content: 'Output the replacement section markdown now.' },
      ], temperature: 0.3, max_tokens: 3000,
    }, AbortSignal.timeout(90000));
    const replacement = (data?.choices?.[0]?.message?.content || '').trim();
    if (!replacement) return { status: 500, json: { error: 'Model tidak mengembalikan revisi. / The model returned no revision.' } };
    return { status: 200, json: { proposal: { file, section: section || null, replacement }, usage: usageOf(data?.usage) } };
  } catch (err) {
    return { status: 500, json: { error: err.message || 'Permintaan gagal. / Request failed.' } };
  }
}

async function hAssist(body) {
  const { provider = {}, brief = {}, documents = {}, language = 'id', message } = body;
  const bad = checkTarget(provider.baseUrl);
  if (bad) return { status: 400, json: { error: bad } };
  try {
    const data = await upstreamJson(provider.baseUrl, provider.apiKey, '/chat/completions', {
      model: provider.model, messages: [
        { role: 'system', content: buildAssistPrompt({ brief, documents, language, message }) },
        { role: 'user', content: message },
      ], temperature: 0.5, max_tokens: 2500,
    }, AbortSignal.timeout(90000));
    const text = (data?.choices?.[0]?.message?.content || '').trim();
    if (!text) return { status: 500, json: { error: 'Model tidak mengembalikan jawaban. / The model returned no answer.' } };
    return { status: 200, json: { message: text, usage: usageOf(data?.usage) } };
  } catch (err) {
    return { status: 500, json: { error: err.message || 'Permintaan gagal. / Request failed.' } };
  }
}

/* ---------------- generate-stream (SSE) ---------------- */
function sseEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function hGenerateStream(body, res) {
  const { provider = {}, brief = {}, language = 'id', template = '', mode = 'generate', reasoning = 'low', polish = false } = body;
  const bad = checkTarget(provider.baseUrl);
  if (bad) {
    sseEvent(res, 'error', { message: bad });
    res.end();
    return;
  }
  const prompt = buildGeneratePrompt({ brief, language, template, mode, reasoning, polish });
  const messages = [
    { role: 'system', content: prompt },
    { role: 'user', content: 'Generate the complete planning pack now.' },
  ];
  const payload = {
    model: provider.model,
    messages,
    stream: true,
    temperature: reasoning === 'minimal' ? 0.2 : 0.5,
    max_tokens: 16000,
  };
  if (['low', 'medium', 'high'].includes(reasoning)) payload.reasoning_effort = reasoning;

  // queue stage events for every doc upfront
  for (const f of DOCS) sseEvent(res, 'stage', { stage: 'documents', file: f, status: 'generating' });
  sseEvent(res, 'stage', { stage: 'design', status: 'skipped' });

  let upstreamRes;
  try {
    upstreamRes = await fetch(trimSlash(resolveBaseUrl(provider.baseUrl)) + '/chat/completions', {
      method: 'POST',
      headers: bearer(provider.apiKey),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300000),
    });
  } catch (err) {
    sseEvent(res, 'error', { message: `Koneksi ke penyedia gagal. / Provider connection failed. ${err.message}` });
    res.end();
    return;
  }
  if (!upstreamRes.ok || !upstreamRes.body) {
    let msg = `Upstream ${upstreamRes.status}`;
    try { const d = await upstreamRes.json(); msg = d?.error?.message || msg; } catch { /* ignore */ }
    sseEvent(res, 'error', { message: msg });
    res.end();
    return;
  }

  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const docs = {};          // completed docs
  const started = new Set();
  let sawMarker = false;

  const tryParseDoc = () => {
    for (const f of DOCS) {
      if (docs[f]) continue;
      const re = new RegExp(`<!-- PRDFOUNDRY:BEGIN ${f} -->([\\s\\S]*?)<!-- PRDFOUNDRY:END ${f} -->`);
      const m = buf.match(re);
      if (m) {
        docs[f] = m[1].trim();
        sseEvent(res, 'stage', { stage: 'documents', file: f, status: 'done', characters: docs[f].length });
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes('<!-- PRDFOUNDRY:BEGIN')) sawMarker = true;
      tryParseDoc();
    }
  } catch (err) {
    sseEvent(res, 'error', { message: `Stream terputus. / Stream interrupted. ${err.message}` });
    res.end();
    return;
  }

  // final parse attempt on remaining buffer
  tryParseDoc();
  const missing = DOCS.filter(f => !docs[f]);
  if (missing.length) {
    if (sawMarker) {
      // markers present but some docs never closed — dump raw remainder into the last one
      for (const f of missing) {
        docs[f] = buf.includes(`PRDFOUNDRY:BEGIN ${f}`) ? '(generasi terpotong)' : '';
      }
    } else {
      // model ignored the marker format entirely
      sseEvent(res, 'error', { message: 'Model tidak mengikuti format dokumen. Coba lagi atau ganti model. / The model did not follow the document format. Try again or switch models.' });
      res.end();
      return;
    }
  }
  sseEvent(res, 'done', { ...docs });
  res.end();
}

/* ---------------- router ---------------- */
export async function routeApi(pathname, body, res) {
  const p = pathname.replace(/^\/api\/?/, '');
  try {
    switch (p) {
      case 'account/me': return await hAccount();
      case 'models': return await hModels(body);
      case 'model-test': return await hModelTest(body);
      case 'followup': return await hFollowup(body);
      case 'consistency': return await hConsistency(body);
      case 'revise': return await hRevise(body);
      case 'assist': return await hAssist(body);
      case 'generate-stream': {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
        res.flushHeaders?.();
        await hGenerateStream(body, res);
        return null; // stream already written
      }
      case 'register': case 'login': case 'logout': case 'account/update': case 'projects/list': case 'projects/create': case 'projects/update': case 'projects/delete': case 'projects/import': case 'projects/export': {
        return { status: 400, json: { error: 'Akun cloud tidak tersedia di server ini. Mode tamu tetap berfungsi penuh. / Cloud accounts are unavailable on this server. Guest mode works fully.' } };
      }
      default:
        return { status: 404, json: { error: `Unknown endpoint: ${p}` } };
    }
  } catch (err) {
    return { status: 500, json: { error: err.message || 'Permintaan gagal. / Request failed.' } };
  }
}

/* ---------------- static server ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.md': 'text/markdown; charset=utf-8', '.map': 'application/json',
};

async function serveStatic(req, res, root) {
  let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (pathname === '/') pathname = '/index.html';
  let filePath = normalize(join(root, pathname));
  if (!filePath.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }
  try {
    const st = await stat(filePath);
    if (st.isDirectory()) filePath = join(filePath, 'index.html');
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

export function startServer({ port = 9093, root = __dirname } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      console.log(`[api] ${new Date().toISOString()} POST ${url.pathname} from ${req.socket.remoteAddress}`);
      let body = {};
      try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
      } catch { /* empty body */ }
      const result = await routeApi(url.pathname, body, res);
      if (result) {
        res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(result.json));
      }
      return;
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    await serveStatic(req, res, root);
  });
  server.listen(port, '0.0.0.0', () => console.log(`[foundry-proxy] listening on http://0.0.0.0:${port} (ALLOW_PRIVATE=${ALLOW_PRIVATE})`));
  return server;
}

/* Run standalone when executed directly */
if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  startServer({ port: Number(process.env.PORT || 9093) });
}
