#!/usr/bin/env python3
"""Scan first-party KnockDesk files for accidental contact/path leaks.

Only file path, line number and category are printed, never the address or local
username itself. Third-party and generated trees are excluded.
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEXT_SUFFIXES = {
    ".css",
    ".html",
    ".js",
    ".json",
    ".md",
    ".mjs",
    ".py",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
}
EMAIL = re.compile(
    r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b",
    re.IGNORECASE,
)
HOME_PATHS = (
    re.compile(r"(?i)\b[A-Z]:\\Users\\([^\\\s\"'<>$%{}]+)"),
    re.compile(r"(?i)(?:^|[\s\"'=(])/(?:home|Users)/([^/\s\"'<>$%{}]+)"),
)
GENERIC_USERS = {
    "user",
    "users",
    "username",
    "yourname",
    "your_name",
    "example",
    "someone",
    "placeholder",
    "name",
}
EXAMPLE_DOMAINS = {
    "example.com",
    "example.org",
    "example.net",
    "localhost",
    "invalid",
}
MAX_FILE_BYTES = 2 * 1024 * 1024
TARGETS = (
    "README.md",
    "NOTICE.md",
    "package.json",
    ".github",
    "docs",
    "scripts",
    "resources/hermes-runtime/src/electron/main.ts",
    "resources/hermes-runtime/src/electron/desktop-preload.js",
    "resources/hermes-runtime/src/electron/services/desktop-hermes-runtime.js",
    "resources/hermes-runtime/src/electron/services/desktop-agenttown-runtime.js",
    "resources/hermes-runtime/src/web/src/desktop",
    "resources/hermes-plugins/knockdesk",
    "resources/hermes-plugins/knockdesk-memory",
    "resources/hermes-plugins/knockdesk-computer",
    "resources/knockdesk-computer",
)


def iter_files(target: Path):
    if target.is_file():
        yield target
        return
    if not target.is_dir():
        return
    for current, dirs, filenames in os.walk(target):
        dirs[:] = [
            name
            for name in dirs
            if name not in {
                ".git",
                "node_modules",
                "__pycache__",
                ".next",
                "dist",
                "build",
            }
        ]
        for name in filenames:
            candidate = Path(current) / name
            if candidate.suffix.lower() in TEXT_SUFFIXES:
                try:
                    if candidate.stat().st_size <= MAX_FILE_BYTES:
                        yield candidate
                except OSError:
                    continue


def scan(path: Path) -> list[tuple[int, str]]:
    try:
        content = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []
    findings: list[tuple[int, str]] = []
    for number, line in enumerate(content.splitlines(), start=1):
        for match in EMAIL.finditer(line):
            domain = match.group(0).rsplit("@", 1)[-1].lower()
            if domain not in EXAMPLE_DOMAINS:
                findings.append((number, "email-address"))
        for pattern in HOME_PATHS:
            match = pattern.search(line)
            if match and match.group(1).strip().lower() not in GENERIC_USERS:
                value = match.group(1).strip().lower()
                if not value.startswith(("$", "%", "{", "<")):
                    findings.append((number, "machine-home-path"))
    return findings


def main() -> int:
    seen: set[Path] = set()
    findings_total = 0
    for relative_path in TARGETS:
        for path in iter_files(ROOT / relative_path):
            resolved = path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            for line, category in scan(path):
                print(f"{path.relative_to(ROOT).as_posix()}:{line} [{category}]")
                findings_total += 1
    print(f"Scanned {len(seen)} first-party text files; findings: {findings_total}")
    if findings_total:
        print("Review matches manually; upstream legal attribution should not be deleted.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
