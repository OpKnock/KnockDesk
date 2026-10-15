#!/usr/bin/env python3
"""Launch and exercise the maintained Electron + React desktop shell on Windows."""
from __future__ import annotations

import json
import os
import socket
import subprocess
import signal
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "resources" / "hermes-runtime" / "src"
ELECTRON_APP = RUNTIME / "electron"
ELECTRON_DIST = RUNTIME / "node_modules" / "electron" / "dist"
if os.name == "nt":
    ELECTRON_EXE = ELECTRON_DIST / "electron.exe"
elif sys.platform == "darwin":
    ELECTRON_EXE = ELECTRON_DIST / "Electron.app" / "Contents" / "MacOS" / "Electron"
else:
    ELECTRON_EXE = ELECTRON_DIST / "electron"
VENDOR_MODULES = ROOT / "resources" / "app.asar.unpacked" / "node_modules"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_for_cdp(port: int, process: subprocess.Popen[bytes], timeout: float = 30) -> None:
    deadline = time.monotonic() + timeout
    url = f"http://127.0.0.1:{port}/json/version"
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Electron exited early with code {process.returncode}")
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    json.loads(response.read())
                    return
        except (OSError, urllib.error.URLError, json.JSONDecodeError) as error:
            last_error = error
        time.sleep(0.25)
    raise TimeoutError(f"Electron DevTools did not become ready: {last_error}")


def stop_process(process: subprocess.Popen[bytes] | None) -> None:
    if not process or process.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
            )
        else:
            # Electron is launched in its own session to permit safe tree cleanup.
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=2)
    except (OSError, subprocess.TimeoutExpired):
        process.kill()


def main() -> int:
    if not ELECTRON_EXE.is_file():
        raise SystemExit(f"Electron binary is missing: {ELECTRON_EXE}")
    renderer = ELECTRON_APP / "dist" / "renderer" / "desktop.html"
    if not renderer.is_file():
        raise SystemExit(f"Desktop renderer has not been built: {renderer}")

    port = free_port()
    env = os.environ.copy()
    env.update({
        "KNOCKDESK_SMOKE_MODE": "1",
        "KNOCKDESK_NODE_MODULES": str(VENDOR_MODULES),
        "NODE_ENV": "production",
    })
    paths = [str(VENDOR_MODULES), str(RUNTIME / "node_modules"), env.get("NODE_PATH", "")]
    env["NODE_PATH"] = os.pathsep.join(value for value in paths if value)

    log_file = tempfile.NamedTemporaryFile(prefix="knockdesk-smoke-", suffix=".log", delete=False)
    log_path = Path(log_file.name)
    process: subprocess.Popen[bytes] | None = None
    page_errors: list[str] = []
    try:
        process = subprocess.Popen(
            [
                str(ELECTRON_EXE),
                f"--remote-debugging-port={port}",
                "--remote-allow-origins=*",
                str(ELECTRON_APP),
            ],
            cwd=ELECTRON_APP,
            env=env,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
            start_new_session=os.name != "nt",
        )
        log_file.close()
        wait_for_cdp(port, process)

        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
            try:
                contexts = browser.contexts
                if not contexts:
                    raise RuntimeError("Electron exposed no browser context")
                context = contexts[0]
                deadline = time.monotonic() + 15
                page = None
                while time.monotonic() < deadline:
                    for candidate in context.pages:
                        if candidate.url.startswith("file://") and "renderer/desktop.html" in candidate.url:
                            page = candidate
                            break
                    if page:
                        break
                    time.sleep(0.2)
                if page is None:
                    raise RuntimeError("KnockDesk renderer page did not open")
                page.on("pageerror", lambda error: page_errors.append(str(error)))
                page.wait_for_selector(".kd-app", timeout=15000)
                if page.title() != "KnockDesk":
                    raise AssertionError(f"Unexpected window title: {page.title()!r}")
                heading = page.locator(".welcome-row h1").inner_text()
                if "Make room for" not in heading:
                    raise AssertionError(f"Dashboard heading missing: {heading!r}")
                navigation = page.get_by_role("navigation", name="Main navigation")
                for label in ("Overview", "AI Assistant", "Sessions", "AgentTown", "Memory", "System health"):
                    if navigation.get_by_role("button", name=label).count() == 0:
                        raise AssertionError(f"Navigation item missing: {label}")

                # Scope duplicate button names to the actual navigation landmark.
                navigation.get_by_role("button", name="System health").click()
                page.get_by_text("Device report").wait_for(timeout=5000)
                page.get_by_text("logical Processors", exact=False).wait_for(timeout=5000)
                page.wait_for_timeout(500)
                if page_errors:
                    raise AssertionError("Renderer JavaScript errors: " + " | ".join(page_errors))
                print("PASS: Electron launched the source-owned KnockDesk renderer.")
                print("PASS: Overview, navigation, IPC-backed system diagnostics and error-free render verified.")
                return 0
            finally:
                browser.close()
    except (AssertionError, RuntimeError, TimeoutError, PlaywrightError) as error:
        print(f"FAIL: {error}")
        try:
            log_file.flush()
        except (OSError, ValueError):
            pass
        try:
            print(log_path.read_text(encoding="utf-8", errors="replace")[-6000:])
        except OSError:
            pass
        return 1
    finally:
        try:
            log_file.close()
        except (OSError, ValueError):
            pass
        stop_process(process)
        try:
            log_path.unlink(missing_ok=True)
        except OSError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
