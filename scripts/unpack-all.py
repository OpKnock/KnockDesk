"""Safely extract ZIP/WHL archives and Chromium PAK resources for inspection.

Usage: python scripts/unpack-all.py
Outputs are written beside each archive into <archive>.extracted directories.
Generated extraction directories are skipped on subsequent runs.
"""
from __future__ import annotations

import os
import shutil
import stat
import struct
import sys
import zipfile
from pathlib import Path, PurePosixPath, PureWindowsPath

ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {
    ".git",
    "node_modules",
    "venv",
    ".venv",
    "__pycache__",
    ".next",
    "staging",
}


def out_dir(path: str | Path) -> Path:
    """Return the sibling directory used for an extracted archive."""
    source = Path(path)
    return source.with_name(source.name + ".extracted")


def _safe_zip_target(destination: Path, member_name: str) -> Path:
    """Resolve a ZIP member while rejecting absolute paths and traversal."""
    normalized = member_name.replace("\\", "/")
    posix_path = PurePosixPath(normalized)
    windows_path = PureWindowsPath(member_name)
    parts = posix_path.parts
    if (
        posix_path.is_absolute()
        or windows_path.is_absolute()
        or windows_path.drive
        or any(part in {"..", ""} for part in parts)
    ):
        raise ValueError(f"unsafe ZIP member path: {member_name!r}")

    root = destination.resolve()
    target = destination.joinpath(*parts).resolve()
    if target != root and not target.is_relative_to(root):
        raise ValueError(f"ZIP member escapes the extraction directory: {member_name!r}")
    return target


def unpack_zip(path: str | Path) -> str:
    """Extract a ZIP/WHL after validating every entry before writing anything."""
    archive_path = Path(path)
    destination = out_dir(archive_path)
    with zipfile.ZipFile(archive_path) as bundle:
        corrupt = bundle.testzip()
        if corrupt:
            raise ValueError(f"corrupt archive entry: {corrupt}")

        checked: list[tuple[zipfile.ZipInfo, Path]] = []
        for info in bundle.infolist():
            target = _safe_zip_target(destination, info.filename)
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise ValueError(f"symbolic links are not extracted: {info.filename!r}")
            checked.append((info, target))

        destination.mkdir(parents=True, exist_ok=True)
        for info, target in checked:
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(info, "r") as source, target.open("wb") as output:
                shutil.copyfileobj(source, output)

        return f"zip OK ({len(checked)} entries)"


def parse_pak(data: bytes) -> tuple[list[tuple[int, int]], int]:
    """Parse Chromium DataPack v4/v5 resource offsets with bounds checks."""
    if len(data) < 8:
        raise ValueError("too small")
    version = struct.unpack_from("<I", data, 0)[0]
    if version not in (4, 5):
        raise ValueError(f"unknown version {version}")
    encoding = data[4]
    resource_count = struct.unpack_from("<H", data, 5)[0]
    entries: list[tuple[int, int]] = []

    if version == 4:
        table_end = 8 + resource_count * 6
        if len(data) < table_end:
            raise ValueError("truncated v4 resource table")
        offset = 8
        for _ in range(resource_count):
            resource_id, resource_offset = struct.unpack_from("<HI", data, offset)
            entries.append((resource_id, resource_offset))
            offset += 6
    else:
        if len(data) < 9:
            raise ValueError("truncated v5 header")
        alias_count = struct.unpack_from("<H", data, 7)[0]
        table_end = 9 + resource_count * 6 + alias_count * 4
        if len(data) < table_end:
            raise ValueError("truncated v5 resource or alias table")
        offset = 9
        for _ in range(resource_count):
            resource_id, resource_offset = struct.unpack_from("<HI", data, offset)
            entries.append((resource_id, resource_offset))
            offset += 6
        aliases: list[tuple[int, int]] = []
        for _ in range(alias_count):
            alias_id, entry_index = struct.unpack_from("<HH", data, offset)
            aliases.append((alias_id, entry_index))
            offset += 4
        for alias_id, entry_index in aliases:
            if entry_index >= len(entries):
                raise ValueError(f"invalid v5 alias index: {entry_index}")
            entries.append((alias_id, entries[entry_index][1]))

    if entries:
        for _, resource_offset in entries:
            if resource_offset < table_end or resource_offset > len(data):
                raise ValueError(f"resource offset outside payload: {resource_offset}")
    return entries, encoding


def unpack_pak(path: str | Path) -> str:
    """Extract PAK resources to numbered binary files and write a manifest."""
    pak_path = Path(path)
    data = pak_path.read_bytes()
    entries, encoding = parse_pak(data)
    destination = out_dir(pak_path)
    destination.mkdir(parents=True, exist_ok=True)

    offsets = sorted({offset for _, offset in entries})
    bounds = {
        offset: offsets[index + 1] if index + 1 < len(offsets) else len(data)
        for index, offset in enumerate(offsets)
    }
    manifest = destination / "manifest.txt"
    with manifest.open("w", encoding="utf-8", newline="\n") as output:
        output.write(
            f"source: {pak_path.name}\nversion-bytes: {data[:8].hex()}\n"
            f"encoding: {encoding}\nentries: {len(entries)}\n\n"
        )
        output.write("id\toffset\tsize\tfile\n")
        for resource_id, resource_offset in sorted(entries):
            end = bounds[resource_offset]
            filename = f"{resource_id}.bin"
            (destination / filename).write_bytes(data[resource_offset:end])
            output.write(
                f"{resource_id}\t{resource_offset}\t{end - resource_offset}\t{filename}\n"
            )
    return f"pak OK ({len(entries)} entries)"


def collect_archives() -> tuple[list[Path], list[Path]]:
    """Collect targets once, ignoring generated extraction trees."""
    zip_files: list[Path] = []
    pak_files: list[Path] = []
    for current, directories, filenames in os.walk(ROOT):
        directories[:] = [
            name for name in directories
            if name not in SKIP_DIRS
            and not name.endswith(".extracted")
            and not name.endswith("-unpacked")
        ]
        for filename in filenames:
            path = Path(current) / filename
            suffix = path.suffix.lower()
            if suffix in {".zip", ".whl"}:
                zip_files.append(path)
            elif suffix == ".pak":
                pak_files.append(path)
    return sorted(zip_files), sorted(pak_files)


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    zip_files, pak_files = collect_archives()
    succeeded = 0
    failed: list[tuple[Path, str]] = []
    print(f"Targets: {len(zip_files)} ZIP/WHL archives, {len(pak_files)} PAK files")

    for path in zip_files:
        try:
            result = unpack_zip(path)
            print(f"OK   {path.relative_to(ROOT)} -> {result}")
            succeeded += 1
        except (OSError, ValueError, zipfile.BadZipFile, RuntimeError) as error:
            failed.append((path, str(error)))
            print(f"FAIL {path.relative_to(ROOT)}: {str(error)[:200]}")

    for index, path in enumerate(pak_files, start=1):
        try:
            result = unpack_pak(path)
            if index <= 5 or index % 100 == 0:
                print(f"OK   {path.relative_to(ROOT)} -> {result}")
            succeeded += 1
        except (OSError, ValueError, struct.error) as error:
            failed.append((path, str(error)))
            print(f"FAIL {path.relative_to(ROOT)}: {str(error)[:200]}")

    print(f"Completed: {succeeded} succeeded, {len(failed)} failed.")
    if failed:
        print("Some files could not be unpacked; confirm Git LFS payloads and formats.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
