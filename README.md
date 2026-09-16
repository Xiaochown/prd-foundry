# PRD Foundry — Live Deployment + Backend Proxy

Salinan lengkap PRD Foundry, di-mirror dari https://43.173.2.188/ dan di-deploy.

## ⚠️ PENTING: GitHub Pages TIDAK bisa menjalankan fitur AI

PRD Foundry adalah SPA React yang butuh **backend proxy same-origin** (`/api/*`) untuk
fitur AI-nya (ambit model, tes koneksi, generate 4 dokumen, followup, konsistensi,
revisi, assist chat). GitHub Pages cuma serve file statis → semua request `/api/*`
404 → "fetch failed" / "Invalid server response".

**Solusi: jalankan versi live lewat `foundry-proxy.mjs`** (server Node tanpa dependency)
yang serve static + implement semua endpoint `/api/*` sebagai proxy ke provider
OpenAI-compatible mana pun (key dikirim dari browser, tidak disimpan di server).

## Live URL (proxy aktif)

**https://pop-delays-liver-jacob.trycloudflare.com/** (quick tunnel — URL ganti tiap restart)

## Cara jalanin

```bash
# 1. Server (static + API) — port 9093
cd /root/prd-foundry-mirror
bash run.sh                      # foreground; atau jalankan sebagai background process

# 2. Tunnel publik (opsional, kalau mau diakses dari luar)
bash tunnel.sh                   # background: /root/.9router/bin/cloudflared tunnel --url http://127.0.0.1:9093
```

Mode produksi: SSRF guard aktif (hanya https endpoint publik; localhost/private IP diblokir).
Mode test lokal (mock provider):

```bash
ALLOW_PRIVATE=1 MOCK_UPSTREAM='mock.example.com|http://127.0.0.1:9199' PORT=9093 node foundry-proxy.mjs
node mock-openai.mjs   # TEST-ONLY mock OpenAI provider (port 9199)
```

## Endpoint yang diimplementasikan (kontrak sama persis dengan server asli)

| Endpoint | Fungsi |
|---|---|
| `POST /api/account/me` | `{user:null}` — mode tamu (hapus warning "Akun belum dapat dimuat") |
| `POST /api/models` | Proxy GET `{baseUrl}/models` → `{models:[...]}` |
| `POST /api/model-test` | Ping chat completion → `{verified, requestedModel, reportedModel, latencyMs}` |
| `POST /api/generate-stream` | SSE: `stage` (progress per dokumen) → `done` `{prd.md, design.md, userflow.md, tasks.md}` / `error` |
| `POST /api/followup` | `{questions:[...], usage}` |
| `POST /api/consistency` | `{issues:[{severity,file,detail}], usage}` |
| `POST /api/revise` | `{proposal:{file, section, replacement}, usage}` |
| `POST /api/assist` | `{message, usage}` |
| `register/login/projects/*` | 400 "Akun cloud tidak tersedia di server ini. Mode tamu berfungsi penuh." |

## Pitfall trycloudflare (penting!)

**trycloudflare mengganti response HTTP 502 dari origin dengan error page Cloudflare**
(HTML "Bad gateway"), bukan meneruskan JSON error-nya. Semua error upstream di proxy ini
sengaja pakai status **500** (bukan 502) biar JSON error-nya sampai ke aplikasi.
Jangan ubah kembali ke 502 kalau tetap mau dipasang di belakang quick tunnel.

## Verifikasi

- E2E Playwright 10/10 PASS (lokal + lewat tunnel publik): interview → hubungkan AI →
  fetch models → tes respons ("Penyedia mengonfirmasi …") → generate 4 dokumen → zero console error.
- Script: `/tmp/prd-e2e.py` (disimpan di repo sebagai `tests/e2e-proxy/` hasilnya)

## Teknis

- `foundry-proxy.mjs` — server Node murni (http + fetch global, tanpa npm dependency),
  jalan di Node ≥ 18. Bisa dipakai standalone, di VPS, atau diadaptasi ke Vercel
  serverless functions (ingat batas durasi function Hobby 10s — kurang cocok buat
  generate-stream panjang).
- `mock-openai.mjs` — TEST-ONLY mock provider (jangan dipakai produksi).
- SPA React murni (Vite build, 447KB JS bundle) di `index.html` + `assets/`.

## Repo

**https://github.com/Xiaochown/prd-foundry** (public, master)
GitHub Pages statis (tanpa AI): **https://xiaochown.github.io/prd-foundry/**
