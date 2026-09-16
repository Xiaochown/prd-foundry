#!/bin/bash
# PRD Foundry — quick tunnel publik via cloudflared (trycloudflare.com).
# Jalankan SEBAGAI BACKGROUND PROCESS: bash tunnel.sh
exec /root/.9router/bin/cloudflared tunnel --url http://127.0.0.1:9093 --no-autoupdate
