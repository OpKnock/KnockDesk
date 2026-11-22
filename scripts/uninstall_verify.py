#!/usr/bin/env python3
"""
KnockDesk Uninstall Verification
Runs the uninstaller and verifies clean removal:
- App process terminated
- Installation folder cleaned (or only user data remains)
- Registry keys removed
- Start menu / desktop shortcuts gone
- No orphan processes
- User data preserved (optional)

Usage:
    python scripts/uninstall_verify.py [--keep-user-data] [--timeout 120]
    python scripts/uninstall_verify.py --json

Run AFTER the uninstaller has been triggered (or trigger it with --run-uninstaller).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

try:
    import psutil
except ImportError:
    psutil = None

ROOT = Path(__file__).resolve().parents[1]
# Actual install location comes from installer/nsis/knockdesk-setup.nsi
# (InstallDir "$LOCALAPPDATA\KnockDesk"). Legacy guesses are kept for older builds.
INSTALL_DIRS = [
    Path(os.environ.get("LOCALAPPDATA", "")) / "KnockDesk",
    Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "KnockDesk",
    Path(os.environ.get("PROGRAMFILES", "")) / "KnockDesk",
    Path(os.environ.get("PROGRAMFILES(X86)", "")) / "KnockDesk",
]
# App profile: %APPDATA%\knockdesk (Electron userData). The capitalized legacy
# path is kept so older profiles are still reported. Note: the INSTALL
# directory (%LOCALAPPDATA%\KnockDesk) is tracked in INSTALL_DIRS only.
USER_DATA_DIRS = [
    Path(os.environ.get("APPDATA", "")) / "knockdesk",
    Path(os.environ.get("APPDATA", "")) / "KnockDesk",
]
REGISTRY_KEYS = [
    r"HKCU\Software\KnockDesk",
    r"HKLM\Software\KnockDesk",
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\KnockDesk",
    r"HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\KnockDesk",
]
SHORTCUT_DIRS = [
    Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "KnockDesk",
    Path(os.environ.get("USERPROFILE", "")) / "Desktop",
    Path(os.environ.get("USERPROFILE", "")) / "OneDrive" / "Desktop",
    Path(os.environ.get("PUBLIC", "")) / "Desktop",
]
# Patterns safe to match against a full command line. Everything else in the
# process sweep matches process NAMES only (a repo path in a shell's command
# line is not a running app).
CMDLINE_ONLY_PATTERNS = {"runner.py", "knockdesk_overlay", "knockdesk-computer"}

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


def find_uninstaller() -> Path | None:
    """Find the uninstaller executable."""
    # Try common locations
    candidates = [
        Path(os.environ.get("LOCALAPPDATA", "")) / "KnockDesk" / "Uninstall KnockDesk.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "KnockDesk" / "Uninstall KnockDesk.exe",
        Path(os.environ.get("PROGRAMFILES", "")) / "KnockDesk" / "Uninstall KnockDesk.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", "")) / "KnockDesk" / "Uninstall KnockDesk.exe",
    ]
    for c in candidates:
        if c.exists():
            return c
    # Try registry
    try:
        import winreg
        for root_key, subkey in [
            (winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Uninstall"),
            (winreg.HKEY_LOCAL_MACHINE, r"Software\Microsoft\Windows\CurrentVersion\Uninstall"),
        ]:
            with winreg.OpenKey(root_key, subkey, 0, winreg.KEY_READ) as key:
                i = 0
                while True:
                    try:
                        sub = winreg.EnumKey(key, i)
                        i += 1
                        with winreg.OpenKey(key, sub) as sk:
                            display = winreg.QueryValueEx(sk, "DisplayName")[0]
                            if "KnockDesk" in display:
                                uninstall_str = winreg.QueryValueEx(sk, "UninstallString")[0]
                                # Parse the path
                                parts = uninstall_str.split('"')
                                for p in parts:
                                    if p.endswith(".exe") and "uninstall" in p.lower():
                                        return Path(p)
                    except OSError:
                        break
    except Exception:
        pass
    return None


def _protected_pids() -> set[int]:
    """This process plus its ancestors: the kill sweep must never touch them
    (their command lines contain the repo path, which the patterns match)."""
    protected = {os.getpid()}
    if psutil:
        try:
            proc = psutil.Process()
            while True:
                protected.add(proc.pid)
                parent = proc.parent()
                if parent is None or parent.pid in protected:
                    break
                proc = parent
        except Exception:
            pass
    return protected


def kill_processes(name_patterns: list[str]) -> list[int]:
    """Kill processes matching patterns. Return list of PIDs killed."""
    killed = []
    if not psutil:
        return killed
    protected = _protected_pids()
    # Command-line matching is limited to the app's own helper scripts: a bare
    # "KnockDesk"/"hermes" cmdline match also hits shells, editors, and CI
    # agents working inside the repo path.
    cmdline_patterns = [p for p in name_patterns if p in CMDLINE_ONLY_PATTERNS]
    name_only_patterns = [p for p in name_patterns if p not in CMDLINE_ONLY_PATTERNS]
    for proc in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            info = proc.info
            pid = info["pid"]
            if pid in protected:
                continue
            cmd = " ".join(info.get("cmdline") or [])
            name = (info.get("name") or "").lower()
            hit = any(p.lower() in name for p in name_only_patterns) or any(
                p.lower() in cmd.lower() for p in cmdline_patterns
            )
            if hit:
                proc.kill()
                killed.append(pid)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    return killed


def run_checks(args: argparse.Namespace) -> int:
    print(f"\n=== KnockDesk Uninstall Verification ===")
    print(f"Install dirs: {[str(p) for p in INSTALL_DIRS]}")
    print(f"User data dirs: {[str(p) for p in USER_DATA_DIRS]}")
    print()

    # 1. Ensure no app processes running
    print("1. Checking for running processes...")
    patterns = ["KnockDesk", "hermes", "runner.py", "knockdesk_overlay", "knockdesk-computer"]
    killed = kill_processes(patterns)
    if killed:
        add_check("processes_killed", True, f"Killed PIDs: {killed}", "warn")
    else:
        add_check("no_running_processes", True, "No KnockDesk processes found")

    # 2. Find and optionally run uninstaller
    uninstaller = find_uninstaller()
    if args.run_uninstaller and uninstaller and uninstaller.exists():
        print(f"\n2. Running uninstaller: {uninstaller}")
        try:
            proc = subprocess.run(
                [str(uninstaller), "/S"],  # /S = silent for NSIS
                timeout=args.timeout,
                capture_output=True,
            )
            add_check("uninstaller_ran", proc.returncode == 0,
                     f"Exit code: {proc.returncode}" if proc.returncode != 0 else "Completed")
            # Wait a bit for async cleanup
            time.sleep(3)
        except subprocess.TimeoutExpired:
            add_check("uninstaller_timeout", False, f"Uninstaller timed out after {args.timeout}s")
            results["overall"] = "unhealthy"
            return 1
        except Exception as e:
            add_check("uninstaller_error", False, str(e))
            results["overall"] = "unhealthy"
            return 1
    else:
        if args.run_uninstaller and not uninstaller:
            add_check("uninstaller_found", False, "Requested to run the uninstaller but it was not found")
        elif uninstaller:
            add_check("uninstaller_found", True, str(uninstaller))
        else:
            # Nothing to run and nothing found: the uninstaller is already gone,
            # which is the expected state when verifying AFTER an uninstall.
            add_check("uninstaller_found", True, "Not found (OK: verifying after uninstall)", "warn")
        if not args.run_uninstaller:
            print("   (Use --run-uninstaller to execute it)")

    # 3. Verify install directories removed
    print("\n3. Checking installation directories...")
    for d in INSTALL_DIRS:
        exists = d.exists()
        if exists:
            # Check if only user data remains
            try:
                remaining = list(d.rglob("*"))
                if remaining:
                    add_check(f"install_dir_{d.name}", False,
                             f"Directory still exists with {len(remaining)} items")
                else:
                    add_check(f"install_dir_{d.name}", True, "Empty (OK)")
            except Exception:
                add_check(f"install_dir_{d.name}", False, "Exists but cannot read")
        else:
            add_check(f"install_dir_{d.name}", True, "Removed")

    # 4. Verify user data preserved (or removed if not keeping)
    print("\n4. Checking user data directories...")
    for d in USER_DATA_DIRS:
        exists = d.exists()
        if args.keep_user_data:
            add_check(f"user_data_{d.name}", exists,
                     "Preserved" if exists else "Missing (expected to exist)")
        else:
            add_check(f"user_data_{d.name}", not exists,
                     "Removed" if not exists else "Still exists (use --keep-user-data to preserve)")

    # 5. Registry keys
    print("\n5. Checking registry keys...")
    try:
        import winreg

        root_map = {"HKCU": winreg.HKEY_CURRENT_USER, "HKLM": winreg.HKEY_LOCAL_MACHINE}
        for key_path in REGISTRY_KEYS:
            root_name, subkey = key_path.split("\\", 1)
            root = root_map.get(root_name)
            if root is None:
                add_check(f"registry_{key_path}", False, f"Unknown root: {root_name}", "warn")
                continue
            exists = False
            try:
                with winreg.OpenKey(root, subkey, 0, winreg.KEY_READ):
                    exists = True
            except FileNotFoundError:
                pass
            except OSError:
                pass
            key_name = subkey.rsplit("\\", 1)[-1]
            add_check(f"registry_{key_name}", not exists,
                     "Removed" if not exists else "Still present")
    except Exception as e:
        add_check("registry_check", False, f"Error: {e}", "warn")

    # 6. Shortcuts
    print("\n6. Checking shortcuts...")
    for d in SHORTCUT_DIRS:
        if d.exists():
            shortcuts = list(d.glob("*KnockDesk*"))
            shortcuts += list(d.glob("*Stonic*"))  # old brand
            if shortcuts:
                add_check(f"shortcuts_{d.name}", False,
                         f"{len(shortcuts)} shortcut(s) remain: {[s.name for s in shortcuts]}")
            else:
                add_check(f"shortcuts_{d.name}", True, "Clean")
        else:
            add_check(f"shortcuts_{d.name}", True, "Directory not present")

    # 7. Orphan processes (any remaining)
    print("\n7. Final process sweep...")
    remaining = []
    if psutil:
        protected = _protected_pids()
        cmdline_patterns = [p for p in patterns if p in CMDLINE_ONLY_PATTERNS]
        name_only_patterns = [p for p in patterns if p not in CMDLINE_ONLY_PATTERNS]
        for proc in psutil.process_iter(["pid", "name", "cmdline"]):
            try:
                info = proc.info
                if info["pid"] in protected:
                    continue
                cmd = " ".join(info.get("cmdline") or [])
                name = (info.get("name") or "").lower()
                hit = any(p.lower() in name for p in name_only_patterns) or any(
                    p.lower() in cmd.lower() for p in cmdline_patterns
                )
                if hit:
                    remaining.append(f"{info['pid']}: {info['name']}")
            except Exception:
                pass
    add_check("no_orphan_processes", len(remaining) == 0,
             f"Remaining: {remaining}" if remaining else "Clean")

    # Summary
    critical = [k for k, v in results["checks"].items() if v["severity"] == "error" and not v["ok"]]
    warnings = [k for k, v in results["checks"].items() if v["severity"] == "warn" and not v["ok"]]

    if critical:
        results["overall"] = "unhealthy"
        print(f"\n❌ UNINSTALL INCOMPLETE: {', '.join(critical)}")
    elif warnings:
        results["overall"] = "degraded"
        print(f"\n⚠ MINOR ISSUES: {', '.join(warnings)}")
    else:
        results["overall"] = "healthy"
        print(f"\n✅ UNINSTALL VERIFIED CLEAN")

    return 0 if results["overall"] == "healthy" else (1 if results["overall"] == "unhealthy" else 2)


def main() -> int:
    parser = argparse.ArgumentParser(description="KnockDesk uninstall verification")
    parser.add_argument("--run-uninstaller", action="store_true",
                       help="Execute the uninstaller before verification")
    parser.add_argument("--keep-user-data", action="store_true",
                       help="Expect user data directories to be preserved")
    parser.add_argument("--timeout", type=int, default=120,
                       help="Uninstaller timeout in seconds")
    parser.add_argument("--json", action="store_true", help="Output JSON only")
    args = parser.parse_args()

    try:
        exit_code = run_checks(args)
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