#!/bin/bash
# PRD Foundry — jalankan server proxy (static + API) di port 9093.
# Mode produksi: tanpa ALLOW_PRIVATE (SSRF guard aktif, hanya https publik).
# Mode test lokal: ALLOW_PRIVATE=1 MOCK_UPSTREAM=... (lihat mock-openai.mjs)
cd "$(dirname "$0")"
export PORT="${PORT:-9093}"
exec node foundry-proxy.mjs
