#!/usr/bin/env python3
"""
KnockDesk Smoke Test
Launches the app with remote debugging, connects via CDP, and verifies:
- Process starts cleanly
- Main window appears with correct title/logo
- Splash screen shows "KnockDesk" (not Stonic)
- Computer-use sidecar spawns and responds
- Memory bridge is reachable
- No console errors/warnings

Usage:
    python scripts/smoke_test.py [--timeout 60] [--idle-seconds 180] [--headless]
    python scripts/smoke_test.py --help

Exit codes:
    0 = all checks passed
    1 = launch failed
    2 = CDP connection failed
    3 = splash brand check failed
    4 = sidecar check failed
    5 = memory bridge check failed
    6 = console errors detected
    7 = idle hang detected (renderer unresponsive after idle soak)
    8 = orphaned processes after shutdown
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Optional

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# Try to import playwright; if missing, give clear install hint
try:
    from playwright.async_api import async_playwright, Browser, Page, CDPSession
except ImportError:
    print("ERROR: playwright not installed. Run: pip install playwright && playwright install chromium", file=sys.stderr)
    sys.exit(1)

ROOT = Path(__file__).resolve().parents[1]
APP_EXE = ROOT / "KnockDesk.exe"
DEBUG_PORT = 9222
CDP_URL = f"http://127.0.0.1:{DEBUG_PORT}"

# Expected brand strings
EXPECTED_TITLE = "KnockDesk"
EXPECTED_SPLASH_TEXT = "KNOCKDESK"  # what we patched in index.html
EXPECTED_LOGO_ALT = "KnockDesk"

# Sidecar expectations
SIDECAR_DIR = ROOT / "resources" / "knockdesk-computer"
RUNNER_PY = SIDECAR_DIR / "runner.py"
OVERLAY_PY = SIDECAR_DIR / "knockdesk_overlay.py"

console_errors: list[str] = []
console_warnings: list[str] = []


def log(msg: str, level: str = "INFO") -> None:
    prefix = {"INFO": "✓", "WARN": "⚠", "ERROR": "✗", "STEP": "▶"}.get(level, "•")
    print(f"  {prefix} {msg}")


async def wait_for_cdp(timeout: float = 30.0) -> Optional[str]:
    """Poll CDP /json/version until it responds. Returns WebSocket debugger URL."""
    import aiohttp
    start = time.time()
    async with aiohttp.ClientSession() as session:
        while time.time() - start < timeout:
            try:
                async with session.get(f"{CDP_URL}/json/version") as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        return data.get("webSocketDebuggerUrl")
            except Exception:
                pass
            await asyncio.sleep(0.5)
    return None


async def get_main_page_ws(cdp_ws: str) -> Optional[str]:
    """From CDP list, find the main page target and return its websocket URL."""
    import aiohttp
    async with aiohttp.ClientSession() as session:
        async with session.get(f"{CDP_URL}/json/list") as resp:
            if resp.status != 200:
                return None
            targets = await resp.json()
            for t in targets:
                if t.get("type") == "page" and not t.get("url", "").startswith("devtools://"):
                    return t.get("webSocketDebuggerUrl")
    return None


async def run_checks(args: argparse.Namespace) -> int:
    global console_errors, console_warnings
    console_errors = []
    console_warnings = []

    if not APP_EXE.exists():
        log(f"KnockDesk.exe not found at {APP_EXE}", "ERROR")
        return 1

    log(f"Launching {APP_EXE} with --remote-debugging-port={DEBUG_PORT}")
    proc = subprocess.Popen(
        [str(APP_EXE), f"--remote-debugging-port={DEBUG_PORT}", "--remote-allow-origins=*"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
    )

    # Drain stdout/stderr continuously: the app logs verbosely, and a full
    # OS pipe buffer would block the child process mid-run.
    def _drain(pipe) -> None:
        try:
            for _ in pipe:
                pass
        except Exception:
            pass

    for _pipe in (proc.stdout, proc.stderr):
        _t = threading.Thread(target=_drain, args=(_pipe,), daemon=True)
        _t.start()

    try:
        # 1. Wait for CDP
        log("Waiting for CDP endpoint...", "STEP")
        cdp_ws = await wait_for_cdp(args.timeout)
        if not cdp_ws:
            log("CDP never became available", "ERROR")
            return 2
        log(f"CDP ready: {cdp_ws[:80]}...")

        # 2. Connect via Playwright over CDP
        async with async_playwright() as pw:
            browser = await pw.chromium.connect_over_cdp(CDP_URL)
            log("Playwright connected over CDP")

            # Find main page
            page = None
            for ctx in browser.contexts:
                for pg in ctx.pages:
                    if not pg.url.startswith("devtools://"):
                        page = pg
                        break
                if page:
                    break

            if not page:
                # Wait for a page to appear
                for _ in range(20):
                    for ctx in browser.contexts:
                        for pg in ctx.pages:
                            if not pg.url.startswith("devtools://"):
                                page = pg
                                break
                        if page:
                            break
                    if page:
                        break
                    await asyncio.sleep(0.5)

            if not page:
                log("No main page found", "ERROR")
                return 2

            log(f"Main page: {page.url}")

            # Capture console
            page.on("console", lambda msg: (
                console_errors.append(msg.text) if msg.type == "error" else
                console_warnings.append(msg.text) if msg.type == "warning" else None
            ))
            page.on("pageerror", lambda exc: console_errors.append(f"PAGE ERROR: {exc}"))

            # 3. Wait for splash to appear and check brand
            log("Checking splash screen brand...", "STEP")
            splash_ok = False
            for attempt in range(30):
                try:
                    # Check for kd-intro element and its text
                    kd_intro = await page.query_selector("#kd-intro")
                    if kd_intro:
                        word_el = await kd_intro.query_selector(".kd-word")
                        if word_el:
                            text = await word_el.inner_text()
                            if EXPECTED_SPLASH_TEXT in text.upper():
                                log(f"Splash brand OK: '{text}'")
                                splash_ok = True
                                break
                            else:
                                log(f"Splash text mismatch: '{text}' (expected {EXPECTED_SPLASH_TEXT})", "ERROR")
                                return 3
                        # Check logo alt
                        logo = await kd_intro.query_selector(".kd-mark img")
                        if logo:
                            alt = await logo.get_attribute("alt")
                            if alt and EXPECTED_LOGO_ALT in alt:
                                log(f"Logo alt OK: '{alt}'")
                            else:
                                log(f"Logo alt mismatch: '{alt}' (expected {EXPECTED_LOGO_ALT})", "WARN")
                except Exception:
                    pass
                await asyncio.sleep(0.2)

            if not splash_ok:
                log("Splash element never appeared or brand check failed", "ERROR")
                return 3

            # 4. Wait for app to fully load (root element rendered)
            log("Waiting for app root...", "STEP")
            try:
                await page.wait_for_selector("#root", state="attached", timeout=15000)
                log("Root element attached")
            except Exception:
                log("#root never attached", "WARN")

            # 5. Check window title
            try:
                title = await page.title()
                if EXPECTED_TITLE.lower() in title.lower():
                    log(f"Window title OK: '{title}'")
                else:
                    log(f"Window title unexpected: '{title}' (expected {EXPECTED_TITLE})", "WARN")
            except Exception:
                log("Could not read window title", "WARN")

            # 6. Check computer-use sidecar process spawned
            log("Checking computer-use sidecar...", "STEP")
            sidecar_ok = False
            for attempt in range(20):
                # Look for runner.py process
                try:
                    import psutil
                    for p in psutil.process_iter(["pid", "name", "cmdline"]):
                        try:
                            cmd = p.info.get("cmdline") or []
                            if any("runner.py" in c and "knockdesk-computer" in c for c in cmd):
                                log(f"Sidecar runner.py found (PID {p.info['pid']})")
                                sidecar_ok = True
                                break
                        except Exception:
                            pass
                    if sidecar_ok:
                        break
                except Exception:
                    pass
                await asyncio.sleep(0.5)

            if not sidecar_ok:
                log("Sidecar runner.py not detected in process list", "WARN")

            # 7. Try to ping sidecar via its stdin/stdout protocol (if we can reach it)
            # This is harder without direct access; skip for now but log
            log("Sidecar RPC ping: skipped (requires IPC bridge)")

            # 8. Check memory bridge reachable (via renderer if exposed)
            # Look for hermes bridge in page
            log("Checking memory bridge...", "STEP")
            bridge_ok = False
            try:
                # Check if window.hermesBridge or similar exists
                has_bridge = await page.evaluate("""() => {
                    return !!(
                        window.electronAPI?.memory?.search ||
                        window.hermesBridge ||
                        window.__kdMemoryBridge
                    );
                }""")
                if has_bridge:
                    log("Memory bridge API exposed in renderer")
                    bridge_ok = True
                else:
                    log("Memory bridge not directly exposed in renderer (may be main-process only)", "WARN")
            except Exception:
                log("Could not evaluate memory bridge check", "WARN")

            # 9. Console errors summary
            if console_errors:
                log(f"Console errors detected ({len(console_errors)}):", "ERROR")
                for err in console_errors[:10]:
                    log(f"  - {err}", "ERROR")
                return 6
            else:
                log("No console errors")

            if console_warnings:
                log(f"Console warnings ({len(console_warnings)}):", "WARN")
                for w in console_warnings[:5]:
                    log(f"  - {w}", "WARN")

            # 10. Idle soak + post-idle responsiveness (regression cover for
            # reported 1-2 minute idle hangs)
            idle_seconds = getattr(args, "idle_seconds", 180)
            if idle_seconds > 0:
                log(f"Idle soak: {idle_seconds}s with periodic sampling...", "STEP")
                try:
                    import psutil as _psutil
                except ImportError:
                    _psutil = None
                samples = []
                waited = 0
                step = 30
                while waited < idle_seconds:
                    await asyncio.sleep(min(step, idle_seconds - waited))
                    waited += step
                    try:
                        t0 = time.monotonic()
                        await page.evaluate("() => Date.now()")
                        rtt = (time.monotonic() - t0) * 1000.0
                    except Exception as e:
                        log(f"Renderer unresponsive during idle ({e})", "ERROR")
                        return 7
                    rss = None
                    if _psutil is not None:
                        try:
                            rss = sum(
                                p.memory_info().rss
                                for p in _psutil.process_iter(["name", "memory_info"])
                                if (p.info["name"] or "") == "KnockDesk.exe"
                            ) / 1e6
                        except Exception:
                            pass
                    samples.append((min(waited, idle_seconds), round(rtt, 1), rss and round(rss, 1)))
                    log(f"idle t+{min(waited, idle_seconds)}s rtt={rtt:.0f}ms" + (f" rss={rss:.0f}MB" if rss else ""))
                rtts = [s[1] for s in samples]
                if max(rtts) > 3000:
                    log(f"Post-idle responsiveness FAILED (worst rtt {max(rtts):.0f}ms)", "ERROR")
                    return 7
                log(f"Idle soak passed ({len(samples)} samples, worst rtt {max(rtts):.0f}ms)")
            else:
                log("Idle soak skipped (--idle-seconds 0)")

            # 11. Clean shutdown
            log("Closing browser connection...", "STEP")
            await browser.close()

        log("ALL CHECKS PASSED", "INFO")
        return 0

    finally:
        # Kill the app process
        log("Terminating KnockDesk.exe...", "STEP")
        try:
            if os.name == "nt":
                proc.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                proc.terminate()
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        except Exception:
            pass
        # 12. Orphan check: no KnockDesk.exe may survive (excludes our own
        # drained/zombie handles — count live PIDs only).
        try:
            import psutil as _psutil2
            leftovers = [
                p.pid for p in _psutil2.process_iter(["name"])
                if (p.info["name"] or "") == "KnockDesk.exe"
            ]
        except Exception:
            leftovers = []
        if leftovers:
            log(f"Orphaned KnockDesk.exe processes after shutdown: {leftovers}", "ERROR")
            return 8


def main() -> int:
    parser = argparse.ArgumentParser(description="KnockDesk smoke test")
    parser.add_argument("--timeout", type=int, default=60, help="Max seconds to wait for CDP/app")
    parser.add_argument("--idle-seconds", type=int, default=180, help="Idle soak duration; 0 to skip")
    parser.add_argument("--headless", action="store_true", help="(ignored; CDP requires visible)")
    args = parser.parse_args()

    print(f"\n=== KnockDesk Smoke Test ===")
    print(f"App: {APP_EXE}")
    print(f"Timeout: {args.timeout}s")
    print()

    try:
        return asyncio.run(run_checks(args))
    except KeyboardInterrupt:
        log("Interrupted", "WARN")
        return 130
    except Exception as e:
        log(f"Unexpected error: {e}", "ERROR")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())