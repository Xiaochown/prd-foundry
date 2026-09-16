#!/usr/bin/env python3
"""Tes UI penuh PRD Foundry via Playwright headless."""
import json, os, sys, time
from playwright.sync_api import sync_playwright

OUT = "/root/prd-foundry-mirror/tests"
os.makedirs(OUT, exist_ok=True)
BASE = "http://127.0.0.1:8099/prd-foundry/"
results = []

def log(name, ok, detail=""):
    results.append({"test": name, "ok": bool(ok), "detail": str(detail)[:300]})
    print(f"[{'PASS' if ok else 'FAIL'}] {name} {detail}")

with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path="/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux-arm64/chrome-headless-shell",
        args=["--no-sandbox", "--disable-gpu", "--use-gl=swiftshader", "--disable-gpu-sandbox", "--disable-dev-shm-usage", "--no-zygote"],
    )
    page = browser.new_page(viewport={"width": 1440, "height": 900})

    # 1. Home load
    errs = []
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(BASE, wait_until="domcontentloaded", timeout=20000)
    time.sleep(3)
    log("home_load", "PRDFoundry" in page.title(), page.title())
    page.screenshot(path=f"{OUT}/01-home.png", full_page=True)

    # 2. Cek struktur halaman
    body_text = page.inner_text("body")
    for kw in ["PRDFoundry", "workspace", "Provider", "Mulai", "Buat"]:
        log(f"home_kw_{kw}", kw.lower() in body_text.lower())

    # 3. Klik tombol utama (cari yang bisa diklik)
    buttons = page.locator("button, a.btn, [role=button]").all_inner_texts()
    log("buttons_found", len(buttons) > 3, f"{len(buttons)} buttons: {buttons[:8]}")

    # 4. Coba buka contoh workspace (Explore an example workspace)
    example_btn = page.get_by_text("Jelajahi contoh workspace")
    if example_btn.count() > 0:
        example_btn.first.click(timeout=5000)
        time.sleep(3)
        page.screenshot(path=f"{OUT}/02-example-workspace.png", full_page=True)
        log("example_workspace", "/workspace/" in page.url or "workspace" in page.url, page.url)
        # Simpan konten workspace
        ws_text = page.inner_text("body")[:2000]
        with open(f"{OUT}/workspace_text.txt", "w") as f:
            f.write(ws_text)
        log("workspace_content", len(ws_text) > 200, f"{len(ws_text)} chars")
        # Screenshot kanvas vs dokumen
        for view in ["Kanvas", "Dokumen"]:
            vbtn = page.get_by_text(view, exact=True)
            if vbtn.count() > 0:
                vbtn.first.click(timeout=3000)
                time.sleep(1.5)
                page.screenshot(path=f"{OUT}/03-view-{view}.png", full_page=True)
                log(f"view_{view}", True)
    else:
        log("example_workspace", False, "tombol tidak ditemukan")

    # 5. Navigasi hash routes
    for route in ["#/interview", "#/review", "#/workspace/demo"]:
        try:
            page.goto(f"{BASE}/{route}", wait_until="domcontentloaded", timeout=12000)
            time.sleep(1.5)
            page.screenshot(path=f"{OUT}/04-route-{route.replace('/','_')}.png", full_page=True)
            log(f"route_{route}", "Cannot GET" not in page.inner_text("body")[:200], page.url)
        except Exception as e:
            log(f"route_{route}", False, str(e)[:150])

    # 6. Cek localStorage / provider config
    ls = page.evaluate("() => { const o={}; for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i); o[k]=localStorage.getItem(k).slice(0,100);} return o; }")
    log("localstorage_keys", len(ls) > 0, json.dumps(ls)[:300])

    # 7. Konsol error?
    real_errs = [e for e in errs if "favicon" not in e and "404" not in e]
    log("no_console_errors", len(real_errs) == 0, f"{len(real_errs)} errors: {real_errs[:3]}")

    browser.close()

# Tulis hasil JSON
with open(f"{OUT}/results.json", "w") as f:
    json.dump(results, f, indent=2, ensure_ascii=False)

passed = sum(1 for r in results if r["ok"])
print(f"\n=== {passed}/{len(results)} PASS ===")
