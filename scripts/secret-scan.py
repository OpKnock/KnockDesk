"""Scan first-party text sources for likely accidentally committed API keys.

The scanner reports only a redacted match, never the full source line. It skips
vendored runtimes, generated bundles, lockfiles, binary payloads and examples.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {
    ".git", ".next", "node_modules", "site-packages", "venv", ".venv",
    "__pycache__", "dist", "build", "staging", "hermes-runtime/python",
    "python-embedded", "app.asar.unpacked", "agent-town-dist",
}
SKIP_NAMES = {
    ".env.example", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
    "uv.lock", "poetry.lock", "LICENSES.chromium.html",
}
MAX_FILE_BYTES = 2 * 1024 * 1024
PATTERNS = {
    "anthropic": re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}"),
    "openrouter": re.compile(r"sk-or-v1-[A-Za-z0-9]{20,}"),
    "google": re.compile(r"AIza[0-9A-Za-z_-]{25,}"),
    "github": re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"),
    "slack": re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"),
    "openai": re.compile(r"sk-[A-Za-z0-9]{24,}(?![.=/-])"),
}
PLACEHOLDER = re.compile(
    r"YOUR_|EXAMPLE|XXX+|PLACEHOLDER|<.*>|your-.*-here|"
    r"test[-_ ]?key|fake[-_ ]?key|dummy[-_ ]?key",
    re.IGNORECASE,
)
DEFAULT_PATHS = (
    ".github",
    "scripts",
    "resources/hermes-runtime/src/electron",
    "resources/hermes-runtime/src/web/src",
    "resources/knockdesk-computer",
    "resources/hermes-plugins",
    "README.md",
    "index.html",
    "build-electron-main.mjs",
)


def scan_file(path: Path) -> list[tuple[int, str, str]]:
    if path.name in SKIP_NAMES or path.suffix.lower() in {
        ".png", ".jpg", ".jpeg", ".gif", ".ico", ".exe", ".dll",
        ".node", ".bin", ".dat", ".asar", ".jsc", ".wasm", ".onnx",
        ".traineddata", ".zip", ".7z", ".pdf",
    }:
        return []
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            return []
        text = path.read_text(encoding="utf-8", errors="ignore")
    except (OSError, UnicodeError):
        return []
    hits: list[tuple[int, str, str]] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        if PLACEHOLDER.search(line):
            continue
        for kind, pattern in PATTERNS.items():
            match = pattern.search(line)
            if match:
                token = match.group(0)
                suffix = token[-4:] if len(token) >= 4 else "****"
                hits.append((line_number, kind, "****" + suffix))
    return hits


def iter_files(target: Path):
    if target.is_file():
        yield target
        return
    if not target.exists():
        return
    for current, dirs, files in __import__("os").walk(target):
        dirs[:] = [name for name in dirs if name not in SKIP_DIRS]
        for name in files:
            if name not in SKIP_NAMES:
                yield Path(current) / name


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", help="paths relative to repo root (default: first-party source set)")
    args = parser.parse_args()
    targets = [ROOT / value for value in args.paths] if args.paths else [ROOT / value for value in DEFAULT_PATHS]
    hits = 0
    seen: set[Path] = set()
    for target in targets:
        for path in iter_files(target):
            resolved = path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            for line, kind, redacted in scan_file(path):
                try:
                    display = path.relative_to(ROOT).as_posix()
                except ValueError:
                    display = path.name
                print(f"{display}:{line} [{kind}] {redacted}")
                hits += 1
    print(f"Scanned {len(seen)} files; candidate secret hits: {hits}")
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
