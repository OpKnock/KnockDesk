"""
KnockDesk - Agent cursor takeover
=================================

जब agent computer चला रहा हो तो Windows का असली mouse cursor बदल जाता है:
arrow, hand और I-beam की जगह KnockDesk का अपना "agent cursor" आता है (आसमानी
से गहरे नीले का gradient, सफ़ेद किनारा, छोटी सी चमक)। Task ख़त्म होते ही user का
अपना cursor वापस।

Glow और HUD यहाँ नहीं हैं — वह Electron की overlay window में हैं
(electron/services/computer-overlay.js)। यहाँ सिर्फ़ वह एक काम है जो Electron
नहीं कर सकता: system cursor को बदलना (SetSystemCursor)।

क्यों ऐसे:
  - Cursor का *shape* बदलना ही वह चीज़ है जिस से user को लगता है कि
    "यह cursor अब मेरा नहीं, agent का है" — halo या glow से यह एहसास नहीं आता।
  - pyautogui और agent के screenshots पर इस का कोई असर नहीं (screenshot में
    cursor होता ही नहीं)।
  - वापस लाना एक call है: SystemParametersInfo(SPI_SETCURSORS) registry से
    user की अपनी scheme दोबारा load कर देता है। यह तीन जगह होता है:
    task के `finally` में, `atexit` पर, और Electron का backstop (अगर sidecar
    को ज़बरदस्ती मारा गया हो — computer-runtime.js restoreSystemCursors)।

अकेला चला कर देखने के लिए (8 second के लिए cursor बदलता है):
    .venv\\Scripts\\python.exe knockdesk_overlay.py

सिर्फ़ तस्वीरें देखनी हों (cursor बदले बग़ैर):
    .venv\\Scripts\\python.exe knockdesk_overlay.py --preview out_folder
"""

from __future__ import annotations

import atexit
import ctypes
import logging
import os
import platform
import struct
import sys
import tempfile
import threading
from ctypes import wintypes
from typing import Optional, Tuple

from PIL import Image, ImageDraw, ImageFilter

log = logging.getLogger("knockdesk-overlay")

IS_WINDOWS = platform.system() == "Windows"

# ---------------------------------------------------------------- constants
OCR_NORMAL = 32512
OCR_IBEAM = 32513
OCR_HAND = 32649
OCR_APPSTARTING = 32650

IMAGE_CURSOR = 2
LR_LOADFROMFILE = 0x0010
SPI_SETCURSORS = 0x0057

# Design 32-unit canvas पर है; असल pixel size DPI और user की setting से।
DESIGN = 32
SUPERSAMPLE = 4
MIN_PX, MAX_PX = 24, 128

# रंग: ऊपर आसमानी, नीचे गहरा नीला — वही नीला ख़ानदान जो overlay की aura का है।
GRAD_TOP = (120, 205, 255)
GRAD_BOTTOM = (20, 110, 245)
OUTLINE = (255, 255, 255)
SPARK = (255, 255, 255)
SPARK_GLOW = (110, 195, 255)

_lock = threading.Lock()
_swapped = False


if IS_WINDOWS:
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.LoadImageW.restype = wintypes.HANDLE
    user32.LoadImageW.argtypes = [
        wintypes.HINSTANCE, wintypes.LPCWSTR, wintypes.UINT, ctypes.c_int, ctypes.c_int, wintypes.UINT,
    ]
    user32.SetSystemCursor.restype = wintypes.BOOL
    user32.SetSystemCursor.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    user32.SystemParametersInfoW.restype = wintypes.BOOL
    user32.SystemParametersInfoW.argtypes = [wintypes.UINT, wintypes.UINT, ctypes.c_void_p, wintypes.UINT]
    user32.DestroyCursor.argtypes = [wintypes.HANDLE]


# ---------------------------------------------------------------- size
def _cursor_base_size() -> int:
    """User की 'Mouse pointer size' setting (Settings > Accessibility)।"""
    if not IS_WINDOWS:
        return DESIGN
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Control Panel\Cursors") as key:
            value, _ = winreg.QueryValueEx(key, "CursorBaseSize")
            return int(value) or DESIGN
    except Exception:  # noqa: BLE001 — setting न हो तो default
        return DESIGN


def _system_dpi() -> int:
    if not IS_WINDOWS:
        return 96
    try:
        return int(user32.GetDpiForSystem())
    except Exception:  # noqa: BLE001 — पुराना Windows
        return 96


def cursor_pixel_size() -> int:
    px = round(_cursor_base_size() * _system_dpi() / 96.0)
    return max(MIN_PX, min(MAX_PX, px))


# ---------------------------------------------------------------- artwork
def _gradient(size: int) -> Image.Image:
    """ऊपर से नीचे का रंग — पूरे canvas पर, mask से काटा जाता है।"""
    img = Image.new("RGBA", (size, size))
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        r = round(GRAD_TOP[0] + (GRAD_BOTTOM[0] - GRAD_TOP[0]) * t)
        g = round(GRAD_TOP[1] + (GRAD_BOTTOM[1] - GRAD_TOP[1]) * t)
        b = round(GRAD_TOP[2] + (GRAD_BOTTOM[2] - GRAD_TOP[2]) * t)
        for x in range(size):
            px[x, y] = (r, g, b, 255)
    return img


def _dilate(mask: Image.Image, amount: int) -> Image.Image:
    if amount <= 0:
        return mask
    return mask.filter(ImageFilter.MaxFilter(2 * amount + 1))


def _sparkle(draw: ImageDraw.ImageDraw, cx: float, cy: float, r: float, fill) -> None:
    """चार नोक वाला सितारा — 'AI' की चमक।"""
    k = 0.30
    pts = [
        (cx, cy - r), (cx + r * k, cy - r * k), (cx + r, cy), (cx + r * k, cy + r * k),
        (cx, cy + r), (cx - r * k, cy + r * k), (cx - r, cy), (cx - r * k, cy - r * k),
    ]
    draw.polygon(pts, fill=fill)


def _compose(
    px: int,
    body_mask: Image.Image,
    sparkles: list[tuple[float, float, float]],
    scale: float,
) -> Image.Image:
    """Mask (supersampled) से पूरा cursor: साया, सफ़ेद किनारा, gradient, चमक।"""
    S = SUPERSAMPLE
    size = px * S
    u = scale * S  # एक design unit कितने supersampled pixel
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # 1. साया — नीचे दाएँ, नरम
    shadow_mask = _dilate(body_mask, round(0.6 * u)).filter(ImageFilter.GaussianBlur(1.6 * u))
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 118), (round(0.7 * u), round(1.4 * u)), shadow_mask)
    out = Image.alpha_composite(out, shadow)

    # 2. सफ़ेद किनारा — body से ~1 unit बाहर
    rim_mask = _dilate(body_mask, round(1.05 * u))
    rim = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    rim.paste(OUTLINE + (255,), (0, 0), rim_mask)
    out = Image.alpha_composite(out, rim)

    # 3. Gradient body
    body = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    body.paste(_gradient(size), (0, 0), body_mask)
    out = Image.alpha_composite(out, body)

    # 4. हल्की सी gloss ऊपर बाएँ
    gloss = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(gloss)
    gd.ellipse([(-size * 0.25, -size * 0.55), (size * 0.75, size * 0.35)], fill=(255, 255, 255, 70))
    gloss = gloss.filter(ImageFilter.GaussianBlur(2.0 * u))
    glossed = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glossed.paste(gloss, (0, 0), body_mask)
    out = Image.alpha_composite(out, glossed)

    # 5. चमक (sparkles) — पीछे cyan glow, ऊपर सफ़ेद सितारा
    if sparkles:
        glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        gdraw = ImageDraw.Draw(glow)
        for cx, cy, r in sparkles:
            _sparkle(gdraw, cx * u, cy * u, (r + 1.1) * u, SPARK_GLOW + (170,))
        glow = glow.filter(ImageFilter.GaussianBlur(1.1 * u))
        out = Image.alpha_composite(out, glow)
        star = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        sdraw = ImageDraw.Draw(star)
        for cx, cy, r in sparkles:
            _sparkle(sdraw, cx * u, cy * u, r * u, SPARK + (255,))
        out = Image.alpha_composite(out, star)

    return out.resize((px, px), Image.LANCZOS)


def render_arrow(px: int) -> Tuple[Image.Image, Tuple[int, int]]:
    """Agent का arrow। लौटाता है (तस्वीर, hotspot)।"""
    scale = px / DESIGN
    S = SUPERSAMPLE
    u = scale * S
    # macOS के arrow जैसा silhouette (13.5 x 19.4), 1.42x कर के tip (2.2, 2.2) पर
    base = [(0, 0), (0, 16.8), (4.3, 12.7), (7.2, 19.4), (10.4, 18.1), (7.6, 11.5), (13.5, 11.5)]
    pts = [((2.2 + x * 1.42) * u, (2.2 + y * 1.42) * u) for x, y in base]
    mask = Image.new("L", (px * S, px * S), 0)
    ImageDraw.Draw(mask).polygon(pts, fill=255)
    img = _compose(px, mask, [(25.6, 9.2, 4.4), (21.4, 3.9, 2.1)], scale)
    # Hotspot: सफ़ेद किनारे की नोक (body की नोक से ~1 unit ऊपर बाएँ)
    hot = max(0, round(1.15 * scale))
    return img, (hot, hot)


def render_ibeam(px: int) -> Tuple[Image.Image, Tuple[int, int]]:
    """Agent का I-beam (text के ऊपर)। लौटाता है (तस्वीर, hotspot)।"""
    scale = px / DESIGN
    S = SUPERSAMPLE
    u = scale * S
    mask = Image.new("L", (px * S, px * S), 0)
    d = ImageDraw.Draw(mask)
    cx = 15.0
    bar_w, serif_w, serif_h = 2.4, 9.0, 2.4
    top, bottom = 4.2, 27.8
    rr = 1.2 * u
    d.rounded_rectangle([((cx - bar_w / 2) * u, top * u), ((cx + bar_w / 2) * u, bottom * u)], radius=rr, fill=255)
    d.rounded_rectangle([((cx - serif_w / 2) * u, top * u), ((cx + serif_w / 2) * u, (top + serif_h) * u)], radius=rr, fill=255)
    d.rounded_rectangle([((cx - serif_w / 2) * u, (bottom - serif_h) * u), ((cx + serif_w / 2) * u, bottom * u)], radius=rr, fill=255)
    img = _compose(px, mask, [(24.6, 8.2, 3.0)], scale)
    return img, (round(cx * scale), round(16 * scale))


# ---------------------------------------------------------------- .cur file
def write_cur(path: str, img: Image.Image, hotspot: Tuple[int, int]) -> None:
    """RGBA तस्वीर को Windows .cur (32-bit, alpha के साथ) में लिखना।"""
    img = img.convert("RGBA")
    w, h = img.size
    if w > 255 or h > 255:
        raise ValueError("cursor 255px से बड़ा नहीं हो सकता")
    px = img.load()

    xor = bytearray()
    for y in range(h - 1, -1, -1):  # bottom-up
        for x in range(w):
            r, g, b, a = px[x, y]
            xor += bytes((b, g, r, a))

    row_bytes = ((w + 31) // 32) * 4
    and_mask = bytearray()
    for y in range(h - 1, -1, -1):
        row = bytearray(row_bytes)
        for x in range(w):
            if px[x, y][3] == 0:
                row[x // 8] |= 0x80 >> (x % 8)
        and_mask += row

    bih = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, len(xor) + len(and_mask), 0, 0, 0, 0)
    image = bih + bytes(xor) + bytes(and_mask)
    header = struct.pack("<HHH", 0, 2, 1)
    entry = struct.pack("<BBBBHHII", w, h, 0, 0, hotspot[0], hotspot[1], len(image), 6 + 16)
    with open(path, "wb") as f:
        f.write(header + entry + image)


def _cursor_files(px: int) -> Tuple[str, str]:
    """Arrow और I-beam की .cur files (size के हिसाब से cache)।"""
    folder = os.path.join(tempfile.gettempdir(), "knockdesk-agent-cursors")
    os.makedirs(folder, exist_ok=True)
    arrow = os.path.join(folder, f"agent-arrow-{px}.cur")
    ibeam = os.path.join(folder, f"agent-ibeam-{px}.cur")
    if not os.path.exists(arrow):
        img, hot = render_arrow(px)
        write_cur(arrow, img, hot)
    if not os.path.exists(ibeam):
        img, hot = render_ibeam(px)
        write_cur(ibeam, img, hot)
    return arrow, ibeam


# ---------------------------------------------------------------- swap / restore
def _load_cursor(path: str) -> Optional[int]:
    h = user32.LoadImageW(None, path, IMAGE_CURSOR, 0, 0, LR_LOADFROMFILE)
    if not h:
        log.warning("cursor load नहीं हुआ (%s): %s", path, ctypes.get_last_error())
        return None
    return h


def apply_agent_cursors() -> bool:
    """System cursors को agent वाले से बदल दो। कभी throw नहीं करता।"""
    global _swapped
    if not IS_WINDOWS:
        return False
    with _lock:
        try:
            px = cursor_pixel_size()
            arrow, ibeam = _cursor_files(px)
            ok = True
            # SetSystemCursor दिया हुआ handle अपना बना लेता है (और ख़त्म कर
            # देता है), इस लिए हर id के लिए नया load।
            for ident in (OCR_NORMAL, OCR_HAND, OCR_APPSTARTING):
                h = _load_cursor(arrow)
                if not h or not user32.SetSystemCursor(h, ident):
                    ok = False
                    log.warning("SetSystemCursor(%s) fail: %s", ident, ctypes.get_last_error())
            h = _load_cursor(ibeam)
            if not h or not user32.SetSystemCursor(h, OCR_IBEAM):
                ok = False
            _swapped = True
            log.info("Agent cursor लगा (%dpx)", px)
            return ok
        except Exception as err:  # noqa: BLE001 — cursor की वजह से agent न गिरे
            log.warning("agent cursor नहीं लगा: %s", err)
            _swapped = True  # एहतियातन restore फिर भी चलेगा
            return False


def restore_system_cursors() -> bool:
    """User का अपना cursor वापस (registry की scheme दोबारा load)।"""
    global _swapped
    if not IS_WINDOWS:
        return False
    with _lock:
        try:
            ok = bool(user32.SystemParametersInfoW(SPI_SETCURSORS, 0, None, 0))
            if _swapped:
                log.info("System cursor वापस (%s)", "ok" if ok else f"err {ctypes.get_last_error()}")
            _swapped = False
            return ok
        except Exception as err:  # noqa: BLE001
            log.warning("cursor restore fail: %s", err)
            return False


# ---------------------------------------------------------------- controller
class AgentOverlay:
    """
    Task के दौरान agent cursor। वही interface जो runner.py इस्तेमाल करता है:

        overlay = AgentOverlay().start()
        ...
        overlay.stop()
    """

    _atexit_registered = False

    def __init__(self, swap_cursor: bool = True):
        self.swap_cursor = swap_cursor and IS_WINDOWS
        self._started = False

    def start(self) -> "AgentOverlay":
        if self._started:
            return self
        self._started = True
        if self.swap_cursor:
            if not AgentOverlay._atexit_registered:
                atexit.register(restore_system_cursors)
                AgentOverlay._atexit_registered = True
            apply_agent_cursors()
        return self

    def stop(self) -> None:
        if not self._started:
            return
        self._started = False
        if self.swap_cursor:
            restore_system_cursors()

    def __enter__(self) -> "AgentOverlay":
        return self.start()

    def __exit__(self, *exc) -> None:
        self.stop()


# ---------------------------------------------------------------- demo
if __name__ == "__main__":
    import time

    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(levelname)s %(name)s: %(message)s")

    if len(sys.argv) >= 3 and sys.argv[1] == "--preview":
        out = sys.argv[2]
        os.makedirs(out, exist_ok=True)
        for px in (32, 48, 64):
            a, _ = render_arrow(px)
            b, _ = render_ibeam(px)
            a.resize((px * 4, px * 4), Image.NEAREST).save(os.path.join(out, f"arrow-{px}.png"))
            b.resize((px * 4, px * 4), Image.NEAREST).save(os.path.join(out, f"ibeam-{px}.png"))
            write_cur(os.path.join(out, f"arrow-{px}.cur"), *render_arrow(px))
        print(f"तस्वीरें {out} में हैं।")
        sys.exit(0)

    if IS_WINDOWS:
        try:
            ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        except Exception:  # noqa: BLE001
            pass

    seconds = 8
    print(f"KnockDesk agent cursor demo — {seconds} second के लिए। Mouse हिला कर देखें।")
    with AgentOverlay():
        time.sleep(seconds)
    print("ख़त्म — cursor वापस।")
