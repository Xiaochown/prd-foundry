# PRD Foundry — Live Deployment

Salinan lengkap PRD Foundry, di-mirror dari https://43.173.2.188/ dan di-deploy.

## Live URL
**https://xiaochown.github.io/prd-foundry/**

## Repo
**https://github.com/Xiaochown/prd-foundry** (public, master)

## Status Verifikasi (Playwright headless E2E — 14/16 PASS)
- ✅ Home load: "PRDFoundry — A little clarity. A big beginning."
- ✅ Bilingual UI (ID/EN toggle)
- ✅ 19 tombol interaktif di home
- ✅ Contoh workspace ("Bloom — a calmer way to build habits") bisa dibuka
- ✅ View Kanvas (Figma-like canvas)
- ✅ View Dokumen (PRD/Desain/Alur/Tugas — 4 dokumen)
- ✅ Route #/interview (interview mode)
- ✅ Route #/review (review mode)
- ✅ localStorage projects tersimpan (foundry.projects, theme, lang)
- ✅ Mobile viewport (390px) render OK
- ⚠️ "Provider" keyword tidak muncul di home text (panel settings, bukan bug)
- ⚠️ 501/405 POST = app coba connect AI provider tanpa API key (expected, bukan error app)

## Fitur yang Teridentifikasi (dari analisis bundle + E2E)
1. **Custom AI Provider** — OpenAI-compatible base URL + API key, SSE streaming,
   validasi provider (auth failed, model mismatch, redirect, local/private block)
2. **Workspace Figma-like** — kanvas + dokumen, pan canvas, select/move dokumen
3. **4 dokumen per proyek** — PRD, Desain, Alur Pengguna, Tugas (4/4 siap)
4. **AI modes** — generate, revise, assist (chat), consistency check, followup questions
5. **Interview mode** — tanya-jawab sebelum generate
6. **Review mode** — review hasil
7. **Bilingual ID/EN** — full i18n
8. **Ekspor** — export proyek
9. **Riwayat versi** — version history
10. **Theme light/dark** — localStorage tersimpan
11. **Storage lokal** — proyek tersimpan di perangkat (privacy-first, tanpa backend)

## Teknis
- SPA React murni (Vite build, 447KB JS bundle) — TANPA backend server
- Semua data di localStorage browser (privacy-first, tidak ada server DB)
- Asset lengkap: 108 file (102 font + JS + CSS + HTML + favicon) = 1.3MB
- Hash identik dengan sumber asli (MD5 b7253905...)
- Font: DM Sans, DM Serif Display, IBM Plex Mono

## Struktur
```
/root/prd-foundry-mirror/
├── index.html            (paths sudah relative-fixed utk GH Pages subpath)
├── assets/               (JS bundle, CSS, 102 font files)
├── favicon.svg
├── test_ui.py            (Playwright E2E suite)
├── shots.py              (screenshot hero)
├── tests/                (hasil tes + screenshot)
└── screenshots/          (screenshot buat LinkedIn)
```

## Deploy Notes
- **GH Pages**: repo Xiaochown/prd-foundry, source=master root. Path fix: semua
  `/assets/` → `assets/`, `url(/assets/` → `url(./` (GH Pages subpath issue).
- **Vercel/Railway**: tinggal import repo — static site, no build config needed
  (Vercel auto-detect Vite; output dir default). Butuh login akun Vercel/Railway.
- Screenshot buat LinkedIn: /root/prd-foundry-mirror/screenshots/
- Copy HP: /sdcard/Download/prd-foundry/
