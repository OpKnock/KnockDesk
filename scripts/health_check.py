#!/usr/bin/env python3
"""
KnockDesk Health Check
Post-launch verification script. Run after app starts to confirm:
- Main window responsive
- All brand elements show "KnockDesk"
- Computer-use sidecar alive
- Memory bridge responding
- Hermes gateway running
- No critical console errors

Usage:
    python scripts/health_check.py [--port 9222] [--timeout 30]
    python scripts/health_check.py --json  # machine-readable output

Exit: 0 = healthy, non-zero = issues found
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any

try:
    from playwright.async_api import async_playwright
except ImportError:
    print("ERROR: playwright not installed. Run: pip install playwright && playwright install chromium", file=sys.stderr)
    sys.exit(1)

try:
    import psutil
except ImportError:
    psutil = None

ROOT = Path(__file__).resolve().parents[1]
DEBUG_PORT = 9222
CDP_URL = f"http://127.0.0.1:{DEBUG_PORT}"

results: dict[str, Any] = {
    "timestamp": time.time(),
    "checks": {},
    "overall": "unknown",
}


def add_check(name: str, ok: bool, detail: str = "", severity: str = "error") -> None:
    results["checks"][name] = {
        "ok": ok,
        "detail": detail,
        "severity": severity,
    }
    icon = "✓" if ok else ("⚠" if severity == "warn" else "✗")
    print(f"  {icon} {name}: {detail or ('OK' if ok else 'FAIL')}")


async def run_health_check(args: argparse.Namespace) -> int:
    global DEBUG_PORT, CDP_URL
    DEBUG_PORT = args.port
    CDP_URL = f"http://127.0.0.1:{DEBUG_PORT}"

    print(f"\n=== KnockDesk Health Check ===")
    print(f"CDP: {CDP_URL}")
    print()

    # 1. CDP reachable
    import aiohttp
    cdp_ok = False
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{CDP_URL}/json/version", timeout=aiohttp.ClientTimeout(total=5)) as resp:
                if resp.status == 200:
                    cdp_ok = True
    except Exception as e:
        pass
    add_check("cdp_reachable", cdp_ok, "CDP endpoint responding" if cdp_ok else "CDP not reachable")

    if not cdp_ok:
        results["overall"] = "unhealthy"
        return 1

    # 2. Connect via Playwright
    page = None
    browser = None
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.connect_over_cdp(CDP_URL)
            for ctx in browser.contexts:
                for pg in ctx.pages:
                    if not pg.url.startswith("devtools://"):
                        page = pg
                        break
                if page:
                    break

            if not page:
                for _ in range(10):
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
                add_check("main_page", False, "No main page found")
                results["overall"] = "unhealthy"
                return 1

            # 3. Window title
            try:
                title = await page.title()
                title_ok = "KnockDesk" in title
                add_check("window_title", title_ok, f"Title: '{title}'")
            except Exception as e:
                add_check("window_title", False, f"Error: {e}")

            # 4. Splash brand (if still visible)
            try:
                kd_intro = await page.query_selector("#kd-intro")
                if kd_intro:
                    word_el = await kd_intro.query_selector(".kd-word")
                    if word_el:
                        text = await word_el.inner_text()
                        brand_ok = "KNOCKDESK" in text.upper()
                        add_check("splash_brand", brand_ok, f"Splash text: '{text}'")
                    else:
                        add_check("splash_brand", False, "kd-word element not found")
                else:
                    add_check("splash_brand", True, "Splash already dismissed (normal)")
            except Exception as e:
                add_check("splash_brand", False, f"Error: {e}")

            # 5. Logo alt
            try:
                logo = await page.query_selector(".kd-mark img") or await page.query_selector("nav img[src*='logo']")
                if logo:
                    alt = await logo.get_attribute("alt")
                    alt_ok = alt and "KnockDesk" in alt
                    add_check("logo_alt", alt_ok, f"Alt: '{alt}'" if alt else "No alt attribute")
                else:
                    add_check("logo_alt", False, "Logo element not found", "warn")
            except Exception as e:
                add_check("logo_alt", False, f"Error: {e}", "warn")

            # 6. Root element
            try:
                root = await page.query_selector("#root")
                root_ok = root is not None
                add_check("root_element", root_ok, "Root element attached" if root_ok else "Root not found")
            except Exception as e:
                add_check("root_element", False, f"Error: {e}")

            # 7. Console errors
            errors = []
            warnings = []
            page.on("console", lambda msg: (
                errors.append(msg.text) if msg.type == "error" else
                warnings.append(msg.text) if msg.type == "warning" else None
            ))
            page.on("pageerror", lambda exc: errors.append(f"PAGE ERROR: {exc}"))

            await asyncio.sleep(0.5)  # let any pending console events fire

            error_ok = len(errors) == 0
            add_check("console_errors", error_ok,
                     f"{len(errors)} errors, {len(warnings)} warnings" if errors else "No errors",
                     "warn" if warnings and not errors else "error")

            # 8. Sidecar process
            sidecar_ok = False
            if psutil:
                try:
                    for p in psutil.process_iter(["pid", "cmdline"]):
                        try:
                            cmd = p.info.get("cmdline") or []
                            if any("runner.py" in c and "knockdesk-computer" in c for c in cmd):
                                sidecar_ok = True
                                break
                        except Exception:
                            pass
                except Exception:
                    pass
            add_check("sidecar_runner", sidecar_ok,
                     f"PID found" if sidecar_ok else "runner.py not in process list",
                     "warn" if not sidecar_ok else "error")

            # 9. Overlay process
            overlay_ok = False
            if psutil:
                try:
                    for p in psutil.process_iter(["pid", "cmdline"]):
                        try:
                            cmd = p.info.get("cmdline") or []
                            if any("knockdesk_overlay.py" in c for c in cmd):
                                overlay_ok = True
                                break
                        except Exception:
                            pass
                except Exception:
                    pass
            add_check("overlay_process", overlay_ok,
                     "knockdesk_overlay.py found" if overlay_ok else "overlay not found",
                     "warn")

            # 10. Hermes gateway process
            hermes_ok = False
            if psutil:
                try:
                    for p in psutil.process_iter(["pid", "cmdline", "name"]):
                        try:
                            cmd = p.info.get("cmdline") or []
                            name = p.info.get("name") or ""
                            if any("hermes_cli" in c for c in cmd) or "hermes.exe" in name.lower():
                                hermes_ok = True
                                break
                        except Exception:
                            pass
                except Exception:
                    pass
            add_check("hermes_gateway", hermes_ok,
                     "Hermes gateway process found" if hermes_ok else "Hermes gateway not found",
                     "warn")

            # 11. Memory bridge (attempt to ping via renderer if exposed)
            bridge_ok = False
            try:
                has_bridge = await page.evaluate("""() => {
                    return !!(
                        window.electronAPI?.memory?.search ||
                        window.hermesBridge ||
                        window.__kdMemoryBridge
                    );
                }""")
                bridge_ok = bool(has_bridge)
            except Exception:
                pass
            add_check("memory_bridge_exposed", bridge_ok,
                     "Bridge API in renderer" if bridge_ok else "Bridge not in renderer (may be main-process only)",
                     "warn")

            # 12. Settings window opens (smoke test)
            try:
                await page.keyboard.press("Control+,")
                await asyncio.sleep(0.5)
                settings = await page.query_selector('div[role="dialog"], .settings-modal, [data-testid="settings"]')
                settings_ok = settings is not None
                add_check("settings_modal", settings_ok,
                         "Settings opened via Ctrl+," if settings_ok else "Settings modal not detected",
                         "warn")
                await page.keyboard.press("Escape")
            except Exception:
                add_check("settings_modal", False, "Could not test settings shortcut", "warn")

            # Summary
            critical = [k for k, v in results["checks"].items() if v["severity"] == "error" and not v["ok"]]
            warnings = [k for k, v in results["checks"].items() if v["severity"] == "warn" and not v["ok"]]

            if critical:
                results["overall"] = "unhealthy"
                print(f"\n❌ CRITICAL FAILURES: {', '.join(critical)}")
            elif warnings:
                results["overall"] = "degraded"
                print(f"\n⚠ WARNINGS: {', '.join(warnings)}")
            else:
                results["overall"] = "healthy"
                print(f"\n✅ ALL CHECKS PASSED")

            return 0 if results["overall"] == "healthy" else (1 if results["overall"] == "unhealthy" else 2)

    finally:
        if browser:
            try:
                await browser.close()
            except Exception:
                pass


def main() -> int:
    parser = argparse.ArgumentParser(description="KnockDesk health check")
    parser.add_argument("--port", type=int, default=9222, help="CDP debug port")
    parser.add_argument("--timeout", type=int, default=30, help="Max seconds to wait")
    parser.add_argument("--json", action="store_true", help="Output JSON only")
    args = parser.parse_args()

    try:
        exit_code = asyncio.run(asyncio.wait_for(run_health_check(args), timeout=args.timeout))
    except asyncio.TimeoutError:
        results["overall"] = "timeout"
        exit_code = 124
    except KeyboardInterrupt:
        results["overall"] = "interrupted"
        exit_code = 130
    except Exception as e:
        results["overall"] = "error"
        results["error"] = str(e)
        exit_code = 1

    if args.json:
        print(json.dumps(results, indent=2))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())