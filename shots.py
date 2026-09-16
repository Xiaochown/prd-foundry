#!/usr/bin/env python3
"""Ambil screenshot hero (desktop + mobile) dari PRD Foundry live untuk LinkedIn."""
import os
from playwright.sync_api import sync_playwright

OUT = "/root/prd-foundry-mirror/screenshots"
os.makedirs(OUT, exist_ok=True)
BASE = "https://xiaochown.github.io/prd-foundry/"

with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path="/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux-arm64/chrome-headless-shell",
        args=["--no-sandbox", "--disable-gpu", "--use-gl=swiftshader", "--disable-gpu-sandbox", "--disable-dev-shm-usage", "--no-zygote"],
    )

    # Desktop home
    page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=2)
    page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(4000)
    page.screenshot(path=f"{OUT}/hero-home.png", full_page=False)
    page.screenshot(path=f"{OUT}/hero-home-full.png", full_page=True)

    # Example workspace (kanvas)
    page.get_by_text("Lihat contohnya").first.click(timeout=8000)
    page.wait_for_timeout(4000)
    page.screenshot(path=f"{OUT}/hero-workspace.png", full_page=False)

    # Mobile home
    mob = browser.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    mob.goto(BASE, wait_until="domcontentloaded", timeout=30000)
    mob.wait_for_timeout(4000)
    mob.screenshot(path=f"{OUT}/hero-mobile.png", full_page=False)

    browser.close()

for f in sorted(os.listdir(OUT)):
    print(f, os.path.getsize(os.path.join(OUT, f)))
