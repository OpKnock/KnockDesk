"""Security regression tests: SSRF guard, profile names, ffmpeg argv, theme CSS.

Covers four hardening seams — if any of these tests fail, a security
regression was (re)introduced:

1. SSRF guard in ``hermes_cli/web_server.py::validate_provider_credential``
   (the ``OPENAI_BASE_URL`` probe): scheme allowlist, metadata-IP/hostname
   refusal, ``ipaddress`` normalization (incl. decimal/octal/hex/IPv6 alt
   forms), loopback still allowed.
2. Profile-name strictness on the ``_profile_setup_command`` path: valid
   identifiers vs. shell-metacharacter payloads.
3. ffmpeg invocation in ``scripts/whatsapp-bridge/bridge.js`` stays
   ``execFileSync``-with-argv based (no shell reinterpretation).
4. Theme asset ``url()`` escaping in ``web/src/themes/context.tsx``: bare
   paths get wrapped, CSS expressions pass through, ``"`` / ``\\`` / ``)``
   are escaped so a hostile theme value cannot break out of ``url("...")``.

Style mirrors ``scripts/test_maintenance_tools.py`` (plain unittest,
``unittest.main()`` entry point). The hermes web server itself cannot be
imported here (fastapi is not vendored), so behavioural tests execute the
real guard code extracted verbatim from ``web_server.py`` (via ``ast`` /
anchored snippet + ``exec``) rather than a hand-written port.
"""

from __future__ import annotations

import ast
import ipaddress
import re
import sys
import textwrap
import unittest
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
WEB_SERVER = ROOT / "resources" / "hermes-runtime" / "src" / "hermes_cli" / "web_server.py"
BRIDGE_JS = (
    ROOT / "resources" / "hermes-runtime" / "src" / "scripts" / "whatsapp-bridge" / "bridge.js"
)
THEME_TSX = ROOT / "resources" / "hermes-runtime" / "src" / "web" / "src" / "themes" / "context.tsx"

SRC_DIR = ROOT / "resources" / "hermes-runtime" / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# (1) SSRF guard — execute the REAL guard snippet from web_server.py
# ---------------------------------------------------------------------------

_GUARD_START = 'url = value.rstrip("/") + "/models"'
_GUARD_END = (
    'and all(p.startswith(("0x", "0X")) or p.isdigit() for p in parts)\n'
    "            ):\n"
    "                return {\"ok\": False, \"reachable\": False, "
    "\"message\": \"Refused unsafe endpoint URL.\"}"
)
_GUARD_MUST_CONTAIN = (
    "169.254.169.254",
    "metadata.google.internal",
    "ipaddress.ip_address(host)",
    "is_link_local",
    "is_reserved",
    "is_multicast",
    # inet_aton-style numeric alias refusal (decimal/hex/octal spellings of
    # link-local / loopback addresses that the OS resolver accepts).
    "0x",
    "isdigit",
)


def _load_ssrf_guard():
    """Compile the verbatim SSRF-guard block into ``_guard_refused(value)``.

    Returns True (refused) when the guard would ``return`` early, False
    (allowed) when execution falls through to the httpx probe. Raises if
    the extraction anchors no longer match — loud failure beats a test
    silently checking the wrong code.
    """
    src = _read(WEB_SERVER)
    start = src.find(_GUARD_START)
    if start == -1:
        raise AssertionError("SSRF guard start anchor not found in web_server.py")
    start = src.rfind("\n", 0, start) + 1  # back up to the line start for dedent
    end = src.find(_GUARD_END, start)
    if end == -1:
        raise AssertionError("SSRF guard end anchor not found in web_server.py")
    snippet = textwrap.dedent(src[start : end + len(_GUARD_END)])
    for marker in _GUARD_MUST_CONTAIN:
        if marker not in snippet:
            raise AssertionError(
                f"SSRF guard extraction looks wrong: {marker!r} missing "
                "(guard was refactored — update the extractor)"
            )
    fn_src = (
        "def _guard_refused(value):\n"
        + textwrap.indent(snippet, "    ")
        + "\n    return None\n"
    )
    namespace: dict = {}
    exec(
        compile(fn_src, "<ssrf-guard>", "exec"),
        {"urlparse": urlparse, "ipaddress": ipaddress},
        namespace,
    )

    def refused(value: str) -> bool:
        return namespace["_guard_refused"](value) is not None

    return refused


_SSRF_REFUSED = _load_ssrf_guard()


class SsrfGuardSourceTests(unittest.TestCase):
    def test_scheme_allowlist_is_http_https_only(self) -> None:
        src = _read(WEB_SERVER)
        self.assertIn('parsed.scheme not in ("http", "https")', src)

    def test_metadata_blocklist_entries_present(self) -> None:
        src = _read(WEB_SERVER)
        for entry in (
            '"169.254.169.254"',
            '"metadata.google.internal"',
        ):
            self.assertIn(entry, src)

    def test_ipaddress_normalization_checks_present(self) -> None:
        src = _read(WEB_SERVER)
        for token in (
            "ipaddress.ip_address(host)",
            "ip.is_link_local",
            "ip.is_reserved",
            "ip.is_multicast",
        ):
            self.assertIn(token, src)

    def test_hostname_is_lowercased_and_trailing_dot_stripped(self) -> None:
        src = _read(WEB_SERVER)
        self.assertIn('(parsed.hostname or "").lower().rstrip(".")', src)


class SsrfGuardBehaviorTests(unittest.TestCase):
    """Behaviour of the real guard code (via _load_ssrf_guard)."""

    def test_non_http_schemes_refused(self) -> None:
        for url in (
            "ftp://example.com/v1/models",
            "file:///etc/passwd",
            "gopher://example.com/",
            "javascript:alert(1)",
            "dict://example.com:11211/",
            "",
        ):
            with self.subTest(url=url):
                self.assertTrue(_SSRF_REFUSED(url), f"{url!r} must be refused")

    def test_metadata_ip_and_hostnames_refused(self) -> None:
        for url in (
            "http://169.254.169.254/",
            "http://169.254.169.254./",  # trailing-dot evasion
            "https://169.254.169.254/latest/meta-data/",
            "HTTP://169.254.169.254/",  # case evasion
            "http://metadata.google.internal/",
            "http://metadata.google.internal./",
            "http://METADATA.GOOGLE.INTERNAL/",
        ):
            with self.subTest(url=url):
                self.assertTrue(_SSRF_REFUSED(url), f"{url!r} must be refused")

    def test_ipv6_link_local_and_multicast_refused(self) -> None:
        for url in (
            "http://[::ffff:169.254.169.254]/",  # IPv4-mapped metadata IP
            "http://[0:0:0:0:0:ffff:a9fe:a9fe]/",
            "http://[fe80::1]/",
            "http://[ff02::1]/",
            "http://224.0.0.1/",
            "http://240.0.0.1/",  # reserved 240/4
        ):
            with self.subTest(url=url):
                self.assertTrue(_SSRF_REFUSED(url), f"{url!r} must be refused")

    def test_decimal_octal_hex_alt_forms_refused(self) -> None:
        # inet_aton-style alt spellings resolve to link-local/loopback at
        # the socket layer (glibc getaddrinfo accepts them) while
        # ipaddress.ip_address() raises ValueError for them. The guard must
        # refuse them explicitly instead of falling through on ValueError.
        for url in (
            "http://2852039166/",  # decimal 169.254.169.254
            "http://0xa9fea9fe/",  # hex 169.254.169.254
            "http://0251.0376.0251.0376/",  # octal 169.254.169.254
            "http://0x7f.0.0.1/",  # hex-part loopback
            "http://2130706433/",  # decimal 127.0.0.1
            "http://0177.0.0.1/",  # octal 127.0.0.1
        ):
            with self.subTest(url=url):
                self.assertTrue(_SSRF_REFUSED(url), f"{url!r} must be refused")

    def test_loopback_and_public_hosts_allowed(self) -> None:
        # Local Ollama / LM Studio / vLLM setups depend on loopback probes.
        for url in (
            "http://127.0.0.1:11434/v1",
            "http://localhost:11434/v1",
            "https://example.com/v1",
            "https://user:pass@example.com/v1",
        ):
            with self.subTest(url=url):
                self.assertFalse(_SSRF_REFUSED(url), f"{url!r} must be allowed")

    def test_ipv6_loopback_is_fail_closed(self) -> None:
        # NOTE: on Python 3.11 ``ipaddress.ip_address("::1").is_reserved``
        # is True, so the guard refuses ``[::1]``. That is fail-closed
        # (safe), just stricter than IPv4 loopback. Pinned here so any
        # future parity change is a deliberate decision, not drift.
        self.assertTrue(_SSRF_REFUSED("http://[::1]:11434/v1"))


# ---------------------------------------------------------------------------
# (2) Profile-name strictness on the _profile_setup_command path
# ---------------------------------------------------------------------------

def _load_profile_setup_command():
    """Compile the real ``_profile_setup_command`` from web_server.py.

    ``_resolve_profile_dir`` is stubbed with the real
    ``profiles.validate_profile_name`` plus a fake existence set, mirroring
    production (validate → 400 on bad names, 404 on unknown names).
    """
    from hermes_cli import profiles as profiles_mod

    src = _read(WEB_SERVER)
    tree = ast.parse(src)
    node = next(
        n
        for n in ast.walk(tree)
        if isinstance(n, ast.FunctionDef) and n.name == "_profile_setup_command"
    )
    segment = ast.get_source_segment(src, node)
    if segment is None:
        raise AssertionError("could not extract _profile_setup_command source")

    class _Http404(Exception):
        pass

    existing = {"default", "dev", "my-profile_2", "a", "x" * 64, "abc123"}

    def _resolve_profile_dir(name: str):  # noqa: N802 (matches production name)
        profiles_mod.validate_profile_name(name)
        if profiles_mod.normalize_profile_name(name) not in existing:
            raise _Http404(f"Profile {name!r} does not exist.")
        return Path("/fake") / name

    namespace: dict = {"re": re, "_resolve_profile_dir": _resolve_profile_dir}
    exec(compile(segment, "<profile-setup-command>", "exec"), namespace, namespace)
    return namespace["_profile_setup_command"], profiles_mod, _Http404


_PROFILE_SETUP_COMMAND, _PROFILES_MOD, _HTTP404 = _load_profile_setup_command()

_VALID_NAMES = ["default", "dev", "a", "my-profile_2", "x" * 64, "abc123"]
_SHELL_METACHAR_PAYLOADS = [
    "foo;rm -rf /",
    "$(evil)",
    "`evil`",
    "a|b",
    "a&b",
    "a b",
    "a\nb",
    "../x",
    "../../etc",
    "a/b",
    "a.b",
    "UPPER",
    "Foo",
    "",
    "-lead",
    "_lead",
    "a" * 65,  # over the 64-char limit
    "a$HOME",
    "a'b",
    'a"b',
    "a\\b",
    "a*b",
    "a?b",
]


class ProfileNameStrictnessTests(unittest.TestCase):
    def test_valid_names_accepted(self) -> None:
        for name in _VALID_NAMES:
            with self.subTest(name=name):
                _PROFILES_MOD.validate_profile_name(name)  # must not raise
                if name == "default":
                    self.assertEqual(_PROFILE_SETUP_COMMAND(name), "hermes setup")
                else:
                    self.assertEqual(_PROFILE_SETUP_COMMAND(name), f"{name} setup")

    def test_shell_metachar_payloads_rejected(self) -> None:
        for name in _SHELL_METACHAR_PAYLOADS:
            with self.subTest(name=name):
                with self.assertRaises(
                    ValueError, msg=f"{name!r} must be rejected as a profile name"
                ):
                    _PROFILES_MOD.validate_profile_name(name)
                with self.assertRaises(
                    ValueError, msg=f"{name!r} must be rejected by _profile_setup_command"
                ):
                    _PROFILE_SETUP_COMMAND(name)

    def test_reserved_names_rejected_on_setup_path(self) -> None:
        # "hermes" passes the bare id-shape regex but must still be refused
        # via validate_profile_name's reserved-name list in the resolver.
        for name in ("hermes", "test", "tmp", "root", "sudo"):
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    _PROFILE_SETUP_COMMAND(name)

    def test_unknown_but_wellformed_name_does_not_build_a_command(self) -> None:
        with self.assertRaises(_HTTP404):
            _PROFILE_SETUP_COMMAND("no-such-profile")

    def test_inline_regex_matches_profiles_module(self) -> None:
        src = _read(WEB_SERVER)
        match = re.search(
            r"def _profile_setup_command.*?re\.fullmatch\((r?\"[^\"]+\"|r?'[^']+')",
            src,
            re.DOTALL,
        )
        self.assertIsNotNone(match, "inline profile-id regex not found")
        inline_pattern = ast.literal_eval(match.group(1))
        module_pattern = _PROFILES_MOD._PROFILE_ID_RE.pattern
        # Inline uses fullmatch (no ^$ anchors); module uses match (^...$).
        self.assertEqual(f"^{inline_pattern}$", module_pattern)

    def test_validation_precedes_interpolation(self) -> None:
        src = _read(WEB_SERVER)
        segment_start = src.index("def _profile_setup_command")
        segment = src[segment_start : src.index("\n\n\n", segment_start)]
        raise_pos = segment.index("raise ValueError")
        resolve_pos = segment.index("_resolve_profile_dir(name)")
        interp_pos = segment.index("f\"{name} setup\"")
        self.assertLess(raise_pos, resolve_pos)
        self.assertLess(resolve_pos, interp_pos)
        for dangerous in ("shell=True", "os.system", "os.popen", "eval(", "exec("):
            self.assertNotIn(dangerous, segment)


# ---------------------------------------------------------------------------
# (3) ffmpeg argv construction in bridge.js stays execFileSync-based
# ---------------------------------------------------------------------------

class FfmpegArgvTests(unittest.TestCase):
    def test_exec_file_sync_imported_from_child_process(self) -> None:
        src = _read(BRIDGE_JS)
        self.assertRegex(
            src,
            r"import\s*\{\s*execFileSync\s*\}\s*from\s*['\"]child_process['\"]",
        )

    def test_no_shell_spawning_apis(self) -> None:
        src = _read(BRIDGE_JS)
        for pattern, label in (
            (r"(?<![A-Za-z])exec\s*\(", "exec("),
            (r"(?<![A-Za-z])execSync\s*\(", "execSync("),
            (r"(?<![A-Za-z])spawn\s*\(", "spawn("),
            (r"(?<![A-Za-z])spawnSync\s*\(", "spawnSync("),
            (r"shell\s*:\s*true", "shell:true"),
            (r"ffmpeg\s*`", "ffmpeg template string"),
            (r"['\"]ffmpeg\s+['\"]?\s*\+", "ffmpeg string concatenation"),
        ):
            with self.subTest(api=label):
                self.assertIsNone(
                    re.search(pattern, src),
                    f"bridge.js must not use shell API {label}",
                )

    def test_ffmpeg_invoked_with_argv_array(self) -> None:
        src = _read(BRIDGE_JS)
        match = re.search(
            r"execFileSync\(\s*['\"]ffmpeg['\"]\s*,\s*\[(?P<argv>.*?)\]",
            src,
            re.DOTALL,
        )
        self.assertIsNotNone(match, "execFileSync('ffmpeg', [...]) call not found")
        argv = match.group("argv")
        for flag in ("-y", "-i", "libopus", "48000"):
            self.assertIn(flag, argv)
        # Sender-controlled paths travel as argv elements, never inside a
        # command string.
        self.assertIn("filePath", argv)
        self.assertIn("tmpPath", argv)

    def test_conversion_is_time_bound(self) -> None:
        src = _read(BRIDGE_JS)
        call_start = src.index("execFileSync(")
        call_end = src.index(");", call_start)
        call = src[call_start:call_end]
        self.assertIn("timeout", call)


# ---------------------------------------------------------------------------
# (4) Theme CSS url() escaping
# ---------------------------------------------------------------------------

# Exact Python port of the `wrap` closure inside `assetVars` in
# web/src/themes/context.tsx. Behavioural tests run against this port; the
# source-consistency tests below pin the port to the real implementation.
_THEME_PASSTHROUGH = re.compile(
    r"(?:url\(|linear-gradient|radial-gradient|conic-gradient|none$)", re.IGNORECASE
)


def _theme_wrap(value: str) -> str:
    trimmed = value.strip()
    if not trimmed:
        return ""
    if _THEME_PASSTHROUGH.match(trimmed):
        return trimmed
    return (
        'url("'
        + trimmed.replace("\\", "\\\\").replace('"', '\\"').replace(")", "\\29 ")
        + '")'
    )


class ThemeCssUrlSourceTests(unittest.TestCase):
    def test_passthrough_classes_present(self) -> None:
        src = _read(THEME_TSX)
        self.assertIn("url\\(|linear-gradient|radial-gradient|conic-gradient|none$)", src)

    def test_escaping_chain_present(self) -> None:
        src = _read(THEME_TSX)
        for token in (
            '.replace(/\\\\/g, "\\\\\\\\")',
            '.replace(/"/g, \'\\\\"\')',
            '"\\\\29 "',
            'url("${',
        ):
            self.assertIn(token, src)


class ThemeCssUrlBehaviorTests(unittest.TestCase):
    def test_bare_paths_wrapped(self) -> None:
        cases = {
            "images/bg.png": 'url("images/bg.png")',
            "/assets/bg.png": 'url("/assets/bg.png")',
            "https://example.com/bg.png": 'url("https://example.com/bg.png")',
            "data:image/png;base64,AAAA": 'url("data:image/png;base64,AAAA")',
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(_theme_wrap(raw), expected)

    def test_css_expressions_pass_through(self) -> None:
        for raw in (
            'url("images/bg.png")',
            "url(images/bg.png)",
            "url('images/bg.png')",
            "linear-gradient(red, blue)",
            "radial-gradient(circle, red, blue)",
            "conic-gradient(red, blue)",
            "none",
            "URL(images/bg.png)",
            "LINEAR-GRADIENT(red, blue)",
        ):
            with self.subTest(raw=raw):
                self.assertEqual(_theme_wrap(raw), raw.strip())

    def test_hostile_values_cannot_break_out(self) -> None:
        # Quote breakout: `"); ...` must arrive backslash-escaped, and the
        # `)` additionally becomes `\29 `, so the wrapping url("...")
        # string stays intact.
        self.assertEqual(
            _theme_wrap('x"); } body { color: red; } /*'),
            'url("x\\"\\29 ; } body { color: red; } /*")',
        )
        # Paren breakout: `)` becomes the CSS escape `\29 `.
        self.assertEqual(_theme_wrap("a)b"), 'url("a\\29 b")')
        # Backslash smuggling: `\` is doubled first (order matters).
        self.assertEqual(_theme_wrap("a\\b"), 'url("a\\\\b")')
        # Combined payload, exact escape sequence.
        self.assertEqual(_theme_wrap('a"b)c\\d'), 'url("a\\"b\\29 c\\\\d")')

    def test_empty_values_dropped(self) -> None:
        for raw in ("", "   ", "\t\n"):
            with self.subTest(raw=repr(raw)):
                self.assertEqual(_theme_wrap(raw), "")

    def test_whitespace_trimmed_before_wrapping(self) -> None:
        self.assertEqual(_theme_wrap("  images/bg.png  "), 'url("images/bg.png")')


if __name__ == "__main__":
    unittest.main(verbosity=2)
