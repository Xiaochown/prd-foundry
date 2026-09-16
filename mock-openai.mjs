#!/usr/bin/env node
/**
 * TEST-ONLY mock OpenAI-compatible provider for PRD Foundry E2E verification.
 * Serves:
 *   GET  /v1/models            -> model list
 *   POST /v1/chat/completions  -> non-stream ping / SSE stream of a full planning pack
 * Run: node mock-openai.mjs (port 9199)
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 9199);
const MODELS = ['mock-mini', 'mock-pro'];

function packDocs(lang = 'id') {
  const t = lang === 'en'
    ? { 'prd.md': '## Overview\nA habit tracker for students.\n\n## Goals\n- Daily check-ins\n- Gentle reminders', 'design.md': '# Design\n## Palette\n- sage green, calm editorial', 'userflow.md': '# User Flow\n## Onboarding\n1. Sign up\n2. Pick habits', 'tasks.md': '# Tasks\n## Sprint 1\n- [ ] Auth (3d)\n- [ ] Habit CRUD (4d)' }
    : { 'prd.md': '## Ringkasan\nAplikasi habit tracker untuk pelajar.\n\n## Tujuan\n- Check-in harian\n- Pengingat lembut', 'design.md': '# Desain\n## Palet\n- sage green, kalem editorial', 'userflow.md': '# Alur Pengguna\n## Onboarding\n1. Daftar\n2. Pilih kebiasaan', 'tasks.md': '# Tugas\n## Sprint 1\n- [ ] Auth (3 hari)\n- [ ] CRUD kebiasaan (4 hari)' };
  return t;
}

function sseData(chunks) {
  return chunks.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: MODELS.map(id => ({ id, object: 'model' })) }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
    const lang = /Bahasa Indonesia|Bahasa/.test(JSON.stringify(body.messages)) ? 'id' : 'en';
    if (body.stream) {
      const docs = packDocs(lang);
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.write(sseData([
        { event: '', data: { id: 'cmpl-mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] } },
        ...['prd.md', 'design.md', 'userflow.md', 'tasks.md'].map(f => ({
          event: '', data: { id: 'cmpl-mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: `<!-- PRDFOUNDRY:BEGIN ${f} -->\n${docs[f]}\n<!-- PRDFOUNDRY:END ${f} -->\n\n` }, finish_reason: null }] },
        })),
        { event: '', data: { id: 'cmpl-mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
        { event: '', data: { id: 'cmpl-mock', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 120, completion_tokens: 300, total_tokens: 420 } } },
        { event: '', data: { id: 'cmpl-mock', object: 'chat.completion.chunk', model: body.model, choices: [], finish_reason: 'stop' } },
        { event: '', data: '[DONE]' },
      ]));
      res.end();
      return;
    }
    // non-stream
    const content = JSON.stringify(body.messages).includes('ping')
      ? 'pong'
      : body.messages?.[0]?.content?.includes('consistency')
        ? '[]'
        : body.messages?.[0]?.content?.includes('follow-up')
          ? '["Siapa target utamanya?","Platform apa dulu?"]'
          : body.messages?.[0]?.content?.includes('replacement')
            ? '## Revised section\nUpdated content here.'
            : 'Sure — here is the answer for your plan.';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'cmpl-mock', object: 'chat.completion', model: body.model || 'mock-mini',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
    }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(PORT, '127.0.0.1', () => console.log(`[mock-openai] http://127.0.0.1:${PORT}`));
