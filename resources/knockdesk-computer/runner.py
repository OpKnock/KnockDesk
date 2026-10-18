"""KnockDesk Computer — Agent S3 का sidecar।

यह process KnockDesk desktop app (Electron) के अंदर से चलता है और screen पर
इंसान की तरह mouse/keyboard चलाता है। दिमाग़ Agent S3 का है
(``gui-agents`` package, बिल्कुल वही जो ``agent-s-lab`` के ``start.bat`` से
चलता है) — फ़र्क़ सिर्फ़ इतना कि terminal के ``Query:`` prompt की जगह काम
Electron से आता है।

ज़िंदगी (resident service — Hermes की तरह):

    Process app के साथ उठता है, agent का दिमाग़ (gui_agents, ~2700 modules)
    उसी वक़्त main thread पर load होता है (stdin पढ़ने से पहले — वजह
    Runner._stdin_lines पर), और process app बंद होने तक ज़िंदा रहता है।
    ``ready`` सिर्फ़ load के बाद जाता है — इस से पहले Electron कोई task नहीं
    भेजता। Load के दौरान हर 3 s ``loading`` की धड़कन।

    "Stop" task रोकता है, process नहीं: चलती हुई cloud call काट दी जाती है
    (देखो _abort_llm_calls), cursor फ़ौरन वापस, और agent loaded का loaded
    रहता है — अगला task फ़ौरन शुरू। पहले stop = process का क़त्ल था, और
    हर अगले task पर 26-500 s का दोबारा load।

Protocol — NDJSON, एक line एक संदेश:

    stdin  (Electron -> यहाँ)
        {"cmd":"run","id":"t1","task":"open notepad and type hello","max_steps":50,
         "overlay":true,"fast":false}
        {"cmd":"stop","id":"t1"}
        {"cmd":"ping"}
        {"cmd":"shutdown"}

    stdout (यहाँ -> Electron)
        {"event":"booting","screen":{...},"pid":123}          # process ज़िंदा, load शुरू
        {"event":"loading","elapsed":12.0,"stage":"loading agent"}   # हर 3 s
        {"event":"ready","screen":{"width":1920,"height":1080},"seconds":4.2}  # agent loaded
        {"event":"load_error","message":"..."}                # फिर process exit 2
        {"event":"task_started","id":"t1"}
        {"event":"step","id":"t1","step":3,"max_steps":50,"thought":"...","action":"..."}
        {"event":"stopping","id":"t1"}
        {"event":"task_done","id":"t1","status":"done","steps":7,"summary":"..."}
        {"event":"pong","busy":false,"loaded":true}
        {"event":"error","message":"..."}

``status`` की क़ीमत: done | failed | stopped | interrupted | max_steps | error.

एक वक़्त में सिर्फ़ एक task। दूसरा आए तो ``error`` के साथ रद्द होता है —
mouse एक ही है।

Config सिर्फ़ environment से आती है (Electron spawn पर देता है):

    KNOCKDESK_COMPUTER_API_URL          OpenAI-compatible base URL (gateway या OpenRouter)
    KNOCKDESK_COMPUTER_API_KEY          उस के लिए key
    KNOCKDESK_COMPUTER_PLANNER_MODEL    सोचने वाला model   (default openai/gpt-5.6-sol)
    KNOCKDESK_COMPUTER_GROUNDING_MODEL  x,y बताने वाला     (default bytedance/ui-tars-1.5-7b)
    KNOCKDESK_COMPUTER_GROUNDING_WIDTH / _HEIGHT   dev override; ख़ाली = screenshot के नाप से
    KNOCKDESK_COMPUTER_TESSERACT        tesseract.exe का पूरा रास्ता (OCR के लिए)
    KNOCKDESK_COMPUTER_MAX_TRAJECTORY   कितने screenshots याद रखे (default 8)

NOTE: ये नाम अब `KNOCKDESK_COMPUTER_*` हैं - पुराना `STONIC_COMPUTER_*`
स्पेल अब भी fallback की तरह चलता है, ताकि पुरानी configs टूटें नहीं।

Safety जो यहाँ है:
  - pyautogui FAILSAFE: mouse screen के top-left कोने में = फ़ौरन बंद।
  - User ने ख़ुद mouse हिलाया (steps के दरमियान) = "interrupted", agent रुक जाता है।
  - ``stop`` command चलती हुई cloud call को काट देती है और action के
    अंदर के sleep को भी — task एक-दो second में रुकता है, process ज़िंदा।
    सिर्फ़ असली hang पर Electron process मारता है (और supervisor दोबारा उठाता है)।
  - Overlay agent के screenshots में नज़र नहीं आता (WDA_EXCLUDEFROMCAPTURE)।
"""

from __future__ import annotations

import ctypes
import io
import json
import logging
import math
import os
import platform
import re
import sys
import threading
import time
import traceback
import weakref
from typing import Any, Dict, List, Optional


# ── DPI awareness — pyautogui import से पहले ───────────────────────────────
#
# Windows पर display scaling (125%, 150%) के साथ एक non-DPI-aware process
# को screen छोटी दिखती है: screenshot 1536x864 आता है मगर असल screen
# 1920x1080 होती है, और हर click ग़लत जगह लगता है। Per-monitor-v2
# awareness से screenshot और click दोनों असल pixels में होते हैं.
def _make_dpi_aware() -> None:
    if platform.system() != "Windows":
        return
    try:
        user32 = ctypes.windll.user32
        user32.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
        if user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
            return
    except Exception:
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE
    except Exception:
        pass


_make_dpi_aware()

import pyautogui  # noqa: E402
from PIL import Image  # noqa: E402

pyautogui.FAILSAFE = True

# Overlay — KnockDesk का अपना हिस्सा। न मिले तो agent normal चलता है।
try:
    from knockdesk_overlay import AgentOverlay, restore_system_cursors
except Exception:  # noqa: BLE001
    AgentOverlay = None


def _noop_overlay() -> None:
    def restore_system_cursors() -> bool:  # type: ignore[misc]
        return False


# ── Logging: सिर्फ़ stderr पर। stdout protocol के लिए महफ़ूज़ है। ───────────
logging.basicConfig(
    level=os.environ.get("KNOCKDESK_COMPUTER_LOG_LEVEL") or os.environ.get("STONIC_COMPUTER_LOG_LEVEL") or "INFO",
    stream=sys.stderr,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("knockdesk-computer")


# ── Config ───────────────────────────────────────────────────────────────────
def _env(name: str, default: str = "") -> str:
    """KNOCKDESK_COMPUTER_* naam parhta hai; purana STONIC_COMPUTER_* bhi chalta hai."""
    value = os.environ.get(name)
    if value is None and name.startswith("KNOCKDESK_COMPUTER_"):
        value = os.environ.get("STONIC_COMPUTER_" + name[len("KNOCKDESK_COMPUTER_"):])
    return (value or default).strip()


API_URL = _env("KNOCKDESK_COMPUTER_API_URL")
API_KEY = _env("KNOCKDESK_COMPUTER_API_KEY")
# "byok" = Lifetime customer की अपनी OpenRouter key, सीधा OpenRouter। बाक़ी सब
# (ख़ाली भी) = KnockDesk Cloud का gateway। सिर्फ़ ग़लती का पाठ इस पर बदलता है
# (देखो `_explain_error`) — चलने का तरीक़ा दोनों पर एक है।
ROUTE = _env("KNOCKDESK_COMPUTER_ROUTE", "cloud").lower()
# Logical नाम — gateway इन्हें असली model पर मोड़ देता है। Electron हमेशा
# यह ख़ुद भेजता है; यह default सिर्फ़ runner को अकेले चलाने के लिए है।
# NOTE: `stonic-computer-planner/grounding` default मान gateway mapping के हैं — न बदलें।
PLANNER_MODEL = _env("KNOCKDESK_COMPUTER_PLANNER_MODEL", "stonic-computer-planner")
GROUNDING_MODEL = _env("KNOCKDESK_COMPUTER_GROUNDING_MODEL", "stonic-computer-grounding")
# Grounding के नाप जानबूझ कर 0 हैं — असली क़ीमत उस तस्वीर से निकलती
# है जो model को भेजी जाती है (देखो __init__)। Agent S3 का अपना help text:
# "Width of screenshot image after processor rescaling"। यानी यह model की कोई
# fixed ख़ासियत नहीं, उस image का नाप है जो उसने देखी। पहले यहाँ 1920x1080
# लिखा था — वह सिर्फ़ 1080p screen पर सच था, जहाँ screenshot बिना छोटा
# हुए उसी नाप का रहता है। 2K (2560x1440) पर screenshot 2400x1350 जाता था
# मगर model को 1920x1080 बताया जाता था, तो हर coordinate 25% बढ़ कर
# निकलता: click button से नीचे-दाएँ खिसक जाता। Env सिर्फ़ dev का override.
GROUNDING_W = int(_env("KNOCKDESK_COMPUTER_GROUNDING_WIDTH", "0"))
GROUNDING_H = int(_env("KNOCKDESK_COMPUTER_GROUNDING_HEIGHT", "0"))
MAX_TRAJECTORY = int(_env("KNOCKDESK_COMPUTER_MAX_TRAJECTORY", "8"))
TESSERACT = _env("KNOCKDESK_COMPUTER_TESSERACT")

# Screenshot का बड़ा से बड़ा रुख़। 1920 इस लिए कि UI-TARS के coordinates उसी
# तस्वीर के पैमाने में आते हैं जो उसे भेजी गई, और 1920x1080 वही नाप
# है जिस पर यह pipeline असल में सही चलती है (1080p laptop पर clicks
# ठीक, और 2K monitor को 1920x1080 पर ला कर भी ठीक)। हर display को इसी
# नाप पर ला देने से monitor पर वही accuracy मिलती है जो laptop पर है।
# Lab में 2400 था — वहाँ screen 1920x1080 थी, तो यह cap लगता ही नहीं था।
SCREENSHOT_MAX_DIM = 1920
# Step के बाद इतनी देर इंतज़ार (UI को settle होने दो) — lab में भी 1.0 था।
POST_ACTION_WAIT_S = 1.0
# User का mouse इतने pixel हिल जाए तो "interrupted"।
USER_MOUSE_MOVE_PX = 60
# एक cloud call ज़्यादा से ज़्यादा इतनी देर। OpenAI SDK का default 10 MINUTE है —
# एक अटकी हुई call पूरे task को उतनी देर लटका सकती थी।
LLM_TIMEOUT_S = float(_env("KNOCKDESK_COMPUTER_LLM_TIMEOUT_S", "120"))
# Stop के बाद worker thread को अपने आप ख़त्म होने के लिए इतना वक़्त; फिर
# task को "stopped" लिख कर thread को पीछे छोड़ दिया जाता है (abandoned)।
STOP_JOIN_S = 4.0
# नया task, पिछले (abandoned) thread के mouse छोड़ने का इंतज़ार ज़्यादा से
# ज़्यादा इतना करे — cloud call का timeout इस के अंदर है।
ABANDON_WAIT_S = LLM_TIMEOUT_S + 15.0


def _configure_tesseract() -> None:
    if not TESSERACT:
        return
    try:
        import pytesseract

        pytesseract.pytesseract.tesseract_cmd = TESSERACT
        # tessdata exe के साथ वाले folder में है।
        os.environ.setdefault("TESSDATA_PREFIX", os.path.join(os.path.dirname(TESSERACT), "tessdata"))
    except Exception as err:  # noqa: BLE001
        log.warning("pytesseract configure नहीं हुआ: %s", err)


# ── stdout पर संदेश ───────────────────────────────────────────────────────
class Emitter:
    def __init__(self) -> None:
        self._lock = threading.Lock()

    def send(self, event: str, **fields: Any) -> None:
        line = json.dumps({"event": event, **fields}, ensure_ascii=False)
        with self._lock:
            # Waqt ki asli pipe — third-party libraries (gui-agents) sys.stdout
            # ko badalte hain, protocol ko nuqsan na ho.
            _PROTOCOL_OUT.write(line + "\n")
            _PROTOCOL_OUT.flush()


emit = Emitter()


class _LibraryStdoutToStderr:
    """gui-agents apne retry/status messages seedha ``print`` karta hai, jo
    NDJSON protocol wali stdout ko kharab kar deta hai ("Attempt 1 failed..."
    lines). Agent ke load aur ``predict`` ke daoran stdout ko stderr par
    bhejo; Emitter ki asli pipe alag mehfooz hai."""

    def __enter__(self) -> "_LibraryStdoutToStderr":
        self._saved = sys.stdout
        sys.stdout = sys.stderr
        return self

    def __exit__(self, *exc: Any) -> bool:
        sys.stdout = self._saved
        return False


_PROTOCOL_OUT = sys.stdout


class TaskStopped(BaseException):
    """Electron ने ``stop`` भेजा।

    जानबूझ कर BaseException, Exception नहीं: gui_agents का हर LLM रास्ता
    ``except Exception`` के retry loops में लिपटा है (call_llm_safe 3 दफ़ा,
    backoff 60 s तक)। Exception होता तो stop का signal वहीं निगल लिया जाता
    और task चलता रहता। BaseException उन सब से आर-पार सीधा हमारे
    ``_loop`` तक आता है। (KeyboardInterrupt इसी वजह से BaseException है।)
    """


class UserInterrupted(Exception):
    """User ने ख़ुद mouse हिलाया — machine वापस user की।"""


# ── Plan के पाठ से इंसान के पढ़ने वाला हिस्सा निकालना ─────────────────────
_SECTION_RE = re.compile(r"\((Previous action verification|Screenshot Analysis|Next Action|Grounded Action)\)", re.I)


def _plan_sections(plan: str) -> Dict[str, str]:
    """Agent S के जवाब को उसके चार हिस्सों में तोड़ना।"""
    out: Dict[str, str] = {}
    if not plan:
        return out
    parts = _SECTION_RE.split(plan)
    # parts = [pre, name1, body1, name2, body2, ...]
    for i in range(1, len(parts) - 1, 2):
        out[parts[i].lower()] = parts[i + 1].strip()
    return out


def _clip(text: str, n: int) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def _scaled_size(width: int, height: int, max_dim: int) -> tuple[int, int]:
    factor = min(max_dim / width, max_dim / height, 1)
    return int(width * factor), int(height * factor)


# ── Cloud gateway की रुकावटें ───────────────────────────────────────
#
# Gateway (`/v1/computer/chat/completions`) सिर्फ़ models का proxy नहीं — वही
# एक जगह है जहाँ plan का gate लगता है और हर step का ख़र्चा user के
# daily/monthly quota से कटता है। यानी "quota ख़त्म" एक आम सूरत है, कोई
# अनहोनी नहीं, और उसे दो जगह ठीक से सँभालना पड़ता है।
#
# ── 1. 60 second का बेकार इंतज़ार ────────────────────────────────────
#
# Agent S का हर `generate` `backoff.on_exception(..., APIError, max_time=60)`
# से लिपटा हुआ है। `APIError` OpenAI SDK में हर HTTP ग़लती का बाप है —
# यानी 402 "plan ख़त्म" पर भी वह पूरे 60 second तक दोबारा कोशिश करता
# रहता है। ऐसी ग़लती पर इंतज़ार का कोई फ़ायदा नहीं: 60 second बाद भी
# plan ख़त्म ही रहेगा। User के लिए यह सिर्फ़ एक लंबा सन्नाटा है।
#
# इस लिए वही decorator दोबारा लगाते हैं, मगर एक `giveup` शर्त के साथ।
# असल (बिन-लिपटा) function `__wrapped__` से मिलता है — `functools.wraps` उसे
# वहीं छोड़ जाता है। Retry का निज़ाम वैसा ही रहता है; सिर्फ़ वह ग़लतियाँ
# बाहर निकल आती हैं जो इंतज़ार से ठीक होती ही नहीं।
#
# ── 2. Message ───────────────────────────────────────────────────
#
# और उस के बाद user को "APIStatusError: Error code: 402 - {...}" दिखाना
# बेफ़ायदा है। `_friendly_error` उसे उस एक line में बदलता है जो बंदा
# वाक़ई पढ़ कर समझ सके।

# वह status जिन पर दोबारा कोशिश का कोई मतलब नहीं: request ख़ुद ग़लत है,
# key ग़लत है, या plan/पैसा ख़त्म है। इन में से कोई भी 60 second में
# नहीं बदलता।
_PERMANENT_STATUS = {400, 401, 402, 403, 404}

# Quota की हद 429 पर आती है — मगर वह reset घंटों बाद होता है, मिनटों
# बाद नहीं। क़तार भरी होने वाला 429 (limits.js) इस से अलग है और उस पर
# इंतज़ार वाक़ई काम करता है, इस लिए फ़र्क़ body के पाठ से किया जाता है।
_QUOTA_MARKERS = ("daily_limit", "monthly_limit", "insufficient_balance")

# 503 आम तौर पर "थोड़ी देर बाद ठीक हो जाएगा" होता है, मगर gateway के यह
# दो 503 config की ग़लती हैं — वह इंतज़ार से कभी ठीक नहीं होते।
_CONFIG_MARKERS = ("billing_not_configured", "upstream_not_configured")


def _error_body(err: Exception) -> str:
    """API ग़लती का जवाब — जितना मिल सके।"""
    for attr in ("response", "body"):
        obj = getattr(err, attr, None)
        if obj is None:
            continue
        text = getattr(obj, "text", None)
        if isinstance(text, str) and text:
            return text
        if isinstance(obj, (str, dict)):
            return str(obj)
    return str(err)


def _giveup_on_permanent(err: Exception) -> bool:
    status = getattr(err, "status_code", None)
    if status in _PERMANENT_STATUS:
        return True
    body = _error_body(err).lower()
    if status == 429:
        return any(m in body for m in _QUOTA_MARKERS)
    if status == 503:
        return any(m in body for m in _CONFIG_MARKERS)
    return False


def _install_billing_fastfail() -> None:
    """Agent S के engines पर `giveup` शर्त लगाओ (ऊपर वाली वजह)।"""
    try:
        import backoff
        from openai import APIConnectionError, APIError, RateLimitError
        from gui_agents.s3.core import engine as s3_engine
    except Exception as err:  # noqa: BLE001
        log.warning("billing fast-fail नहीं लगा (import): %s", err)
        return

    for name in ("LMMEngineOpenRouter", "LMMEngineOpenAI"):
        cls = getattr(s3_engine, name, None)
        raw = getattr(getattr(cls, "generate", None), "__wrapped__", None)
        if cls is None or raw is None:
            # Package का ढाँचा बदल गया — चलने दो, सिर्फ़ retry लंबा रहेगा।
            log.warning("billing fast-fail: %s पर seam नहीं मिला", name)
            continue
        cls.generate = backoff.on_exception(
            backoff.expo,
            (APIConnectionError, APIError, RateLimitError),
            max_time=60,
            giveup=_giveup_on_permanent,
        )(raw)


def _friendly_error(err: Exception) -> Optional[str]:
    """Cloud की रुकावट को आम ज़बान में। न पहचाने तो `None`।"""
    status = getattr(err, "status_code", None)
    if status is None:
        return None
    body = _error_body(err).lower()

    if status == 401:
        return "KnockDesk Cloud sign-in की मुद्दत ख़त्म हो गई। App में दोबारा sign in करें।"
    if status == 403:
        return "इस account पर KnockDesk Cloud बंद है। Support से राब्ता करें।"
    if status == 402 or (status == 429 and any(m in body for m in _QUOTA_MARKERS)):
        if "monthly_limit" in body:
            return "इस महीने की usage limit ख़त्म हो गई। Computer use अगले billing cycle पर चलेगा।"
        if "daily_limit" in body:
            return "आज की usage limit ख़त्म हो गई। Computer use कुछ घंटों बाद फिर चलेगा।"
        return "Subscription active नहीं या balance ख़त्म है। Plan renew होने पर computer use चलेगा।"
    if status == 429:
        return "Cloud अभी मसरूफ़ है। थोड़ी देर बाद दोबारा कोशिश करें।"
    if status == 503 and any(m in body for m in _CONFIG_MARKERS):
        return "Computer use अभी cloud पर set नहीं है (server config)। Support को बताएँ।"
    if status >= 500:
        return "Cloud से जवाब नहीं मिला। थोड़ी देर बाद दोबारा कोशिश करें।"
    return None


# ── Custom API: user की अपनी OpenRouter key ─────────────────────────────────
#
# ऊपर वाला पाठ सिर्फ़ Cloud का है। पहले (5 Oct 2026 तक) वही पाठ Lifetime
# customer को भी सुनाया जाता था: OpenRouter के credits ख़त्म हों तो "Plan
# renew करें", key ग़लत हो तो "KnockDesk Cloud में दोबारा sign in करें" —
# उस बंदे को जिस का कोई plan है ही नहीं। उस ने ठीक क्या करना है यह कभी
# पता ही नहीं चलता था।
#
# इस रास्ते पर रुकावट user के अपने OpenRouter account की होती है, और हल
# भी वहीं है। `kind` वही नाम हैं जो app का card पहचानता है
# (src/lib/api-issue.ts) — वहाँ से "Add credits" / "Open Settings" का button
# बनता है। पाठ अंग्रेज़ी में: यह voice के model को जाता है, जो उसे user की
# ज़बान में बोलता है।
#
# OpenRouter के code (docs: api-reference/errors): 401 key रद्द, 402 account या
# key के credits ख़त्म, 403 guardrail/इजाज़त, 429 rate limit.
_KEY_LIMIT_MARKERS = ("key limit exceeded", "limit exceeded for this key", "key spending limit")
_NO_ENDPOINT_MARKERS = ("no endpoints found", "data policy", "no allowed providers")


def _explain_byok_error(err: Exception) -> tuple[Optional[str], Optional[str]]:
    """OpenRouter की रुकावट -> (kind, पाठ)। न पहचाने तो (None, None)।"""
    status = getattr(err, "status_code", None)
    if status is None:
        return None, None
    body = _error_body(err).lower()

    if any(m in body for m in _KEY_LIMIT_MARKERS):
        return "key_limit", (
            "This OpenRouter API key has reached the spending limit set on it. "
            "Raise the key's limit on openrouter.ai (Settings → Keys), or use another key"
        )
    if status == 401:
        return "invalid_key", (
            "OpenRouter rejected the API key saved in KnockDesk (wrong, deleted or disabled). "
            "Paste a working OpenRouter key in Settings → AI Engine"
        )
    if status == 402:
        return "no_credits", (
            "The OpenRouter key is fine, but the OpenRouter account has no credits left. "
            "Add credits on openrouter.ai (Settings → Credits), then try again"
        )
    if any(m in body for m in _NO_ENDPOINT_MARKERS):
        return "model_unavailable", (
            "OpenRouter has no provider for the computer-control model with this account's privacy settings. "
            "Allow it on openrouter.ai (Settings → Privacy), then try again"
        )
    if status == 403:
        return "forbidden", (
            "OpenRouter refused the request (a guardrail or privacy setting on the account, or the key lacks permission). "
            "Check the OpenRouter account settings"
        )
    if status == 429:
        return "rate_limit", (
            "OpenRouter is rate-limiting this API key right now. Nothing is wrong with the key — "
            "wait a minute and try again"
        )
    if status >= 500:
        return None, "OpenRouter did not answer. Try again in a moment"
    return None, None


def _explain_error(err: Exception) -> tuple[Optional[str], Optional[str]]:
    """Task की ग़लती -> (kind, आम ज़बान का पाठ)। `kind` सिर्फ़ Custom API पर।"""
    if ROUTE == "byok":
        return _explain_byok_error(err)
    return None, _friendly_error(err)


# ── Stop को फ़ौरन असरदार बनाना: चलती हुई cloud call काटना ───────────
#
# Agent S के engines अपना OpenAI client ख़ुद बनाते हैं — बिना timeout के
# (SDK का default 10 minute)। "Stop" पहले सिर्फ़ steps के दरमियान देखा जाता
# था, और एक step 10-13 s की cloud call है। इस लिए stop कभी वक़्त पर नहीं
# रुकता था; Electron 8 s बाद पूरा process मार देता (कल के log में 22 के
# 22 stops इसी रास्ते से गए)। Process मरने का मतलब: loaded agent गया,
# अगला task फिर 26-500 s का load — user को "Waking up the agent…" दोबारा।
#
# अब दो काम:
#   1. हर engine का client हम बनाते हैं (timeout के साथ) और एक registry
#      में रखते हैं — engine का अपना `if not self.llm_client` फिर कभी
#      नहीं चलता।
#   2. Stop पर registry के सारे clients बंद (close)। Windows पर चलती हुई
#      socket recv उसी लमहे टूट जाती है। और उन की जगह _AbortedClient रख
#      दिया जाता है जो हर अगली call पर TaskStopped फेंकता है — वरना
#      call_llm_safe नया client बना कर दोबारा कोशिश कर लेता।
#   नए task से पहले _revive_llm_clients() बंद clients की जगह नए
#   रखता है (planner के engines तो हर task पर नए बनते ही हैं; grounding
#   के पूरे process की ज़िंदगी के हैं)।
_engines: "weakref.WeakSet[Any]" = weakref.WeakSet()
_engines_lock = threading.Lock()


class _AbortedClient:
    """बंद किए गए client की जगह: हर इस्तेमाल पर TaskStopped।"""

    def __getattr__(self, name: str) -> Any:
        raise TaskStopped()


def _make_client(engine: Any) -> Any:
    import httpx
    from openai import OpenAI

    return OpenAI(
        base_url=engine.base_url,
        api_key=engine.api_key,
        timeout=httpx.Timeout(LLM_TIMEOUT_S, connect=15.0),
        max_retries=1,
    )


def _install_abortable_clients() -> None:
    """Engines के __init__ को लपेट दो: client हमारा, registry में दर्ज।"""
    try:
        from gui_agents.s3.core import engine as s3_engine
    except Exception as err:  # noqa: BLE001
        log.warning("abortable clients नहीं लगे (import): %s", err)
        return

    for name in ("LMMEngineOpenRouter", "LMMEngineOpenAI"):
        cls = getattr(s3_engine, name, None)
        if cls is None or getattr(cls, "_knockdesk_abortable", False):
            continue
        orig_init = cls.__init__

        def __init__(self: Any, *args: Any, _orig: Any = orig_init, **kwargs: Any) -> None:
            _orig(self, *args, **kwargs)
            if getattr(self, "base_url", None) and getattr(self, "api_key", None):
                self.llm_client = _make_client(self)
            with _engines_lock:
                _engines.add(self)

        cls.__init__ = __init__
        cls._knockdesk_abortable = True


def _abort_llm_calls() -> int:
    """चलती हुई cloud calls काटो; अगली calls फ़ौरन TaskStopped दें।"""
    with _engines_lock:
        engines = list(_engines)
    closed = 0
    for eng in engines:
        client = getattr(eng, "llm_client", None)
        eng.llm_client = _AbortedClient()
        if client is not None and not isinstance(client, _AbortedClient):
            try:
                client.close()
                closed += 1
            except Exception:  # noqa: BLE001
                pass
    return closed


def _revive_llm_clients() -> None:
    """नए task से पहले: बंद किए गए clients की जगह नए।"""
    with _engines_lock:
        engines = list(_engines)
    for eng in engines:
        if isinstance(getattr(eng, "llm_client", None), _AbortedClient):
            ok = getattr(eng, "base_url", None) and getattr(eng, "api_key", None)
            eng.llm_client = _make_client(eng) if ok else None


# Agent के actions का code `import time; time.sleep(8)` जैसा होता है
# (agent.wait)। वह sleep stop को नहीं देखता — 10 s का wait 10 s ही रुकता।
# चलाने से पहले `time.sleep(` को हमारे रुकने वाले sleep से बदल देते हैं।
_SLEEP_RE = re.compile(r"\btime\.sleep\(")


def _interruptible_sleep(stop: threading.Event):
    def _sleep(seconds: float) -> None:
        if stop.wait(max(0.0, float(seconds))):
            raise TaskStopped()

    return _sleep


class Task:
    """एक task का पूरा हिसाब — अपना stop signal, अपना thread।"""

    def __init__(self, task_id: str, text: str, max_steps: int, overlay: bool, fast: bool) -> None:
        self.id = task_id
        self.text = text
        self.max_steps = max_steps
        self.overlay = overlay
        self.fast = fast
        # हर task का अपना stop। एक मुश्तरका Event काफ़ी नहीं: stop के बाद
        # पीछे छोड़ा हुआ thread अगले task के `clear()` पर दोबारा चल पड़ता।
        self.stop = threading.Event()
        self.thread: Optional[threading.Thread] = None
        self.steps = 0
        self.abandoned = False
        self._done_sent = False
        self._lock = threading.Lock()

    def mark_done(self) -> bool:
        """True सिर्फ़ पहली दफ़ा — task_done एक ही बार जाता है।"""
        with self._lock:
            if self._done_sent:
                return False
            self._done_sent = True
            return True


# ── Agent ────────────────────────────────────────────────────────────────────
class ComputerAgent:
    """Agent S3 को एक दफ़ा बनाता है और tasks चलाता है।"""

    def __init__(self) -> None:
        if not API_URL or not API_KEY:
            raise RuntimeError("KNOCKDESK_COMPUTER_API_URL / KNOCKDESK_COMPUTER_API_KEY set नहीं हैं।")

        _configure_tesseract()

        from gui_agents.s3.agents.agent_s import AgentS3
        from gui_agents.s3.agents.grounding import OSWorldACI

        # Quota/auth वाली ग़लतियों पर 60 second का बेकार retry बंद करो।
        _install_billing_fastfail()
        # Stop पर चलती हुई cloud call काटी जा सके — engines बनने से पहले।
        _install_abortable_clients()

        self.screen_w, self.screen_h = pyautogui.size()
        self.scaled_w, self.scaled_h = _scaled_size(self.screen_w, self.screen_h, SCREENSHOT_MAX_DIM)
        self.platform = platform.system().lower()

        # दोनों model एक ही OpenAI-compatible दरवाज़े से — lab का `open_router`
        # engine यही करता है (base_url + api_key, और कुछ नहीं)।
        planner = {
            "engine_type": "open_router",
            "model": PLANNER_MODEL,
            "base_url": API_URL,
            "api_key": API_KEY,
            "temperature": None,
        }
        grounding = {
            "engine_type": "open_router",
            "model": GROUNDING_MODEL,
            "base_url": API_URL,
            "api_key": API_KEY,
            # वही नाप जो `obs["screenshot"]` का है (देखो _loop) — इस से
            # OSWorldACI.resize_coordinates का हिसाब
            # `coord * screen / screenshot` बन जाता है, जो हर resolution और
            # हर aspect ratio पर ठीक है। 1080p पर दोनों 1920x1080 ही निकलते
            # हैं, यानी वहाँ behaviour बिल्कुल पहले जैसा।
            "grounding_width": GROUNDING_W or self.scaled_w,
            "grounding_height": GROUNDING_H or self.scaled_h,
        }

        # env=None: code agent (arbitrary Python/Bash) जानबूझ कर बंद है।
        # Terminal का काम Hermes के पास पहले से है; यहाँ सिर्फ़ GUI.
        self.grounding_agent = OSWorldACI(
            env=None,
            platform=self.platform,
            engine_params_for_generation=planner,
            engine_params_for_grounding=grounding,
            width=self.screen_w,
            height=self.screen_h,
        )
        self._patch_text_coords()
        self.agent = AgentS3(
            planner,
            self.grounding_agent,
            platform=self.platform,
            max_trajectory_length=MAX_TRAJECTORY,
            enable_reflection=True,
        )

        # Agent का बनाया हुआ code इसी namespace में चलता है (देखो _loop)।
        # `pyautogui` और `time` पहले से मौजूद हैं क्योंकि हर action का code
        # उन्हें ख़ुद import करता है — मगर रखने से पहला step एक import
        # बचा लेता है, और यह namespace साफ़ भी रहता है: यहाँ सिर्फ़ वही
        # है जो agent को चाहिए, पूरा module नहीं।
        self._exec_ns: Dict[str, Any] = {"__builtins__": __builtins__, "pyautogui": pyautogui, "time": time}
        log.info(
            "Agent तैयार: screen %dx%d, planner=%s, grounding=%s",
            self.screen_w, self.screen_h, PLANNER_MODEL, GROUNDING_MODEL,
        )

    # ── OCR वाले coords का नाप दुरुस्त करो ─────────────────────────────────
    #
    # `highlight_text_span` (text select करना) बाक़ी actions से अलग चलता
    # है: वह grounding model से नहीं, Tesseract से पूछता है कि लफ़्ज़ कहाँ
    # है। और उस के जवाब पर upstream `resize_coordinates` लगाना भूल गया
    # है (gui_agents/s3/agents/grounding.py — बाक़ी 13 actions पर लगता है,
    # इसी एक पर नहीं)। नतीजा: OCR तस्वीर के pixel देता है और वह सीधे
    # screen के pixel मान कर mouse चला दिया जाता है।
    #
    # 1080p पर यह ग़लती छुपी रहती है क्योंकि तस्वीर और screen का नाप
    # बराबर होता है। जहाँ screenshot छोटा होता है (2K, 4K) वहाँ text
    # की selection ग़लत जगह लग जाती है।
    #
    # यहाँ सिर्फ़ वही छूटा गया step लगाया जा रहा है — कोई नया हिसाब
    # नहीं। नाप बराबर हो (1080p) तो हाथ भी नहीं लगता।
    def _patch_text_coords(self) -> None:
        if (self.scaled_w, self.scaled_h) == (self.screen_w, self.screen_h):
            return
        aci = self.grounding_agent
        inner = aci.generate_text_coords
        sx = self.screen_w / self.scaled_w
        sy = self.screen_h / self.scaled_h

        def to_screen(phrase: str, obs: Dict[str, Any], alignment: str = "") -> List[int]:
            x, y = inner(phrase, obs, alignment=alignment)
            return [round(x * sx), round(y * sy)]

        aci.generate_text_coords = to_screen
        log.info("OCR coords का नाप दुरुस्त: x*%.4f, y*%.4f", sx, sy)

    # ── एक task ─────────────────────────────────────────────────────────────
    def run(self, t: Task) -> Dict[str, Any]:
        # fast = reflection बंद (हर step पर एक LLM call कम, ~30% तेज़)।
        self.agent.enable_reflection = not t.fast
        self.agent.reset()  # नया Worker, साफ़ याददाश्त — हर task self-contained
        # Actions के अंदर का `time.sleep` इस task के stop को देखे।
        self._exec_ns["_knockdesk_sleep"] = _interruptible_sleep(t.stop)

        overlay = None
        started = time.time()
        steps_done = 0
        last_sections: Dict[str, str] = {}
        status = "max_steps"
        error: Optional[str] = None
        error_kind: Optional[str] = None
        try:
            # पहले ख़बर, फिर cursor — HUD उसी लमहे "Working" पर आ जाए।
            emit.send("task_started", id=t.id, max_steps=t.max_steps)
            if t.overlay and AgentOverlay is not None:
                try:
                    overlay = AgentOverlay().start()
                except Exception as err:  # noqa: BLE001
                    log.warning("Overlay नहीं चला: %s", err)
            status = self._loop(t)
        except TaskStopped:
            status = "stopped"
        except UserInterrupted:
            status = "interrupted"
        except pyautogui.FailSafeException:
            status = "stopped"
            error = "failsafe: mouse top-left corner"
        except Exception as err:  # noqa: BLE001
            status = "error"
            # रुकावट (quota, sign-in, user की अपनी key) आम सी बात है — उसे
            # raw stack trace की तरह नहीं, सीधी बात की तरह दिखाओ।
            error_kind, friendly = _explain_error(err)
            error = friendly or f"{type(err).__name__}: {err}"
            log.error("Task crash: %s\n%s", err, traceback.format_exc())
        finally:
            if overlay is not None:
                try:
                    overlay.stop()
                except Exception:  # noqa: BLE001
                    pass
            steps_done = self.agent.executor.turn_count
            if self.agent.executor.worker_history:
                last_sections = _plan_sections(self.agent.executor.worker_history[-1])

        summary = self._summary(status, steps_done, last_sections, error)
        return {
            "id": t.id,
            "status": status,
            "steps": steps_done,
            "seconds": round(time.time() - started, 1),
            "summary": summary,
            "notes": list(self.grounding_agent.notes or []),
            "error": error,
            # Custom API पर user की key/account की वजह — app इस से card खोलती है।
            "error_kind": error_kind,
        }

    def _loop(self, t: Task) -> str:
        obs: Dict[str, Any] = {}
        agent_mouse: Optional[tuple[int, int]] = None

        for step in range(1, t.max_steps + 1):
            if t.stop.is_set():
                raise TaskStopped()
            # User ने mouse हिलाया? (पिछले action के बाद से)
            if agent_mouse is not None:
                x, y = pyautogui.position()
                if math.hypot(x - agent_mouse[0], y - agent_mouse[1]) > USER_MOUSE_MOVE_PX:
                    raise UserInterrupted()

            shot = pyautogui.screenshot().resize((self.scaled_w, self.scaled_h), Image.LANCZOS)
            buf = io.BytesIO()
            shot.save(buf, format="PNG")
            obs["screenshot"] = buf.getvalue()

            with _LibraryStdoutToStderr():
                info, code = self.agent.predict(instruction=t.text, observation=obs)
            action = (code[0] if code else "") or ""
            sections = _plan_sections(info.get("plan", ""))
            # Model ne asal plan hi nahi diya — gui-agents 3 koshish + format
            # retries ke baad khali plan ke saath ek no-op placeholder
            # (`import time; time.sleep(...)`) lout karta hai. Bina plan ke
            # steps chalana "max_steps / error: null" se khatam hota hai —
            # yani jhooti "ho gaya" report. Seedha saaf error do (UI is par
            # "credits" card kholti hai).
            if not (info.get("plan") or "").strip() or (
                not action.strip() and not sections.get("next action", "").strip()
            ):
                err = RuntimeError(
                    "the computer model returned no plan. This almost always means the "
                    "configured model cannot be paid for (402 / insufficient credits, or "
                    "the key limit is too low). Check the model provider balance and the "
                    "key limit, then retry."
                )
                # 402 jaisa hi ilzaam: app ka card isi se "Add credits" kholta hai
                # (_explain_byok_error status_code dekhta hai).
                err.status_code = 402  # type: ignore[attr-defined]
                raise err
            t.steps = step
            emit.send(
                "step",
                id=t.id,
                step=step,
                max_steps=t.max_steps,
                thought=_clip(sections.get("next action", ""), 200),
                action=_clip(info.get("plan_code", "") or action, 160),
            )

            marker = action.strip().upper()
            if marker == "DONE":
                return "done"
            if marker == "FAIL":
                return "failed"

            # Cloud call के दौरान stop आया हो तो यहाँ पकड़ा जाता है —
            # action चलने से पहले। एक click भी stop के बाद नहीं लगता।
            if t.stop.is_set():
                raise TaskStopped()

            # वही exec जो lab का cli_app करता है — फ़र्क़ सिर्फ़ एक: वहाँ यह
            # module के दर्जे पर चलता है, यहाँ एक method के अंदर। Method
            # के अंदर बिना namespace दिए exec के पास दो अलग dictionaries
            # होती हैं (globals और frame के locals), और उस सूरत में
            # multi-line code — जैसे `type` action का try/except वाला
            # pyperclip block — अपने ही बाँधे हुए नाम कभी-कभी नहीं देख
            # पाता। एक ही dict दे देने से यह ठीक वही माहौल बन जाता है जो
            # module के दर्जे पर होता है।
            exec(_SLEEP_RE.sub("_knockdesk_sleep(", action), self._exec_ns)  # noqa: S102 — सिर्फ़ ACI का बनाया हुआ code
            if t.stop.wait(POST_ACTION_WAIT_S):
                raise TaskStopped()
            agent_mouse = tuple(pyautogui.position())

        return "max_steps"

    @staticmethod
    def _summary(status: str, steps: int, sections: Dict[str, str], error: Optional[str]) -> str:
        head = {
            "done": f"Task completed in {steps} steps.",
            "failed": f"Agent gave up after {steps} steps — it judged the task impossible from the screen.",
            "stopped": f"Task stopped by request after {steps} steps.",
            "interrupted": f"Task paused after {steps} steps because the user took the mouse.",
            "max_steps": f"Step limit reached after {steps} steps; the task may be incomplete.",
            "error": f"Task aborted after {steps} steps: {(error or 'unknown error').rstrip('.')}.",
        }.get(status, status)
        verification = _clip(sections.get("previous action verification", ""), 300)
        screen = _clip(sections.get("screenshot analysis", ""), 400)
        parts = [head]
        if verification:
            parts.append(f"Last check: {verification}")
        if screen:
            parts.append(f"Final screen: {screen}")
        return " ".join(parts)


# ── Main loop ────────────────────────────────────────────────────────────────
class Runner:
    """Resident sidecar: boot पर load, task पर task, stop पर सिर्फ़ task रुकता है।"""

    def __init__(self) -> None:
        self._agent: Optional[ComputerAgent] = None
        self._lock = threading.Lock()
        # Agent बनाने का अपना अलग ताला। `_lock` इस काम के लिए ठीक नहीं:
        # वह `_current` के लिए है और main thread (stdin) उसे छूता है —
        # उस पर 150 second का import बैठाने से पूरा protocol जाम जाता।
        self._agent_lock = threading.Lock()
        self._loaded = threading.Event()
        self._current: Optional[Task] = None
        # Stop के बाद भी जिस का thread ज़िंदा हो (cloud call/action के बीच
        # था)। अगला task पहले इस के ख़त्म होने का इंतज़ार करता है —
        # mouse एक है, दो thread उसे नहीं चला सकते।
        self._abandoned: Optional[Task] = None
        self._screen = pyautogui.size()

    # ── agent का load (boot पर, background में) ────────────────────────────

    def _get_agent(self) -> ComputerAgent:
        # ताला इस लिए कि boot का load और (किसी वजह से पहले आ गया) task
        # एक साथ दो agent न बनाएँ। दूसरा बस इंतज़ार करता है — और उसी
        # दौरान उसकी धड़कन Electron को चलती रहती है।
        with self._agent_lock:
            if self._agent is None:
                self._agent = ComputerAgent()
            return self._agent

    def _load_agent(self) -> None:
        """Boot पर: agent load करो, धड़कन भेजो, फिर `ready`।

        MAIN THREAD पर चलता है, stdin पढ़ने से पहले — यह तरतीब ही असल
        fix है (देखो _stdin_lines)। ख़ाली machine पर 4-8 s। Load fail हो तो
        process exit 2: Electron का supervisor backoff के साथ दोबारा उठाता है।
        """
        t0 = time.time()

        def heartbeat() -> None:
            while not self._loaded.wait(3.0):
                emit.send("loading", elapsed=round(time.time() - t0, 1), stage="loading agent")

        threading.Thread(target=heartbeat, name="load-hb", daemon=True).start()
        try:
            with _LibraryStdoutToStderr():
                self._get_agent()
                # जो modules agent के actions बाद में lazily import करते हैं,
                # अभी ले आओ — task के दौरान कोई नया DLL load न हो।
                try:
                    import pyperclip  # noqa: F401  (`type` action clipboard से लिखता है)
                except Exception:  # noqa: BLE001
                    pass
        except Exception as err:  # noqa: BLE001
            self._loaded.set()
            log.error("Agent load fail: %s\n%s", err, traceback.format_exc())
            emit.send("load_error", message=_friendly_error(err) or f"{type(err).__name__}: {err}")
            os._exit(2)
        self._loaded.set()
        secs = round(time.time() - t0, 1)
        log.info("Agent %s s में तैयार", secs)
        w, h = self._screen
        emit.send("ready", screen={"width": w, "height": h}, pid=os.getpid(),
                  planner=PLANNER_MODEL, grounding=GROUNDING_MODEL, seconds=secs)

    # ── commands ─────────────────────────────────────────────────────────────

    def handle(self, msg: Dict[str, Any]) -> None:
        cmd = msg.get("cmd")
        if cmd == "ping":
            emit.send("pong", busy=self._current is not None, loaded=self._loaded.is_set())
        elif cmd == "warm":
            # पुराना command — अब load boot पर ख़ुद होता है। सिर्फ़ हालत बताओ।
            emit.send("warm", state="ready" if self._agent is not None else "loading")
        elif cmd == "run":
            self._start(msg)
        elif cmd == "stop":
            self._stop_current(msg.get("id"))
        elif cmd == "shutdown":
            self._shutdown()
        else:
            emit.send("error", message=f"unknown cmd: {cmd}")

    def _emit_done(self, t: Task, result: Dict[str, Any]) -> None:
        if t.mark_done():
            emit.send("task_done", **result)

    # ── stop: task रुकता है, process नहीं ───────────────────────────────────

    def _stop_current(self, task_id: Optional[str]) -> None:
        with self._lock:
            t = self._current
            if t is None or (task_id and task_id != t.id):
                emit.send("error", message="no such task running", id=task_id)
                return
        t.stop.set()
        emit.send("stopping", id=t.id)
        # 1. चलती हुई cloud call काटो — worker thread उसी लमहे TaskStopped
        #    पर निकलता है (cloud का जवाब आने का इंतज़ार नहीं)।
        closed = _abort_llm_calls()
        # 2. Cursor अभी वापस — worker का अपना cleanup भी करेगा (idempotent)।
        try:
            restore_system_cursors()
        except Exception:  # noqa: BLE001
            pass
        log.info("Stop: task %s, %d cloud client बंद", t.id, closed)
        # 3. Worker को थोड़ा वक़्त दो; न रुके तो task यहीं ख़त्म, thread पीछे।
        threading.Thread(target=self._await_stop, args=(t,), name=f"stop-{t.id}", daemon=True).start()

    def _await_stop(self, t: Task) -> None:
        th = t.thread
        if th is not None:
            th.join(STOP_JOIN_S)
        if th is None or not th.is_alive():
            return  # worker ने ख़ुद task_done भेज दिया
        # Thread अभी भी किसी call या action में अटका है। User को इंतज़ार
        # नहीं करवाना: task अब "stopped" है, thread को पीछे छोड़ दो। वह
        # जब भी निकले, `_loop` का stop-check उसे कोई action चलाने नहीं
        # देगा, और उसका task_done (mark_done) यहाँ के बाद नहीं जाएगा।
        with self._lock:
            t.abandoned = True
            if self._current is t:
                self._current = None
            self._abandoned = t
        log.warning("Stop: task %s का thread %ss में नहीं रुका — पीछे छोड़ दिया", t.id, STOP_JOIN_S)
        self._emit_done(t, {
            "id": t.id, "status": "stopped", "steps": t.steps, "seconds": 0,
            "summary": f"Task stopped by request after {t.steps} steps.",
            "notes": [], "error": None,
        })

    # ── run ──────────────────────────────────────────────────────────────────

    def _start(self, msg: Dict[str, Any]) -> None:
        task_id = str(msg.get("id") or f"task-{int(time.time() * 1000)}")
        text = str(msg.get("task") or "").strip()
        if not text:
            emit.send("error", id=task_id, message="task is empty")
            return
        t = Task(
            task_id, text,
            max_steps=max(1, min(int(msg.get("max_steps") or 50), 200)),
            overlay=bool(msg.get("overlay", True)),
            fast=bool(msg.get("fast", False)),
        )
        with self._lock:
            if self._current is not None:
                emit.send("error", id=task_id, message="busy", busy_with=self._current.id)
                return
            self._current = t

        def work() -> None:
            # आम सूरत में agent boot पर load हो चुका है और यह thread
            # सीधा run पर जाता है। दो सूरत में इंतज़ार होता है — और
            # दोनों में हर 3 s धड़कन जाती है ताकि Electron (और HUD) को
            # पता रहे कि ज़िंदा हैं:
            #   - agent अभी load हो रहा हो (task boot से पहले आ गया)
            #   - पिछला task stop हुआ मगर उसका thread अभी mouse छोड़ रहा हो
            waiting = threading.Event()
            stage = ["loading agent"]

            def heartbeat() -> None:
                t0 = time.time()
                while not waiting.wait(3.0):
                    emit.send("task_starting", id=t.id, elapsed=round(time.time() - t0, 1), stage=stage[0])

            threading.Thread(target=heartbeat, name=f"hb-{t.id}", daemon=True).start()
            try:
                prev = self._abandoned
                if prev is not None and prev.thread is not None and prev.thread.is_alive():
                    stage[0] = "waiting for previous task to release the mouse"
                    prev.thread.join(ABANDON_WAIT_S)
                    if prev.thread.is_alive():
                        raise RuntimeError("previous task is still releasing the mouse; try again in a moment")
                self._abandoned = None
                agent = self._get_agent()
                waiting.set()
                _revive_llm_clients()
                result = agent.run(t)
            except Exception as err:  # noqa: BLE001
                log.error("Agent init/run fail: %s\n%s", err, traceback.format_exc())
                result = {
                    "id": t.id, "status": "error", "steps": 0, "seconds": 0,
                    "summary": f"Computer agent could not start: {err}",
                    "notes": [], "error": str(err),
                }
            finally:
                waiting.set()
                with self._lock:
                    if self._current is t:
                        self._current = None
            self._emit_done(t, result)

        t.thread = threading.Thread(target=work, name=f"task-{t.id}", daemon=True)
        t.thread.start()

    # ── shutdown ─────────────────────────────────────────────────────────────

    def _shutdown(self) -> None:
        with self._lock:
            t = self._current
        if t is not None:
            t.stop.set()
        _abort_llm_calls()
        try:
            restore_system_cursors()
        except Exception:  # noqa: BLE001
            pass
        emit.send("bye")
        os._exit(0)

    # ── stdin: कभी ReadFile में park न हो ────────────────────────────────
    #
    # 13 Sept को py-spy से पकड़ी हुई असल जड़। Windows पर अगर कोई thread stdin
    # pipe पर `ReadFile` में पड़ा हो और उसी वक़्त कोई दूसरा thread numpy की
    # OpenBLAS DLL load करे (import numpy → _multiarray_umath), तो वह load एक
    # CRT lock पर हमेशा के लिए अटक जाता है। Process का exit भी रुक जाता
    # है। यह तब ही खुलता था जब stdin पर कोई line आती (lock एक लमहे को
    # छूटता) — इसी लिए app में agent 26-500 s में load होता था और "stop
    # कर के दोबारा लगाओ" से कभी-कभी चल पड़ता था: हर command एक धक्का।
    #
    # दो तहें:
    #   1. Agent का load MAIN thread पर, stdin पढ़ने से पहले (serve देखो)।
    #   2. stdin को PeekNamedPipe से देख कर पढ़ो — data हो तो ही os.read.
    #      कोई thread कभी ReadFile में park नहीं होता, तो task के दौरान
    #      lazy import होने वाला कोई भी DLL भी महफ़ूज़ है।
    # तजुर्बा: probe में ReadFile-park + thread load = hang (5/5), polling =
    # 5.8 s में load। Console (pipe नहीं) पर पुराना रास्ता ही चलता है।

    @staticmethod
    def _stdin_lines(poll_s: float = 0.05):
        if platform.system() != "Windows":
            yield from sys.stdin
            return
        try:
            import msvcrt
            from ctypes import wintypes

            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            handle = wintypes.HANDLE(msvcrt.get_osfhandle(0))
            if k32.GetFileType(handle) != 3:  # FILE_TYPE_PIPE — console/file पर पुराना रास्ता
                yield from sys.stdin
                return
        except Exception:  # noqa: BLE001
            yield from sys.stdin
            return

        avail = wintypes.DWORD(0)
        pending = b""
        while True:
            if not k32.PeekNamedPipe(handle, None, 0, None, ctypes.byref(avail), None):
                break  # pipe टूट गई = Electron चला गया
            if avail.value == 0:
                time.sleep(poll_s)
                continue
            try:
                chunk = os.read(0, min(avail.value, 65536))
            except OSError:
                break
            if not chunk:
                break
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                yield line.decode("utf-8", "replace")
        if pending.strip():
            yield pending.decode("utf-8", "replace")

    def serve(self) -> None:
        w, h = self._screen
        emit.send("booting", screen={"width": w, "height": h}, pid=os.getpid(),
                  planner=PLANNER_MODEL, grounding=GROUNDING_MODEL)
        # पहले load, फिर stdin — इस तरतीब की वजह ऊपर (_stdin_lines)।
        # Load के दौरान आए commands pipe में इंतज़ार करते हैं; Electron
        # वैसे भी `ready` से पहले `run` नहीं भेजता।
        self._load_agent()
        for raw in self._stdin_lines():
            raw = raw.strip()
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                emit.send("error", message="invalid json")
                continue
            try:
                self.handle(msg)
            except Exception as err:  # noqa: BLE001
                log.error("handle fail: %s\n%s", err, traceback.format_exc())
                emit.send("error", message=str(err))
        # stdin बंद = Electron चला गया। कुछ भी पीछे न रहे।
        self._shutdown()


if __name__ == "__main__":
    Runner().serve()
