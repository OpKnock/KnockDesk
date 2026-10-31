"""Regression tests for repository privacy and archive maintenance tools."""
from __future__ import annotations

import io
import runpy
import tempfile
import unittest
import zipfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_script(name: str) -> dict[str, object]:
    # Maintenance modules should be import-safe: loading them must not scan or
    # extract the whole repository as a side effect.
    with redirect_stdout(io.StringIO()):
        return runpy.run_path(str(ROOT / "scripts" / name))


class MaintenanceToolTests(unittest.TestCase):
    def test_unpack_root_is_derived_from_the_repository_location(self) -> None:
        module = load_script("unpack-all.py")
        self.assertEqual(module["ROOT"], ROOT)

    def test_zip_extraction_rejects_paths_outside_the_destination(self) -> None:
        module = load_script("unpack-all.py")
        with tempfile.TemporaryDirectory() as temporary:
            temporary_path = Path(temporary)
            archive = temporary_path / "unsafe.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("../escaped.txt", "must not escape")
            with self.assertRaises(ValueError):
                module["unpack_zip"](archive)
            self.assertFalse((temporary_path / "escaped.txt").exists())

    def test_env_example_is_included_in_secret_scanning(self) -> None:
        scanner = load_script("secret-scan.py")
        self.assertNotIn(".env.example", scanner["SKIP_NAMES"])
        self.assertIn(
            "resources/hermes-runtime/src/.env.example",
            scanner["DEFAULT_PATHS"],
        )
        findings = scanner["scan_file"](
            ROOT / "resources" / "hermes-runtime" / "src" / ".env.example"
        )
        self.assertEqual(
            findings,
            [],
            "Example configuration must contain placeholders, never live-looking credentials.",
        )

    def test_privacy_scan_detects_windows_paths_with_forward_slashes(self) -> None:
        module = load_script("privacy-scan.py")
        synthetic_path = "C:" + "/" + "Users/" + "privacytest/" + "project"
        with tempfile.TemporaryDirectory() as temporary:
            sample = Path(temporary) / "sample.txt"
            sample.write_text("example = " + repr(synthetic_path) + "\n", encoding="utf-8")
            findings = module["scan"](sample)
        self.assertTrue(
            any(category == "machine-home-path" for _, category in findings),
            "The scanner must detect Windows paths regardless of slash direction.",
        )


if __name__ == "__main__":
    unittest.main()
