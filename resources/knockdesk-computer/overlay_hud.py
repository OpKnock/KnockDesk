"""
KnockDesk - Agent takeover overlay (glow + cursor comet + HUD)
==============================================================

अलग process, Electron (computer-overlay.js) इसे चलाता है। Screen पर:
  1. Aura   — किनारों पर नीला glow जो आहिस्ता घूमता और साँस लेता है
               (ख़त्म पर हरा, fail पर लाल)
  2. Comet  — cursor के पीछे नरम रोशनी, agent के click पर ripple
  3. HUD    — ऊपर बीच में card: computer icon, step, सोच, वक़्त, source, और
               details panel (पूरा task + हर step की activity: सोच, action,
               वक़्त) जो mouse card पर ले जाने से खुलता है

HUD पर कोई button नहीं, और वह mouse को बिल्कुल नहीं छूता (click-through):
  Agent को यह window screenshot में दिखती ही नहीं — तो अगर यह click लेती,
  agent को screen का वह हिस्सा "ख़ाली" दिखता मगर उसका click यहाँ अटक जाता
  (browser के tabs ठीक इसी जगह होते हैं)। उसूल: जो surface agent चला
  रहा है वह 100% सच्चा रहे। रोकने के रास्ते जो agent कभी trigger नहीं
  कर सकता: अपना mouse हिलाओ, Ctrl+Alt+Esc, या voice को "stop" बोलो।

क्यों Python (Electron की window क्यों नहीं):
  Agent हर step पर screenshot लेता है। Electron की transparent window को
  screenshot से निकालने पर (content protection) वह काली आ जाती है — agent
  अंधा। Windows के layered (UpdateLayeredWindow) window पर
  WDA_EXCLUDEFROMCAPTURE सही काम करता है: window screenshot में बिल्कुल
  नहीं आती। इस लिए rendering यहाँ है, और Electron सिर्फ़ state भेजता है।

Protocol — NDJSON, एक line एक संदेश:
    stdin  (Electron -> यहाँ)
        {"cmd":"state","state":{"phase":"running","id":"t1","task":"...","source":"voice",
                                 "step":3,"maxSteps":50,"thought":"...","startedAt":1712345678901}}
        {"cmd":"hide"}    {"cmd":"expand","value":true}    {"cmd":"snapshot","path":"..."}  (debug)    {"cmd":"shutdown"}
    stdout (यहाँ -> Electron)
        {"event":"ready"}   {"event":"layout","pill":[x,y,w,h],"panel":[x,y,w,h]|null}

अकेला चला कर देखने के लिए:
    python overlay_hud.py --demo
"""

from __future__ import annotations

import ctypes
import json
import logging
import math
import os
import platform
import queue
import sys
import threading
import time
import traceback
from ctypes import wintypes
from typing import Any, Dict, List, Optional, Tuple


# ── DPI awareness — सब से पहले ─────────────────────────────────────────────
def _dpi_aware() -> None:
    try:
        u = ctypes.windll.user32
        u.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        if u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
            return
    except Exception:  # noqa: BLE001
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:  # noqa: BLE001
        pass


if platform.system() == "Windows":
    _dpi_aware()

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw, ImageFilter, ImageFont  # noqa: E402

logging.basicConfig(level=os.environ.get("KNOCKDESK_OVERLAY_LOG", "INFO"), stream=sys.stderr,
                    format="%(asctime)s %(levelname)s overlay: %(message)s")
log = logging.getLogger("overlay")

# ---------------------------------------------------------------- Win32
user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

WS_EX_LAYERED = 0x00080000
WS_EX_TRANSPARENT = 0x00000020
WS_EX_TOPMOST = 0x00000008
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_NOACTIVATE = 0x08000000
WS_POPUP = 0x80000000
SW_SHOWNOACTIVATE, SW_HIDE = 4, 0
ULW_ALPHA = 0x02
AC_SRC_OVER, AC_SRC_ALPHA = 0x00, 0x01
HWND_TOPMOST = ctypes.c_void_p(-1)
SWP_NOSIZE, SWP_NOACTIVATE, SWP_NOREDRAW, SWP_NOMOVE = 0x0001, 0x0010, 0x0008, 0x0002
WDA_EXCLUDEFROMCAPTURE = 0x11
PM_REMOVE = 0x0001
IDC_ARROW = 32512


class BLENDFUNCTION(ctypes.Structure):
    _fields_ = [("BlendOp", ctypes.c_byte), ("BlendFlags", ctypes.c_byte),
                ("SourceConstantAlpha", ctypes.c_byte), ("AlphaFormat", ctypes.c_byte)]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG),
                ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG), ("biYPelsPerMeter", wintypes.LONG),
                ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD)]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


WNDPROC =ctypes.WINFUNCTYPE(ctypes.c_longlong, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)


class WNDCLASSEXW(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.UINT), ("style", wintypes.UINT), ("lpfnWndProc", WNDPROC), ("cbClsExtra", ctypes.c_int),
                ("cbWndExtra", ctypes.c_int), ("hInstance", wintypes.HINSTANCE), ("hIcon", wintypes.HICON), ("hCursor", wintypes.HANDLE),
                ("hbrBackground", wintypes.HBRUSH), ("lpszMenuName", wintypes.LPCWSTR), ("lpszClassName", wintypes.LPCWSTR), ("hIconSm", wintypes.HICON)]


HDC, HWND, HGDIOBJ = wintypes.HDC, wintypes.HWND, wintypes.HGDIOBJ
user32.CreateWindowExW.restype = HWND
user32.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_int, ctypes.c_int,
                                   ctypes.c_int, ctypes.c_int, HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]
user32.DefWindowProcW.restype = ctypes.c_longlong
user32.DefWindowProcW.argtypes = [HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.GetDC.restype = HDC
user32.GetDC.argtypes = [HWND]
user32.ReleaseDC.argtypes = [HWND, HDC]
user32.ShowWindow.argtypes = [HWND, ctypes.c_int]
user32.DestroyWindow.argtypes = [HWND]
user32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
user32.GetSystemMetrics.argtypes = [ctypes.c_int]
user32.GetSystemMetrics.restype = ctypes.c_int
user32.SetWindowDisplayAffinity.argtypes = [HWND, wintypes.DWORD]
user32.SetWindowPos.argtypes = [HWND, HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
user32.UpdateLayeredWindow.argtypes = [HWND, HDC, ctypes.POINTER(wintypes.POINT), ctypes.POINTER(wintypes.SIZE), HDC,
                                       ctypes.POINTER(wintypes.POINT), wintypes.COLORREF, ctypes.POINTER(BLENDFUNCTION), wintypes.DWORD]
user32.PeekMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), HWND, wintypes.UINT, wintypes.UINT, wintypes.UINT]
user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
user32.DispatchMessageW.restype = ctypes.c_longlong
user32.LoadCursorW.restype = wintypes.HANDLE
user32.LoadCursorW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR]
gdi32.CreateCompatibleDC.restype = HDC
gdi32.CreateCompatibleDC.argtypes = [HDC]
gdi32.CreateDIBSection.restype = wintypes.HBITMAP
gdi32.CreateDIBSection.argtypes = [HDC, ctypes.c_void_p, wintypes.UINT, ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD]
gdi32.SelectObject.restype = HGDIOBJ
gdi32.SelectObject.argtypes = [HDC, HGDIOBJ]
gdi32.DeleteObject.argtypes = [HGDIOBJ]
gdi32.DeleteDC.argtypes = [HDC]

_HANDLERS: Dict[int, Any] = {}


def _wndproc(hwnd, msg, wp, lp):
    h = _HANDLERS.get(hwnd)
    if h is not None:
        try:
            r = h(msg, wp, lp)
            if r is not None:
                return r
        except Exception:  # noqa: BLE001
            log.error("wndproc: %s", traceback.format_exc())
    return user32.DefWindowProcW(hwnd, msg, wp, lp)


_WNDPROC_REF = WNDPROC(_wndproc)
_CLASS_NAME = "KnockDeskAgentOverlay2"
_CLASS_DONE = False


def _register_class() -> None:
    global _CLASS_DONE
    if _CLASS_DONE:
        return
    wc = WNDCLASSEXW()
    wc.cbSize = ctypes.sizeof(WNDCLASSEXW)
    wc.lpfnWndProc = _WNDPROC_REF
    wc.hInstance = kernel32.GetModuleHandleW(None)
    wc.hCursor = user32.LoadCursorW(None, ctypes.cast(IDC_ARROW, wintypes.LPCWSTR))
    wc.lpszClassName = _CLASS_NAME
    if not user32.RegisterClassExW(ctypes.byref(wc)):
        err = ctypes.get_last_error()
        if err != 1410:
            raise ctypes.WinError(err)
    _CLASS_DONE = True


class LayeredWindow:
    """Per-pixel alpha window. click_through=True तो mouse आर-पार जाता है।"""

    def __init__(self, w: int, h: int, x: int, y: int, click_through: bool, handler=None):
        _register_class()
        self.w, self.h, self.x, self.y = w, h, x, y
        ex = WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | (WS_EX_TRANSPARENT if click_through else 0)
        self.hwnd = user32.CreateWindowExW(ex, _CLASS_NAME, None, WS_POPUP, x, y, w, h, None, None, kernel32.GetModuleHandleW(None), None)
        if not self.hwnd:
            raise ctypes.WinError(ctypes.get_last_error())
        if handler is not None:
            _HANDLERS[self.hwnd] = handler
        try:
            user32.SetWindowDisplayAffinity(self.hwnd, WDA_EXCLUDEFROMCAPTURE)
        except Exception:  # noqa: BLE001
            pass
        self._screen_dc = user32.GetDC(None)
        self._mem_dc = gdi32.CreateCompatibleDC(self._screen_dc)
        bmi = BITMAPINFO()
        bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bmi.bmiHeader.biWidth, bmi.bmiHeader.biHeight = w, -h
        bmi.bmiHeader.biPlanes, bmi.bmiHeader.biBitCount = 1, 32
        self._bits = ctypes.c_void_p()
        self._bitmap = gdi32.CreateDIBSection(self._screen_dc, ctypes.byref(bmi), 0, ctypes.byref(self._bits), None, 0)
        self._old = gdi32.SelectObject(self._mem_dc, self._bitmap)
        self.visible = False
        self._destroyed = False

    def set_array(self, bgra_premul: np.ndarray) -> None:
        arr = np.ascontiguousarray(bgra_premul)
        ctypes.memmove(self._bits, arr.ctypes.data, arr.nbytes)

    def flush(self, alpha: int = 255, x: Optional[int] = None, y: Optional[int] = None, h: Optional[int] = None) -> None:
        """`h` दो तो bitmap का सिर्फ़ ऊपर वाला हिस्सा दिखाओ (window उतनी ही ऊँची हो जाती है)।"""
        if self._destroyed:
            return
        if x is not None:
            self.x, self.y = x, y
        blend = BLENDFUNCTION(AC_SRC_OVER, 0, max(0, min(255, int(alpha))), AC_SRC_ALPHA)
        size = wintypes.SIZE(self.w, self.h if h is None else max(1, min(self.h, int(h))))
        src = wintypes.POINT(0, 0)
        dst = wintypes.POINT(self.x, self.y)
        user32.UpdateLayeredWindow(self.hwnd, self._screen_dc, ctypes.byref(dst), ctypes.byref(size), self._mem_dc,
                                   ctypes.byref(src), 0, ctypes.byref(blend), ULW_ALPHA)

    def show(self) -> None:
        if not self.visible:
            user32.ShowWindow(self.hwnd, SW_SHOWNOACTIVATE)
            user32.SetWindowPos(self.hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE)
            self.visible = True

    def hide(self) -> None:
        if self.visible:
            user32.ShowWindow(self.hwnd, SW_HIDE)
            self.visible = False

    def destroy(self) -> None:
        if self._destroyed:
            return
        self._destroyed = True
        _HANDLERS.pop(self.hwnd, None)
        try:
            gdi32.SelectObject(self._mem_dc, self._old)
            gdi32.DeleteObject(self._bitmap)
            gdi32.DeleteDC(self._mem_dc)
            user32.ReleaseDC(None, self._screen_dc)
            user32.DestroyWindow(self.hwnd)
        except Exception:  # noqa: BLE001
            pass


# ---------------------------------------------------------------- helpers
def premul(img: Image.Image) -> np.ndarray:
    """PIL RGBA (straight) -> premultiplied BGRA uint8 array."""
    a = np.asarray(img.convert("RGBA"), dtype=np.uint16)
    out = np.empty(a.shape, dtype=np.uint8)
    al = a[..., 3]
    out[..., 0] = (a[..., 2] * al // 255).astype(np.uint8)
    out[..., 1] = (a[..., 1] * al // 255).astype(np.uint8)
    out[..., 2] = (a[..., 0] * al // 255).astype(np.uint8)
    out[..., 3] = al.astype(np.uint8)
    return out


def hexrgb(h: str) -> Tuple[int, int, int]:
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


# रंग: सिर्फ़ एक ख़ानदान — काम के दौरान नीला (गहरा → बिजली जैसा → आसमानी,
# आहिस्ता घूमता हुआ ताकि "साँस" ले), ख़त्म पर हरा, रुकने पर amber,
# fail पर लाल। रंग-बिरंगी (rainbow) aura जानबूझ कर नहीं — साफ़ sci-fi look.
PALETTES = {
    "live": ["#0A84FF", "#3FA9FF", "#7CD4FF", "#2F8CFF", "#1467F5", "#4FB3FF"],
    "ok": ["#30D158", "#4ADE80", "#22C55E", "#5EEA8C", "#2FBF6B", "#3DD66E"],
    "warn": ["#FF9F0A", "#FFB340", "#FF9F0A", "#FFC069", "#FF9F0A", "#FFAD2E"],
    "bad": ["#FF453A", "#FF6961", "#FF375F", "#FF453A", "#FF7A70", "#FF5A50"],
}
ACCENT = {"live": "#4FB3FF", "ok": "#3DD66E", "warn": "#FFB340", "bad": "#FF6961"}


def make_lut(colors: List[str]) -> np.ndarray:
    """256 x 3 float32 RGB, cyclic (आख़िरी रंग वापस पहले पर)।"""
    pts = [hexrgb(c) for c in colors] + [hexrgb(colors[0])]
    n = len(pts) - 1
    lut = np.zeros((256, 3), np.float32)
    for i in range(256):
        f = i / 256 * n
        k = int(f)
        t = f - k
        a, b = pts[k], pts[k + 1]
        lut[i] = [a[j] + (b[j] - a[j]) * t for j in range(3)]
    return lut


def ease_out(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return 1 - (1 - t) ** 3


def rr_mask(w: int, h: int, r: float, ss: int = 4) -> Image.Image:
    m = Image.new("L", (w * ss, h * ss), 0)
    ImageDraw.Draw(m).rounded_rectangle([(0, 0), (w * ss - 1, h * ss - 1)], radius=r * ss, fill=255)
    return m.resize((w, h), Image.LANCZOS)


def circle_mask(d: int, ss: int = 4) -> Image.Image:
    m = Image.new("L", (d * ss, d * ss), 0)
    ImageDraw.Draw(m).ellipse([(0, 0), (d * ss - 1, d * ss - 1)], fill=255)
    return m.resize((d, d), Image.LANCZOS)


def angle_map(w: int, h: int, cx: float, cy: float) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    return ((np.arctan2(yy - cy, xx - cx) / (2 * math.pi) + 0.5) * 256).astype(np.uint8)


def colorize(amap: np.ndarray, lut: np.ndarray, phase: int) -> Image.Image:
    idx = (amap + np.uint8(phase & 255))
    rgb = lut[idx].astype(np.uint8)
    return Image.fromarray(np.dstack([rgb, np.full(amap.shape, 255, np.uint8)]), "RGBA")


_FONT_CACHE: Dict[Tuple[str, float], Any] = {}


def font(kind: str, size: float):
    key = (kind, round(size, 1))
    if key in _FONT_CACHE:
        return _FONT_CACHE[key]
    names = {"reg": ["segoeui.ttf", "arial.ttf"], "sb": ["seguisb.ttf", "segoeuib.ttf", "arialbd.ttf"], "b": ["segoeuib.ttf", "arialbd.ttf"]}[kind]
    f = None
    for n in names:
        try:
            f = ImageFont.truetype(os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", n), size)
            break
        except OSError:
            continue
    if f is None:
        f = ImageFont.load_default()
    _FONT_CACHE[key] = f
    return f


def ellipsize(text: str, fnt, max_w: float) -> str:
    text = " ".join((text or "").split())
    if fnt.getlength(text) <= max_w:
        return text
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if fnt.getlength(text[:mid].rstrip() + "…") <= max_w:
            lo = mid
        else:
            hi = mid - 1
    return text[:lo].rstrip() + "…"


def wrap2(text: str, fnt, max_w: float) -> List[str]:
    text = " ".join((text or "").split())
    if fnt.getlength(text) <= max_w:
        return [text]
    words = text.split(" ")
    line, i = "", 0
    while i < len(words) and fnt.getlength((line + " " + words[i]).strip()) <= max_w:
        line = (line + " " + words[i]).strip()
        i += 1
    rest = " ".join(words[i:])
    return [line, ellipsize(rest, fnt, max_w)] if rest else [line]


# ---------------------------------------------------------------- Aura
class Aura:
    def __init__(self, sw: int, sh: int, S: float):
        self.sw, self.sh = sw, sh
        self.win = LayeredWindow(sw, sh, 0, 0, click_through=True)
        self.buf = np.zeros((sh, sw, 4), np.uint8)
        yy, xx = np.mgrid[0:sh, 0:sw].astype(np.float32)
        r = 18 * S
        hx, hy = sw / 2, sh / 2
        qx = np.abs(xx + 0.5 - hx) - (hx - r)
        qy = np.abs(yy + 0.5 - hy) - (hy - r)
        sd = np.minimum(np.maximum(qx, qy), 0) + np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) - r
        d = np.maximum(-sd, 0)
        soft = np.clip(1 - d / (165 * S), 0, 1) ** 2.2 * 0.40
        core = np.clip(1 - d / (72 * S), 0, 1) ** 2.6 * 0.85
        rim = np.clip(1 - np.abs(d - 1.2 * S) / (1.9 * S), 0, 1) * 0.95
        cx = np.clip(1 - np.minimum(xx, sw - 1 - xx) / (260 * S), 0, 1)
        cy = np.clip(1 - np.minimum(yy, sh - 1 - yy) / (260 * S), 0, 1)
        w = np.clip((soft + core) * (1 + 0.5 * cx * cy) + rim, 0, 1)
        w8 = (w * 255).astype(np.uint8)
        amap = angle_map(sw, sh, hx, hy)
        B = int(175 * S)
        self.strips = []
        for sl in [(slice(0, B), slice(0, sw)), (slice(sh - B, sh), slice(0, sw)),
                   (slice(B, sh - B), slice(0, B)), (slice(B, sh - B), slice(sw - B, sw))]:
            self.strips.append((sl, w8[sl].copy(), amap[sl].copy()))
            self.buf[sl][..., 3] = w8[sl]
        del yy, xx, qx, qy, sd, d, soft, core, rim, cx, cy, w, w8, amap
        self.tone = "live"
        self.lut_cur = make_lut(PALETTES["live"])
        self.lut_from = self.lut_cur.copy()
        self.lut_to = self.lut_cur.copy()
        self.mix_t0 = -1.0
        self.table = self._table(self.lut_cur)
        self.alpha = 0.0
        self.alpha_target = 0.0
        self.alpha_t0 = 0.0
        self.alpha_from = 0.0

    @staticmethod
    def _table(lut: np.ndarray) -> np.ndarray:
        # table[weight, angle] = premultiplied BGR
        wgt = np.arange(256, dtype=np.float32)[:, None, None] / 255.0
        bgr = lut[None, :, ::-1] * wgt
        return bgr.astype(np.uint8)

    def set_tone(self, tone: str, now: float) -> None:
        if tone == self.tone:
            return
        self.tone = tone
        self.lut_from = self.lut_cur.copy()
        self.lut_to = make_lut(PALETTES.get(tone, PALETTES["live"]))
        self.mix_t0 = now

    def fade_to(self, target: float, now: float) -> None:
        if target != self.alpha_target:
            self.alpha_from, self.alpha_target, self.alpha_t0 = self.alpha, target, now

    def frame(self, now: float) -> None:
        if self.mix_t0 >= 0:
            k = min(1.0, (now - self.mix_t0) / 0.6)
            self.lut_cur = self.lut_from + (self.lut_to - self.lut_from) * k
            self.table = self._table(self.lut_cur)
            if k >= 1.0:
                self.mix_t0 = -1.0
        dur = 0.9 if self.alpha_target > self.alpha_from else 1.4
        self.alpha = self.alpha_from + (self.alpha_target - self.alpha_from) * ease_out((now - self.alpha_t0) / dur)
        if self.alpha <= 0.001 and self.alpha_target == 0:
            self.win.hide()
            return
        phase = int((now / 16.0) * 256) & 255
        for sl, w8, amap in self.strips:
            self.buf[sl][..., :3] = self.table[w8, (amap + np.uint8(phase))]
        self.win.set_array(self.buf)
        wave = 0.66 + 0.34 * (0.5 + 0.5 * math.sin(now * 2 * math.pi / 3.6))
        self.win.show()
        self.win.flush(alpha=int(255 * wave * self.alpha))


# ---------------------------------------------------------------- Comet
class Comet:
    def __init__(self, S: float):
        self.size = int(170 * S)
        s = self.size
        r = s / 2
        yy, xx = np.mgrid[0:s, 0:s].astype(np.float32)
        d = np.sqrt((xx - r) ** 2 + (yy - r) ** 2) / r
        core = np.clip(1 - d / 0.14, 0, 1) ** 1.4
        c1 = np.clip(1 - d / 0.42, 0, 1) ** 1.8
        c2 = np.clip(1 - d / 0.70, 0, 1) ** 2.4
        img = np.zeros((s, s, 4), np.float32)
        # सफ़ेद मरकज़ → आसमानी → गहरा नीला (aura के साथ एक ही ख़ानदान)
        white, sky, deep = np.array([255, 255, 255]), np.array([120, 205, 255]), np.array([20, 110, 245])
        col = deep[None, None] * c2[..., None] + (sky - deep)[None, None] * c1[..., None] + (white - sky)[None, None] * core[..., None]
        alpha = np.clip(core * 0.55 + c1 * 0.42 + c2 * 0.22, 0, 1)
        img[..., :3] = np.clip(col, 0, 255)
        img[..., 3] = alpha * 255
        self.base = Image.fromarray(img.astype(np.uint8), "RGBA").filter(ImageFilter.GaussianBlur(2 * S))
        self.base_pm = premul(self.base)
        self.rings = []
        for i in range(14):
            t = i / 13
            sc = 0.35 + (3.2 - 0.35) * ease_out(t)
            rad = 13 * S * sc
            a = int(255 * (1 - t) ** 1.2)
            im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
            dr = ImageDraw.Draw(im)
            dr.ellipse([(r - rad, r - rad), (r + rad, r + rad)], outline=(255, 255, 255, a), width=max(1, int(2 * S)))
            glow = im.filter(ImageFilter.GaussianBlur(3 * S))
            g = np.asarray(glow).astype(np.float32)
            g[..., 0], g[..., 1], g[..., 2] = 110, 195, 255
            self.rings.append(Image.alpha_composite(Image.fromarray(g.astype(np.uint8), "RGBA"), im))
        self.win = LayeredWindow(s, s, -s, -s, click_through=True)
        self.ripple_t0 = -1.0
        self.prev: Optional[Tuple[int, int]] = None
        self.pos = (-s, -s)

    def frame(self, now: float, cur: Tuple[int, int], live: bool, ripple_ok: bool) -> None:
        if not live:
            self.win.hide()
            self.prev = None
            return
        if self.prev is not None and ripple_ok and math.hypot(cur[0] - self.prev[0], cur[1] - self.prev[1]) > 70:
            self.ripple_t0 = now
        self.prev = cur
        half = self.size // 2
        x, y = cur[0] - half, cur[1] - half
        if self.ripple_t0 >= 0 and now - self.ripple_t0 < 0.62:
            k = min(13, int((now - self.ripple_t0) / 0.62 * 14))
            self.win.set_array(premul(Image.alpha_composite(self.base, self.rings[k])))
        else:
            self.ripple_t0 = -1.0
            self.win.set_array(self.base_pm)
        wave = 0.5 + 0.5 * math.sin(now * 2 * math.pi / 3.6)
        self.win.show()
        self.win.flush(alpha=int(150 + 85 * wave), x=x, y=y)


# ---------------------------------------------------------------- HUD
DONE_LABEL = {
    "done": ("Done", "ok"), "failed": ("Couldn't finish", "bad"), "error": ("Error", "bad"),
    "stopped": ("Stopped", "warn"), "interrupted": ("Paused", "warn"), "max_steps": ("Step limit", "warn"),
}
SOURCE_LABEL = {"voice": "via Voice", "hermes": "via Hermes"}
MAX_ROWS = 8        # details panel में इतने आख़िरी steps
CARD_R = 20         # card के कोने (design units)


def mmss(ms: float) -> str:
    s = max(0, int(ms // 1000))
    return f"{s // 60}:{s % 60:02d}"


def wrap_lines(text: str, fnt, max_w: float, max_lines: int) -> List[str]:
    """लफ़्ज़ों पर तोड़ना, ज़्यादा से ज़्यादा `max_lines`; आख़िरी line पर '…'।"""
    text = " ".join((text or "").split())
    if not text:
        return [""]
    words = text.split(" ")
    lines: List[str] = []
    i = 0
    while i < len(words) and len(lines) < max_lines:
        line = ""
        while i < len(words) and fnt.getlength((line + " " + words[i]).strip()) <= max_w:
            line = (line + " " + words[i]).strip()
            i += 1
        if not line:  # एक लफ़्ज़ ही इतना लंबा
            line = ellipsize(words[i], fnt, max_w)
            i += 1
        lines.append(line)
    if i < len(words):
        lines[-1] = ellipsize(lines[-1] + " " + " ".join(words[i:]), fnt, max_w)
    return lines


def spaced_text(d: ImageDraw.ImageDraw, xy, text: str, fnt, fill, sp: float) -> float:
    """Letter-spaced छोटा label (PIL में tracking नहीं होता)।"""
    x, y = xy
    for ch in text:
        d.text((x, y), ch, font=fnt, fill=fill)
        x += fnt.getlength(ch) + sp
    return x


def alpha_scaled(img: Image.Image, k: float) -> Image.Image:
    out = img.copy()
    out.putalpha(Image.fromarray((np.asarray(out.split()[3], np.float32) * k).astype(np.uint8)))
    return out


def monitor_icon(px: int, color: Tuple[int, int, int], ss: int = 4) -> Tuple[Image.Image, Tuple[int, int, int, int]]:
    """
    Computer का icon: accent रंग की लकीर वाला monitor, अंदर गहरी screen,
    नीचे stand। लौटाता है (तस्वीर, screen का अंदर वाला rect x0,y0,x1,y1)।
    """
    u = px / 24 * ss
    im = Image.new("RGBA", (px * ss, px * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    stroke = max(1, round(1.75 * u))
    d.rounded_rectangle([(1.5 * u, 2.5 * u), (22.5 * u, 16.5 * u)], radius=2.8 * u, fill=(6, 12, 24, 240), outline=color + (255,), width=stroke)
    d.rectangle([(10.4 * u, 16.5 * u), (13.6 * u, 19.3 * u)], fill=color + (255,))
    d.rounded_rectangle([(6.5 * u, 19.3 * u), (17.5 * u, 21.3 * u)], radius=1.0 * u, fill=color + (255,))
    out = im.resize((px, px), Image.LANCZOS)
    inner = (int((1.5 * u + stroke) / ss) + 1, int((2.5 * u + stroke) / ss) + 1,
             int((22.5 * u - stroke) / ss) - 1, int((16.5 * u - stroke) / ss) - 1)
    return out, inner


class Hud:
    def __init__(self, sw: int, S: float, emit):
        self.S, self.sw, self.emit = S, sw, emit
        self.W = int(500 * S)
        self.WW = int(self.W + 80 * S)
        self.WH = int(660 * S)          # bitmap की ज़्यादा से ज़्यादा ऊँचाई; flush उतना ही जितना content
        self.px, self.py = int(40 * S), int(16 * S)
        # click_through: HUD mouse को बिल्कुल नहीं छूता — देखो file का header.
        self.win = LayeredWindow(self.WW, self.WH, (sw - self.WW) // 2, 0, click_through=True)
        self.state: Dict[str, Any] = {"phase": "idle"}
        self.expanded = False
        self._away_t0 = -1.0            # cursor card से कब हटा (details बंद करने की मोहलत)
        self.static: Optional[Image.Image] = None
        self.layout: Dict[str, Any] = {}
        self.dirty = True
        self.show_t0 = -1.0
        self.leave_t0 = -1.0
        self.hint_t0 = -1.0
        self.tone = "live"
        self.lut = make_lut(PALETTES["live"])
        self.H = int(84 * S)
        self.content_h = self.H
        self.icon_d = int(34 * S)
        self.icon_pad = int(26 * S)     # glow के लिए इतनी जगह कि blur किनारे तक पहुँचने से पहले बुझ जाए
        gd = self.icon_d + 2 * self.icon_pad
        gm = Image.new("L", (gd, gd), 0)
        cd = self.icon_d + int(6 * S)
        gm.paste(circle_mask(cd), ((gd - cd) // 2, (gd - cd) // 2))
        self.glow_mask = gm
        self._icons: Dict[Tuple[int, int, int], Tuple[Image.Image, Tuple[int, int, int, int]]] = {}

    # ── pointer ───────────────────────────────────────────────────────────
    # Window click-through है, इस लिए mouse के संदेश यहाँ आते ही नहीं।
    # OverlayApp हर frame असली cursor की जगह देता है (GetCursorPos): cursor
    # card पर आ जाए तो details खुल जाते हैं, हट जाए तो थोड़ी मोहलत के
    # बाद बंद। Click की ज़रूरत नहीं — और click हो भी तो card के आर-पार,
    # उस चीज़ पर जो agent ने देखी थी।
    HOVER_GRACE_S = 0.6

    @staticmethod
    def _in(rect, x, y) -> bool:
        return bool(rect) and rect[0] <= x < rect[0] + rect[2] and rect[1] <= y < rect[1] + rect[3]

    def set_pointer(self, x: int, y: int, now: float) -> None:
        if self.state.get("phase", "idle") == "idle" or self.static is None:
            return
        lx, ly = x - self.win.x, y - self.win.y
        over = self._in(self.layout.get("pill_local"), lx, ly) or (
            self.expanded and self._in(self.layout.get("panel_local"), lx, ly))
        if over:
            self._away_t0 = -1.0
            self.set_expanded(True)
        elif self.expanded:
            if self._away_t0 < 0:
                self._away_t0 = now
            elif now - self._away_t0 > self.HOVER_GRACE_S:
                self._away_t0 = -1.0
                self.set_expanded(False)

    # ── state ─────────────────────────────────────────────────────────────
    def set_expanded(self, value: bool) -> None:
        value = bool(value)
        if value != self.expanded:
            self.expanded = value
            self.dirty = True

    def set_state(self, s: Dict[str, Any], now: float) -> None:
        prev = self.state.get("phase")
        self.state = s
        ph = s.get("phase", "idle")
        if ph != "idle" and (prev == "idle" or self.show_t0 < 0):
            self.show_t0 = now
            self.leave_t0 = -1.0
            self.hint_t0 = now
            self._away_t0 = -1.0
        if s.get("leaving") and self.leave_t0 < 0:
            self.leave_t0 = now
        self.dirty = True

    def hide(self) -> None:
        self.state = {"phase": "idle"}
        self.show_t0 = self.leave_t0 = self._away_t0 = -1.0
        self.expanded = False
        self.win.hide()

    # ── drawing helpers ───────────────────────────────────────────────────
    def _card(self, img: Image.Image, x: int, y: int, w: int, h: int, r: float, top, bot, shadow: int = 135) -> Image.Image:
        """शीशा जैसा गहरा card: साया, ऊपर से नीचे gradient, 1px किनारा, ऊपर हल्की लकीर।"""
        S = self.S
        pm = rr_mask(w, h, r)
        sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
        sh_m = Image.new("L", img.size, 0)
        sh_m.paste(pm, (x, y + int(10 * S)))
        sh_m = sh_m.filter(ImageFilter.GaussianBlur(16 * S))
        sh.paste((0, 0, 0, shadow), (0, 0), sh_m)
        img = Image.alpha_composite(img, sh)
        grad = np.zeros((h, w, 4), np.float32)
        t = np.linspace(0, 1, h, dtype=np.float32)[:, None]
        grad[:] = np.array(top, np.float32) + (np.array(bot, np.float32) - np.array(top, np.float32)) * t[..., None]
        card = Image.fromarray(grad.astype(np.uint8), "RGBA")
        card.putalpha(Image.fromarray((np.asarray(pm, np.float32) * (np.asarray(card.split()[3], np.float32) / 255)).astype(np.uint8)))
        img.paste(card, (x, y), card)
        inner = rr_mask(w - 2, h - 2, r - 1)
        border_m = pm.copy()
        border_m.paste(Image.new("L", inner.size, 0), (1, 1), inner)
        img.paste(Image.new("RGBA", (w, h), (255, 255, 255, 30)), (x, y), border_m)
        hl_m = Image.new("L", (w, h), 0)
        hl_m.paste(pm.crop((0, 1, w, 2)), (0, 1))
        img.paste(Image.new("RGBA", (w, h), (255, 255, 255, 24)), (x, y), hl_m)
        return img

    def _icon(self, accent: Tuple[int, int, int]) -> Tuple[Image.Image, Tuple[int, int, int, int]]:
        if accent not in self._icons:
            self._icons[accent] = monitor_icon(self.icon_d, accent)
        return self._icons[accent]

    # ── render ────────────────────────────────────────────────────────────
    def _render_static(self) -> None:
        S = self.S
        s = self.state
        ph = s.get("phase", "idle")
        done = ph == "done"
        label, tone = ("", "live")
        if done:
            label, tone = DONE_LABEL.get(s.get("status") or "", (s.get("status") or "Finished", "warn"))
        elif ph == "starting":
            label = "Starting"
        elif ph == "stopping":
            label = "Stopping"
        else:
            label = "Working"
        self.tone = tone
        self.lut = make_lut(PALETTES[tone])
        accent = hexrgb(ACCENT[tone])

        f_title, f_chip, f_small, f_body = font("sb", 13 * S), font("sb", 11 * S), font("reg", 11 * S), font("reg", 13 * S)
        f_lab, f_row, f_sub, f_num = font("sb", 9.5 * S), font("reg", 12.5 * S), font("reg", 10.5 * S), font("sb", 10.5 * S)
        W = self.W
        chev_d = int(24 * S)
        x0 = int(64 * S)
        body_right = W - int(16 * S)
        body_w = body_right - x0

        if done:
            text = s.get("summary") or s.get("task") or ""
            lines = wrap_lines(text, f_body, body_w, 2)
        elif ph == "starting":
            # ठंडी machine पर agent का load minute ले सकता है। बिना गिनती
            # के यह जुमला अटका हुआ लगता है — seconds इसे ज़िंदा दिखाते हैं।
            secs = int(s.get("loadingFor") or 0)
            lines = ["Waking up the agent…" if secs < 5 else f"Waking up the agent… {secs}s"]
        elif ph == "stopping":
            lines = ["Releasing the mouse…"]
        else:
            lines = [ellipsize(s.get("thought") or s.get("task") or "Looking at the screen…", f_body, body_w)]
        two = len(lines) > 1
        H = int((98 if two else 84) * S)
        self.H = H
        px, py = self.px, self.py
        white = (255, 255, 255)
        muted = (255, 255, 255, 150)

        # ── details panel का नाप (पहले, ताकि window की ऊँचाई पता हो) ──
        gap = int(8 * S)
        pad = int(16 * S)
        panel_h = 0
        hist: List[Dict[str, Any]] = list(s.get("history") or [])
        rows = hist[-MAX_ROWS:]
        task_lines: List[str] = []
        row_h = int(36 * S)
        lab_h = int(16 * S)
        line_h = int(17 * S)
        if self.expanded:
            task_lines = wrap_lines(s.get("task") or "", f_row, W - 2 * pad, 3)
            panel_h = pad + lab_h + len(task_lines) * line_h + int(12 * S) + 1 + int(12 * S) + lab_h + int(6 * S)
            panel_h += len(rows) * row_h if rows else int(22 * S)
            panel_h += pad
        content_h = py + H + (gap + panel_h if self.expanded else 0)
        hint_h = int(24 * S)
        total_h = min(self.WH, content_h + int(8 * S) + hint_h + int(20 * S))
        img = Image.new("RGBA", (self.WW, total_h), (0, 0, 0, 0))

        # ── main card ──
        img = self._card(img, px, py, W, H, CARD_R * S, (40, 40, 46, 240), (20, 20, 24, 245))
        d = ImageDraw.Draw(img)

        # row 1: title + chip
        y1 = py + int(12 * S)
        d.text((px + x0, y1), "KnockDesk Agent", font=f_title, fill=white + (240,))
        tw = f_title.getlength("KnockDesk Agent")
        cx = px + x0 + int(tw + 8 * S)
        chip_h = int(18 * S)
        chip_w = int(f_chip.getlength(label) + 24 * S)
        chip_bg = (accent + (46,)) if done else (accent + (30,))
        chip_m = rr_mask(chip_w, chip_h, chip_h / 2)
        img.paste(Image.new("RGBA", (chip_w, chip_h), chip_bg), (cx, y1 - int(1 * S)), chip_m)
        d.text((cx + int(16 * S), y1 - int(1 * S) + (chip_h - f_chip.size) / 2 - 1 * S), label, font=f_chip,
               fill=(accent + (255,)) if done else (255, 255, 255, 205))
        self.layout["dot"] = (cx + int(7 * S), y1 - int(1 * S) + chip_h // 2)

        # chevron (details) — row 1 के दाएँ
        # सिर्फ़ इशारा (details खुले हैं या नहीं) — button नहीं; hover से खुलता है।
        chx, chy = px + body_right - chev_d, y1 - int(4 * S)
        cbg, cfg = ((255, 255, 255, 30), (255, 255, 255, 230)) if self.expanded else ((255, 255, 255, 14), (255, 255, 255, 165))
        img.paste(Image.new("RGBA", (chev_d, chev_d), cbg), (chx, chy), circle_mask(chev_d))
        d = ImageDraw.Draw(img)
        ccx, ccy = chx + chev_d / 2, chy + chev_d / 2
        a = 3.6 * S
        dy = -1.6 * S if self.expanded else 1.6 * S
        d.line([(ccx - a, ccy - dy), (ccx, ccy + dy), (ccx + a, ccy - dy)], fill=cfg, width=max(1, int(1.7 * S)), joint="curve")
        self.layout["chev_local"] = (chx, chy, chev_d, chev_d)

        src = SOURCE_LABEL.get(s.get("source") or "", "")
        if src:
            d.text((chx - int(8 * S) - f_small.getlength(src), y1 + int(1 * S)), src, font=f_small, fill=muted)

        # thought / summary
        yt = py + int(31 * S)
        for i, ln in enumerate(lines):
            d.text((px + x0, yt + i * line_h), ln, font=f_body, fill=white + (235,))

        # meta + bar
        if ph == "starting":
            meta = f"Up to {s.get('maxSteps')} steps" if s.get("maxSteps") else ""
        elif done:
            n = s.get("steps") if s.get("steps") is not None else (s.get("step") or 0)
            meta = f"{n} step{'' if n == 1 else 's'}"
        else:
            meta = f"Step {s.get('step') or 0} of {s.get('maxSteps')}" if s.get("maxSteps") else f"Step {s.get('step') or 0}"
        self.layout["meta_base"] = meta
        ym = py + H - int(20 * S)
        self.layout["meta_pos"] = (px + body_right, ym, f_small)
        bar_right = px + body_right - int(f_small.getlength(meta + " · 00:00") + 10 * S)
        self.layout["bar"] = (px + x0, ym + int(4 * S), max(int(40 * S), bar_right - (px + x0)), max(2, int(3 * S)))
        bx, by, bw, bh = self.layout["bar"]
        img.paste(Image.new("RGBA", (bw, bh), (255, 255, 255, 26)), (bx, by), rr_mask(bw, bh, bh / 2))

        self.layout["pill_local"] = (px, py, W, H)
        self.layout["icon"] = (px + int(15 * S), py + (H - self.icon_d) // 2)

        # ring (1px rounded outline) angle map + mask
        pm = rr_mask(W, H, CARD_R * S)
        inner = rr_mask(W - 2, H - 2, CARD_R * S - 1)
        ring_m = pm.copy()
        ring_m.paste(Image.new("L", inner.size, 0), (1, 1), inner)
        self.layout["ring_mask"] = ring_m
        self.layout["ring_amap"] = angle_map(W, H, W / 2, H / 2)

        # ── details panel ──
        self.layout["panel_local"] = None
        self.layout["live_dot"] = None
        if self.expanded:
            ptop = py + H + gap
            img = self._card(img, px, ptop, W, panel_h, CARD_R * S, (30, 30, 35, 242), (17, 17, 21, 246), shadow=110)
            d = ImageDraw.Draw(img)
            lab_col = accent + (215,)
            y = ptop + pad
            spaced_text(d, (px + pad, y + int(1 * S)), "TASK", f_lab, lab_col, 1.4 * S)
            y += lab_h
            for ln in task_lines:
                d.text((px + pad, y), ln, font=f_row, fill=white + (225,))
                y += line_h
            y += int(12 * S)
            d.line([(px + pad, y), (px + W - pad, y)], fill=(255, 255, 255, 22), width=1)
            y += 1 + int(12 * S)
            spaced_text(d, (px + pad, y + int(1 * S)), "ACTIVITY", f_lab, lab_col, 1.4 * S)
            count = f"{len(hist)} step{'' if len(hist) == 1 else 's'}" if hist else ""
            if count:
                d.text((px + W - pad - f_small.getlength(count), y), count, font=f_small, fill=muted)
            y += lab_h + int(6 * S)
            if not rows:
                d.text((px + pad, y + int(2 * S)), "Waiting for the first step…", font=f_row, fill=muted)
            else:
                num_w = int(22 * S)
                dot_x = px + pad + num_w + int(9 * S)
                text_x = dot_x + int(16 * S)
                # timeline की लकीर — पहले dot से आख़िरी तक
                if len(rows) > 1:
                    d.line([(dot_x, y + int(10 * S)), (dot_x, y + (len(rows) - 1) * row_h + int(10 * S))], fill=(255, 255, 255, 30), width=max(1, int(1 * S)))
                for i, r in enumerate(rows):
                    last = i == len(rows) - 1
                    ry = y + i * row_h
                    num = str(r.get("step") or "")
                    d.text((px + pad + num_w - f_num.getlength(num), ry + int(1 * S)), num, font=f_num, fill=(255, 255, 255, 120 if not last else 200))
                    rr = 2.6 * S
                    if last and not done:
                        self.layout["live_dot"] = (dot_x, ry + int(10 * S))
                    else:
                        col = accent + (255,) if last else (255, 255, 255, 95)
                        d.ellipse([(dot_x - rr, ry + 10 * S - rr), (dot_x + rr, ry + 10 * S + rr)], fill=col)
                    tstr = mmss(r.get("at") or 0)
                    tw_ = f_sub.getlength(tstr)
                    d.text((px + W - pad - tw_, ry + int(19 * S)), tstr, font=f_sub, fill=(255, 255, 255, 110))
                    tmax = px + W - pad - text_x
                    th = ellipsize(r.get("thought") or "—", f_row, tmax)
                    d.text((text_x, ry), th, font=f_row, fill=white + (235 if last else 170,))
                    act = " ".join((r.get("action") or "").split())
                    if act:
                        d.text((text_x, ry + int(19 * S)), ellipsize(act, f_sub, tmax - tw_ - int(10 * S)), font=f_sub, fill=(accent + (200,)) if last else (255, 255, 255, 105))
            self.layout["panel_local"] = (px, ptop, W, panel_h)

        # hint (अलग layer)
        hint = Image.new("RGBA", (self.WW, hint_h), (0, 0, 0, 0))
        hd = ImageDraw.Draw(hint)
        parts = [("Move your mouse to pause", None), ("·", None), ("Ctrl", "kbd"), ("Alt", "kbd"), ("Esc", "kbd"), ("to stop", None)]
        f_h, f_k = font("reg", 11 * S), font("sb", 10 * S)
        total = 0
        widths = []
        for txt, kind in parts:
            w_ = f_k.getlength(txt) + 10 * S if kind else f_h.getlength(txt)
            widths.append(w_)
            total += w_ + 5 * S
        hx = (self.WW - total) / 2
        for (txt, kind), w_ in zip(parts, widths):
            if kind:
                km = rr_mask(int(w_), int(17 * S), 5 * S)
                hint.paste(Image.new("RGBA", km.size, (255, 255, 255, 34)), (int(hx), int(3 * S)), km)
                hd.text((hx + 5 * S, 3 * S + (17 * S - f_k.size) / 2 - 1 * S), txt, font=f_k, fill=(255, 255, 255, 220))
            else:
                hd.text((hx, 5 * S), txt, font=f_h, fill=(255, 255, 255, 165))
            hx += w_ + 5 * S
        self.layout["hint"] = hint
        self.content_h = content_h
        self.static = img
        self.dirty = False
        # Window आराम की हालत में y=0 पर होती है (enter animation के बाद)।
        wx, wy = (self.sw - self.WW) // 2, 0
        pl = self.layout["panel_local"]
        self.emit("layout", pill=[wx + px, wy + py, W, H],
                  panel=[wx + pl[0], wy + pl[1], pl[2], pl[3]] if pl else None)

    def frame(self, now: float) -> Optional[Image.Image]:
        ph = self.state.get("phase", "idle")
        if ph == "idle":
            self.win.hide()
            return None
        if self.dirty or self.static is None:
            self._render_static()
        S = self.S
        img = self.static.copy()
        s = self.state
        done = ph == "done"
        live = not done
        phase = int((now / (9.0 if live else 30.0)) * 256) & 255
        breath = 0.5 + 0.5 * math.sin(now * 2 * math.pi / 2.6)
        acc = hexrgb(ACCENT[self.tone])

        # ring — card के किनारे पर घूमती नीली रोशनी
        rm, ram = self.layout["ring_mask"], self.layout["ring_amap"]
        ring = colorize(ram, self.lut, phase)
        ring.putalpha(Image.fromarray((np.asarray(rm, np.float32) * (0.62 if done else 0.45)).astype(np.uint8)))
        img.alpha_composite(ring, (self.px, self.py))

        # computer icon + glow + scan line
        ix, iy = self.layout["icon"]
        icon, inner = self._icon(acc)
        gd = self.icon_d + 2 * self.icon_pad
        glow = Image.new("RGBA", (gd, gd), acc + (255,))
        glow.putalpha(Image.fromarray((np.asarray(self.glow_mask, np.float32) * (0.62 * (0.6 + 0.4 * breath) if live else 0.42)).astype(np.uint8)))
        glow = glow.filter(ImageFilter.GaussianBlur(9 * S))
        img.alpha_composite(glow, (ix - self.icon_pad, iy - self.icon_pad))
        img.alpha_composite(icon, (ix, iy))
        d = ImageDraw.Draw(img)
        x0_, y0_, x1_, y1_ = inner
        if live:
            # scan line: screen के अंदर ऊपर से नीचे, पीछे हल्की दुम
            t = (now % 1.7) / 1.7
            yy = y0_ + (y1_ - y0_) * t
            for k in range(4):
                a = int(210 * (1 - k / 4) ** 1.6)
                d.line([(ix + x0_ + 1, iy + yy - k * S), (ix + x1_ - 1, iy + yy - k * S)], fill=acc + (a,), width=max(1, int(1 * S)))
            d.line([(ix + x0_ + 1, iy + yy), (ix + x1_ - 1, iy + yy)], fill=(255, 255, 255, 200), width=max(1, int(1 * S)))
        else:
            cx, cy = ix + (x0_ + x1_) / 2, iy + (y0_ + y1_) / 2
            u = (x1_ - x0_) / 20
            wdt = max(2, int(2.2 * S))
            if self.tone == "ok":
                d.line([(cx - 4.5 * u, cy + 0.2 * u), (cx - 1.5 * u, cy + 3 * u), (cx + 5 * u, cy - 3.5 * u)], fill=acc + (255,), width=wdt, joint="curve")
            elif self.tone == "bad":
                d.line([(cx - 3.5 * u, cy - 3.5 * u), (cx + 3.5 * u, cy + 3.5 * u)], fill=acc + (255,), width=wdt)
                d.line([(cx + 3.5 * u, cy - 3.5 * u), (cx - 3.5 * u, cy + 3.5 * u)], fill=acc + (255,), width=wdt)
            else:
                d.rounded_rectangle([(cx - 4 * u, cy - 4 * u), (cx - 1.2 * u, cy + 4 * u)], radius=0.8 * u, fill=acc + (255,))
                d.rounded_rectangle([(cx + 1.2 * u, cy - 4 * u), (cx + 4 * u, cy + 4 * u)], radius=0.8 * u, fill=acc + (255,))

        # chip dot
        dx, dy = self.layout["dot"]
        r = 3 * S * (1 if done else (0.75 + 0.25 * breath))
        if live:
            gl = Image.new("RGBA", (int(20 * S), int(20 * S)), (0, 0, 0, 0))
            ImageDraw.Draw(gl).ellipse([(4 * S, 4 * S), (16 * S, 16 * S)], fill=acc + (int(140 * (0.45 + 0.55 * breath)),))
            gl = gl.filter(ImageFilter.GaussianBlur(3 * S))
            img.alpha_composite(gl, (int(dx - 10 * S), int(dy - 10 * S)))
            d = ImageDraw.Draw(img)
        d.ellipse([(dx - r, dy - r), (dx + r, dy + r)], fill=acc + (int(255 * (1 if done else (0.55 + 0.45 * breath))),))

        # details panel का "अभी" वाला dot (साँस लेता)
        ld = self.layout.get("live_dot")
        if ld:
            lx, ly = ld
            gl = Image.new("RGBA", (int(22 * S), int(22 * S)), (0, 0, 0, 0))
            ImageDraw.Draw(gl).ellipse([(5 * S, 5 * S), (17 * S, 17 * S)], fill=acc + (int(150 * (0.4 + 0.6 * breath)),))
            gl = gl.filter(ImageFilter.GaussianBlur(3 * S))
            img.alpha_composite(gl, (int(lx - 11 * S), int(ly - 11 * S)))
            d = ImageDraw.Draw(img)
            rr = 2.8 * S
            d.ellipse([(lx - rr, ly - rr), (lx + rr, ly + rr)], fill=acc + (255,))

        # bar
        bx, by, bw, bh = self.layout["bar"]
        if done:
            img.paste(Image.new("RGBA", (bw, bh), acc + (255,)), (bx, by), rr_mask(bw, bh, bh / 2))
        elif ph == "running" and s.get("step") and s.get("maxSteps"):
            fw = max(int(6 * S), int(bw * min(1.0, s["step"] / s["maxSteps"])))
            grad = np.zeros((bh, fw, 4), np.uint8)
            idx = (np.linspace(0, 96, fw)).astype(np.uint8)
            grad[..., :3] = self.lut[idx].astype(np.uint8)[None, :, :]
            grad[..., 3] = 255
            img.paste(Image.fromarray(grad, "RGBA"), (bx, by), rr_mask(fw, bh, bh / 2))
        else:
            segw = int(bw * 0.38)
            t = (now % 1.4) / 1.4
            sx = int(bx - segw + (bw + 2 * segw) * t)
            m = rr_mask(segw, bh, bh / 2)
            cl = Image.new("L", (bw, bh), 0)
            cl.paste(m, (sx - bx, 0))
            img.paste(Image.new("RGBA", (bw, bh), acc + (230,)), (bx, by), cl)

        # meta text with elapsed
        mx, my, f_small = self.layout["meta_pos"]
        base = self.layout["meta_base"]
        end = s.get("finishedAt") or (time.time() * 1000)
        # 'starting' में भी घड़ी चले — सुस्त machine पर agent का load minute
        # ले सकता है, और रुकी हुई घड़ी "अटक गया" लगती है।
        el = mmss(end - s["startedAt"]) if s.get("startedAt") else ""
        meta = " · ".join([p for p in (base, el) if p])
        d.text((mx - f_small.getlength(meta), my), meta, font=f_small, fill=(255, 255, 255, 150))

        # hint — अब यही रोकने का अकेला इशारा है (कोई Stop button नहीं), इस
        # लिए task के दौरान पूरा वक़्त दिखता है; सिर्फ़ आते वक़्त fade-in.
        if self.hint_t0 >= 0 and live:
            a = ease_out((now - self.hint_t0) / 0.5)
            hint = self.layout["hint"] if a >= 1 else alpha_scaled(self.layout["hint"], a)
            img.alpha_composite(hint, (0, self.content_h + int(8 * S)))

        # enter / leave
        k = ease_out((now - self.show_t0) / 0.48) if self.show_t0 >= 0 else 1.0
        alpha = ease_out((now - self.show_t0) / 0.32) if self.show_t0 >= 0 else 1.0
        if self.leave_t0 >= 0:
            kl = ease_out((now - self.leave_t0) / 0.35)
            k, alpha = 1 - kl, 1 - kl
        yoff = int(-28 * S * (1 - k))
        self.win.set_array(premul(img))
        self.win.show()
        self.win.flush(alpha=int(255 * alpha), x=(self.sw - self.WW) // 2, y=yoff, h=img.height)
        return img


# ---------------------------------------------------------------- app
class OverlayApp:
    def __init__(self) -> None:
        self.q: "queue.Queue[Optional[Dict[str, Any]]]" = queue.Queue()
        self._out_lock = threading.Lock()
        self.sw, self.sh = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
        try:
            self.S = user32.GetDpiForSystem() / 96.0
        except Exception:  # noqa: BLE001
            self.S = 1.0
        self.aura = Aura(self.sw, self.sh, self.S)
        self.comet = Comet(self.S)
        self.hud = Hud(self.sw, self.S, self.emit)
        self.state: Dict[str, Any] = {"phase": "idle"}
        self.running = True

    def emit(self, event: str, **fields: Any) -> None:
        with self._out_lock:
            sys.stdout.write(json.dumps({"event": event, **fields}, ensure_ascii=False) + "\n")
            sys.stdout.flush()

    def _reader(self) -> None:
        for raw in sys.stdin:
            raw = raw.strip()
            if not raw:
                continue
            try:
                self.q.put(json.loads(raw))
            except json.JSONDecodeError:
                self.emit("error", message="invalid json")
        self.q.put(None)

    def _apply(self, msg: Dict[str, Any], now: float) -> None:
        cmd = msg.get("cmd")
        if cmd == "state":
            s = msg.get("state") or {"phase": "idle"}
            self.state = s
            self.hud.set_state(s, now)
            ph = s.get("phase", "idle")
            live = ph in ("starting", "running", "stopping")
            if ph == "done":
                _, tone = DONE_LABEL.get(s.get("status") or "", ("", "warn"))
                self.aura.set_tone(tone, now)
                self.aura.fade_to(0.0, now)
            elif live:
                self.aura.set_tone("live", now)
                self.aura.fade_to(1.0, now)
            else:
                self.aura.fade_to(0.0, now)
        elif cmd == "hide":
            self.state = {"phase": "idle"}
            self.hud.hide()
            self.aura.alpha = self.aura.alpha_target = 0.0
            self.aura.win.hide()
            self.comet.win.hide()
        elif cmd == "expand":
            self.hud.set_expanded(bool(msg.get("value", True)))
        elif cmd == "snapshot":
            self._snapshot(msg.get("path") or "overlay-snapshot.png", now)
        elif cmd == "shutdown":
            self.running = False
        elif cmd == "ping":
            self.emit("pong")

    def _snapshot(self, path: str, now: float) -> None:
        """Debug: HUD + aura को एक तस्वीर में (असल screenshot में यह नहीं आते)।"""
        try:
            bg = Image.new("RGBA", (self.sw, self.sh), (58, 60, 68, 255))
            a = self.aura.buf.copy()
            aura = Image.fromarray(np.dstack([a[..., 2], a[..., 1], a[..., 0], a[..., 3]]), "RGBA")
            # premultiplied -> straight
            arr = np.asarray(aura).astype(np.float32)
            al = np.maximum(arr[..., 3:4], 1)
            arr[..., :3] = np.clip(arr[..., :3] * 255 / al, 0, 255)
            arr[..., 3] *= self.aura.alpha
            aura = Image.fromarray(arr.astype(np.uint8), "RGBA")
            bg.alpha_composite(aura)
            hud = self.hud.frame(now)
            if hud is not None:
                bg.alpha_composite(hud, ((self.sw - self.hud.WW) // 2, 0))
            bg.convert("RGB").save(path)
            self.emit("snapshot", path=path)
        except Exception as err:  # noqa: BLE001
            self.emit("error", message=f"snapshot: {err}")

    def run(self) -> None:
        threading.Thread(target=self._reader, name="stdin", daemon=True).start()
        self.emit("ready", screen={"width": self.sw, "height": self.sh}, scale=self.S, pid=os.getpid())
        msg = wintypes.MSG()
        pt = wintypes.POINT()
        n = 0
        t_prev = time.perf_counter()
        while self.running:
            try:
                while True:
                    m = self.q.get_nowait()
                    if m is None:
                        self.running = False
                        break
                    self._apply(m, time.perf_counter())
            except queue.Empty:
                pass
            if not self.running:
                break
            while user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, PM_REMOVE):
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))
            now = time.perf_counter()
            ph = self.state.get("phase", "idle")
            live = ph in ("starting", "running", "stopping")
            try:
                if ph != "idle":
                    if n % 4 == 0 or self.aura.alpha > 0:
                        if n % 4 == 0:
                            self.aura.frame(now)
                    user32.GetCursorPos(ctypes.byref(pt))
                    self.hud.set_pointer(pt.x, pt.y, now)
                    if n % 2 == 0:
                        self.hud.frame(now)
                    self.comet.frame(now, (pt.x, pt.y), live, ph == "running")
                else:
                    self.comet.frame(now, (0, 0), False, False)
                    self.hud.frame(now)
                    self.aura.win.hide()
            except Exception:  # noqa: BLE001
                log.error("frame: %s", traceback.format_exc())
            n += 1
            elapsed = time.perf_counter() - t_prev
            time.sleep(max(0.0, (1 / 60) - elapsed))
            t_prev = time.perf_counter()
        for w in (self.hud.win, self.comet.win, self.aura.win):
            w.destroy()


def _demo_sequence(t0: float) -> List[Tuple[float, Dict[str, Any]]]:
    task = "Open Notepad and type hello"
    h1 = [{"step": 1, "thought": "Open the Start menu and search for Notepad", "action": "agent.click(\"Start button\", 1, \"left\")", "at": 2600}]
    h2 = h1 + [{"step": 2, "thought": "Click into the text area and type the message", "action": "agent.type(\"hello\")", "at": 5100}]
    h3 = h2 + [{"step": 3, "thought": "Verify the text appears, then finish", "action": "agent.done()", "at": 8200}]
    base = {"id": "d1", "task": task, "source": "voice", "maxSteps": 50, "startedAt": t0}
    return [
        (0.0, {"cmd": "state", "state": {**base, "phase": "starting", "step": 0, "history": []}}),
        (2.5, {"cmd": "state", "state": {**base, "phase": "running", "step": 1, "thought": h1[-1]["thought"], "history": h1}}),
        (5.0, {"cmd": "state", "state": {**base, "phase": "running", "step": 2, "thought": h2[-1]["thought"], "history": h2}}),
        (8.0, {"cmd": "state", "state": {**base, "phase": "running", "step": 3, "thought": h3[-1]["thought"], "history": h3}}),
        (11.0, {"cmd": "state", "state": {**base, "phase": "done", "step": 3, "steps": 3, "status": "done", "history": h3,
                                          "summary": "Task completed in 3 steps. Final screen: Notepad shows hello.", "finishedAt": t0 + 11000}}),
        (16.5, {"cmd": "state", "state": {**base, "phase": "done", "leaving": True, "status": "done", "summary": "x", "steps": 3, "history": h3, "finishedAt": t0 + 11000}}),
        (17.0, {"cmd": "hide"}),
        (17.5, {"cmd": "shutdown"}),
    ]


def _demo() -> None:
    app = OverlayApp()
    seq = _demo_sequence(time.perf_counter() * 1000)
    start = time.perf_counter()

    def feeder():
        for at, m in seq:
            while time.perf_counter() - start < at:
                time.sleep(0.02)
            app.q.put(m)
    threading.Thread(target=feeder, daemon=True).start()
    app.run()


if __name__ == "__main__":
    if "--demo" in sys.argv:
        _demo()
    else:
        OverlayApp().run()
