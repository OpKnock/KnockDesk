# KnockDesk Validation Suite

Runtime verification tools for KnockDesk. Run these **on your machine** (or CI) after the app starts.

## Scripts

| Script | Purpose | When to run |
|--------|---------|-------------|
| `smoke_test.py` | Full boot verification via CDP | After every build, before release |
| `health_check.py` | Quick post-launch sanity check | After app starts, in CI, or manually |
| `uninstall_verify.py` | Verify clean uninstall | After running uninstaller |

## Quick Start

```bash
# Install deps
pip install -r scripts/requirements.txt
playwright install --with-deps chromium

# 1. Full smoke test (launch app, verify everything)
python scripts/smoke_test.py --timeout 90

# 2. Quick health check (app already running on port 9222)
python scripts/health_check.py --port 9222 --json

# 3. Verify uninstall
python scripts/uninstall_verify.py --run-uninstaller --keep-user-data
```

## Smoke Test (`smoke_test.py`)

Launches `KnockDesk.exe --remote-debugging-port=9222`, connects via CDP, and verifies:

- ✅ Process starts cleanly
- ✅ Main window appears
- ✅ Splash shows "KNOCKDESK" (not Stonic)
- ✅ Logo alt = "KnockDesk"
- ✅ Computer-use sidecar (`runner.py`) spawns
- ✅ Memory bridge reachable
- ✅ Zero console errors

**Exit codes:**
| Code | Meaning |
|------|---------|
| 0 | All checks passed |
| 1 | Launch failed |
| 2 | CDP connection failed |
| 3 | Splash brand check failed |
| 4 | Sidecar check failed |
| 5 | Memory bridge failed |
| 6 | Console errors detected |
| 130 | Interrupted (Ctrl+C) |

## Health Check (`health_check.py`)

Lightweight check against an **already-running** app on port 9222:

```bash
# Human output
python scripts/health_check.py --port 9222

# Machine output (for CI)
python scripts/health_check.py --port 9222 --json
```

Checks:
- CDP reachable
- Window title = "KnockDesk"
- Splash brand (if visible)
- Logo alt text
- Root element attached
- Console errors/warnings
- Sidecar processes (`runner.py`, `knockdesk_overlay.py`)
- Hermes gateway process
- Memory bridge exposed
- Settings modal opens (Ctrl+,)

**Exit codes:** 0=healthy, 1=unhealthy, 2=degraded, 124=timeout

## Uninstall Verification (`uninstall_verify.py`)

Run **after** uninstaller completes:

```bash
# Verify clean removal (keeps user data)
python scripts/uninstall_verify.py --run-uninstaller --keep-user-data --json

# Full clean (removes user data too)
python scripts/uninstall_verify.py --run-uninstaller --json
```

Checks:
- No KnockDesk processes remain
- Install directories removed
- User data preserved (or removed)
- Registry keys gone
- Start menu / desktop shortcuts gone
- No orphan processes

## CI Integration

The `.github/workflows/ci.yml` runs:

1. **lint-and-typecheck** — Ruff, MyPy, TypeScript, ESLint, Stylelint
2. **asar-integrity** — ASAR readable, brand strings correct, logo present
3. **lfs-check** — All binaries are LFS pointers, .gitattributes complete
4. **smoke-test** — (disabled by default; enable on self-hosted GPU runner)
5. **release-package** — On tagged releases, creates zip + uploads asset
6. **audit** — Python + Node dependency vulnerability scans

### Enable smoke test in CI

Requires a **self-hosted Windows runner with GPU** (for Electron hardware acceleration):

```yaml
# In .github/workflows/ci.yml, change:
smoke-test:
  if: true  # was: false
  runs-on: [self-hosted, windows, gpu]
```

## Requirements

| Tool | Version |
|------|---------|
| Python | 3.11+ |
| Node | 22+ (for CI) |
| Playwright | 1.40+ |
| Windows | 10/11 (for app execution) |

## Troubleshooting

| Issue | Fix |
|-------|-----|
| CDP connection refused | App not launched with `--remote-debugging-port=9222` |
| "Sidecar not found" | `resources/knockdesk-computer/runner.py` missing or Python not in PATH |
| Console errors in smoke test | Check `scripts/smoke_test.py` output for specific errors |
| Uninstaller not found | Run from installed location, or install first |
| Registry check fails | Run PowerShell as Admin for HKLM keys |

## Extending

Add custom checks by editing the scripts — they're pure Python with clear `add_check()` pattern:

```python
add_check("my_check", ok=True, detail="Custom detail", severity="warn")
```

Severity levels: `"error"` (fails overall), `"warn"` (degraded only), `"info"` (informational).