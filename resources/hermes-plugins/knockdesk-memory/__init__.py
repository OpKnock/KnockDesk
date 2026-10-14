"""KnockDesk Memory: a Hermes MemoryProvider backed by the KnockDesk desktop app's Memory Core."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from typing import Any, Deque, Dict, List, Optional, Tuple

from agent.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)

# ⚠ ऊपर की तरतीब मत बदलो। Hermes इस folder को memory provider तभी
# मानता है जब `__init__.py` के पहले 8192 अक्षरों में `MemoryProvider` या
# `register_memory_provider` लिखा मिले (plugins/memory/__init__.py:
# `_is_memory_provider_dir`)। वह जाँच file को Windows की locale encoding से
# पढ़ती है, जहाँ हर `═` तीन अक्षर गिनता है। इस लिए import सब से ऊपर
# है और लंबी व्याख्या उस के बाद: banner के पीछे छुप जाता तो folder
# चुपचाप नज़रअंदाज़ हो जाता और Hermes बिना याददाश्त के चलता रहता।
#
# ════════════════════════════════════════════════════════════════════════════
#  यह फ़ाइल क्यों बनी
# ════════════════════════════════════════════════════════════════════════════
#
# KnockDesk के दो दिमाग़ हैं: voice assistant (desktop app के अंदर) और Hermes
# (यह अलग Python process)। पहले दोनों Hermes की दो छोटी files (MEMORY.md,
# USER.md) बाँटते थे। अब KnockDesk की अपनी याददाश्त है, Memory Core: एक SQLite
# file जो desktop app के `userData` folder में रहती है (app update उसे
# नहीं छेड़ता)।
#
# यह provider Hermes को उसी याददाश्त से जोड़ता है:
#
#     Hermes ──HTTP──▶ 127.0.0.1 bridge (desktop app) ──▶ Memory Core
#
# Database को यहाँ से सीधा नहीं खोला जाता। लिखने वाला एक ही रहता है
# (desktop app), इस लिए दो processes के एक साथ लिखने की ख़राबी मुमकिन ही
# नहीं, और database का ढाँचा बदले तो यह file नहीं बदलनी पड़ती।
#
# Hermes की अपनी built-in memory (MEMORY.md / USER.md) साथ चलती रहती है।
# यह provider उस के ऊपर एक इज़ाफ़ा है, उस का बदल नहीं।
#
# ════════════════════════════════════════════════════════════════════════════
#  चार उसूल जिन पर यह पूरी फ़ाइल खड़ी है
# ════════════════════════════════════════════════════════════════════════════
#
#  1. HOOK कभी EXCEPTION नहीं फेंकता। हर hook का पूरा जिस्म try/except
#     में है। `get_tool_schemas` की exception Hermes में provider को उस
#     agent के लिए हमेशा के लिए बंद कर देती है (agent_init.py), इस लिए
#     यहाँ "शायद" की कोई गुंजाइश नहीं।
#
#  2. TURN सिर्फ़ दो जगह रुकता है, और दोनों की हद है। `system_prompt_block`
#     (1.5 s) और `prefetch` (1.2 s) agent के अपने thread पर चलते हैं, और
#     Hermes उन पर कोई timeout नहीं लगाता। बाक़ी सब लिखाई (turns, session
#     का ख़त्म होना, built-in memory की नक़ल) एक क़तार में जाती है जिसे एक
#     background thread ख़ाली करती है।
#
#  3. याददाश्त बंद हो तो ख़ामोशी। Desktop app बंद हो, bridge जवाब न दे, या
#     याददाश्त बंद/रुकी हुई हो: हर hook कुछ नहीं करता और Hermes पहले जैसा
#     चलता है। Tools उस सूरत में साफ़ बताते हैं कि कुछ पढ़ा या लिखा
#     नहीं गया, ताकि model "नहीं मिला" और "पूछ ही न सका" को एक न समझे।
#
#  4. बातचीत का TEXT LOG में कभी नहीं। यहाँ के log सिर्फ़ गिनती, हालत
#     और लंबाई लिखते हैं। Hermes के logs सादी file में जाते हैं।
#
# ════════════════════════════════════════════════════════════════════════════
#  ख़ुदकार TRAFFIC यहाँ से नहीं गुज़रता
# ════════════════════════════════════════════════════════════════════════════
#
# Voice की हर बातचीत ख़त्म होने पर Hermes को एक "Automated record"
# prompt के तौर पर भेजी जाती है (src/lib/voice-session-archive.ts, source
# `knockdesk-voice`)। वह बातचीत desktop पहले ही Memory Core में लिख चुका
# होता है। यहाँ से दोबारा लिखने का मतलब होता कि हर voice बात दो दफ़ा
# याद हो। यही बात "Memory note" / "Memory request" वाले one-shots की है।
# इस लिए ऐसे turn पर यह provider बिल्कुल चुप रहता है: न turn लिखता है,
# न तलाश करता है, न built-in memory की नक़ल भेजता है।
#
# NOTE: नीचे `knockdesk-voice`, `[Memory note via KnockDesk` जैसे literal रखे गए
# हैं — वह desktop app के भेजे पाठ से मिलाए जाते हैं, इसलिए protocol हैं।

PROVIDER_NAME = "knockdesk-memory"

# ── वक़्त की हदें ─────────────────────────────────────────────────────────
#
# पहली दो agent के thread पर लगती हैं, यानी सीधा user के इंतज़ार में
# जुड़ती हैं। Local SQLite का जवाब milliseconds का होता है; यह हदें सिर्फ़
# उस दिन के लिए हैं जब desktop app अटकी हुई हो।
CONTEXT_TIMEOUT_S = 1.5
RECALL_TIMEOUT_S = 1.2
# Tool भी turn के अंदर चलता है (tool thread पर, blocking), इस लिए उस की
# हद भी वही है जो सब से लंबी hook की है: कोई भी रास्ता turn को 1.5 s
# से ज़्यादा नहीं रोकता। हद गुज़र जाए तो tool साफ़ कहता है कि काम की
# तस्दीक़ नहीं हुई (store वही text दोबारा आने पर उसे दो दफ़ा नहीं लिखता)।
TOOL_TIMEOUT_S = 1.5
# Background thread की लिखाई। यह किसी turn को नहीं रोकती।
WRITE_TIMEOUT_S = 5.0

# Bridge एक दफ़ा जवाब न दे तो इतनी देर तक `prefetch` और
# `system_prompt_block` network को हाथ ही नहीं लगाते। इस के बग़ैर एक अटकी
# हुई desktop app हर turn को 1.2 s रोकती; इस के साथ सिर्फ़ पहले को।
DOWN_COOLDOWN_S = 15.0

# ── क़तार ───────────────────────────────────────────────────────────────────
#
# छोटी जानबूझ कर है। एक turn = एक चीज़; 64 का मतलब है कि desktop
# app एक घंटे बंद रहे तो भी आम बातचीत समा जाए। उस से आगे सब से
# पुरानी चीज़ गिरती है (और गिनी जाती है): ताज़ा बात पुरानी से ज़्यादा
# क़ीमती है, और बेहद क़तार memory का रास्ता है।
MAX_QUEUE = 64
# Bridge "अंदर की ख़राबी" (5xx) दे तो इतनी कोशिशों के बाद चीज़ छोड़ दी
# जाती है, वरना एक ख़राब चीज़ पूरी क़तार को हमेशा के लिए रोक लेती।
# Bridge तक पहुँचा ही न जा सके तो कोशिश जारी रहती है (क़तार की हद
# उस को ख़ुद सँभाल लेती है)।
MAX_ATTEMPTS = 4
RETRY_BASE_S = 2.0
RETRY_MAX_S = 30.0
# क़तार इतनी देर ख़ाली रहे तो thread बंद हो जाती है; अगली चीज़ उसे
# दोबारा बना लेती है।
IDLE_EXIT_S = 30.0
# Session/process के बंद होने पर क़तार को इतना वक़्त मिलता है। Bridge बंद
# हो तो इंतज़ार होता ही नहीं।
SHUTDOWN_FLUSH_S = 1.5

# ── लंबाई की हदें ───────────────────────────────────────────────────────
#
# एक turn का text: bridge ख़ुद 20,000 पर काटता है और store 8,000 पर
# (कटने का निशान लगा कर)। यहाँ वही हद इस लिए है कि एक paste की हुई
# बड़ी file पूरी request को bridge की body की हद (512 KB) से बाहर न ले
# जाए; उस सूरत में पूरा turn रद्द हो जाता।
MAX_TURN_CHARS = 20_000
MAX_QUERY_CHARS = 2_000
# एक याद की लंबाई: electron/services/memory/config.js -> LIMITS.memoryMaxChars.
# यह लिखने के अंदाज़ की हद नहीं, सिर्फ़ हिफ़ाज़ती fuse है। Store उस से लंबा
# text रद्द कर देता है (काटता नहीं); `memory_remember` उस से पहले ही model
# को साफ़ बता देता है कि दो यादों में लिखे।
# (scripts/test-memory-plugin.py यह number config.js से मिला कर देखता है।)
MAX_MEMORY_CHARS = 2000
MAX_RESPONSE_BYTES = 1024 * 1024

# electron/services/memory/config.js -> AUTOMATED_PREFIXES की हूबहू नक़ल।
# वहाँ बदले तो यहाँ भी बदलो (scripts/test-memory-plugin.py दोनों को मिला
# कर देखता है)। इन का पाठ ख़ुद कभी न बदलो: voice archive और Lens दोनों
# `[Automated record` पर खड़े हैं।
AUTOMATED_PREFIXES = (
    "[Automated record",
    "[Memory note via KnockDesk",
    "[Memory request via KnockDesk",
    "[MEMORY NOTE]",
    "[SYSTEM_MEMORY_INJECTION]",
)

# src/lib/voice-session-archive.ts -> SESSION_SOURCE.
VOICE_ARCHIVE_SOURCE = "knockdesk-voice"
# पुराने sessions पर अब भी पुराना tag हो सकता है — दोनों पहचानो।
VOICE_ARCHIVE_SOURCES = ("knockdesk-voice", "knockdesk-voice")

# इन tools का नतीजा user की अपनी बात या अपनी याददाश्त है, बाहर का मवाद
# नहीं। बाक़ी हर tool (web, file, terminal, browser…) बाहर से text लाता है।
_INTERNAL_TOOLS = frozenset({
    "memory", "memory_search", "memory_remember", "memory_forget", "todo", "clarify",
})


# ── Tool schemas ────────────────────────────────────────────────────────────
#
# नाम Hermes के core tools (`memory`, `session_search`, `todo`…) से नहीं
# टकराते; टकराने वाला tool Hermes चुपचाप गिरा देता है। State card के
# क़ायदे (electron/services/memory/context.js -> RULES.hermes) इन्हीं नामों का
# ज़िक्र करते हैं, इस लिए नाम बदलना दो जगह का काम है।

MEMORY_SEARCH_SCHEMA = {
    "name": "memory_search",
    "description": (
        "Search KnockDesk's long-term memory of the user: facts they told you, things you noted, "
        "and past voice and chat conversations. This memory is shared with the KnockDesk voice "
        "assistant. Use it before you say you do not know something about the user, their "
        "people, projects, preferences or an earlier conversation. The result says FOUND, "
        "WEAK MATCH or NOTHING FOUND. If nothing is found, say you do not remember and ask; "
        "never invent a memory."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "What to look for, in the user's own words and language.",
            },
            "query_en": {
                "type": "string",
                "description": (
                    "The same query in plain English. Add it when the user's words are in "
                    "another language or script; it helps matching."
                ),
            },
        },
        "required": ["query"],
    },
}

MEMORY_REMEMBER_SCHEMA = {
    "name": "memory_remember",
    "description": (
        "Save one lasting fact to KnockDesk's long-term memory, shared with the KnockDesk voice "
        "assistant. Use it when the user states something durable about themselves, their "
        "people, their work or their preferences, or asks you to remember something. One "
        "self-contained topic per call, as long as it needs and written efficiently (at most "
        f"{MAX_MEMORY_CHARS} characters), in the "
        "user's own language. Never store passwords, one-time codes, card numbers or API keys. "
        "The result says whether it was saved; if it was not, tell the user."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "text": {
                "type": "string",
                "description": "The fact to remember, written so it makes sense on its own.",
            },
            "about": {
                "type": "string",
                "description": (
                    "Name of the person the fact is about, when it is about someone other "
                    "than the user."
                ),
            },
            "important": {
                "type": "boolean",
                "description": (
                    "True only when the user explicitly says this must always be kept in mind. "
                    "It uses one of a small number of always-remember slots."
                ),
            },
        },
        "required": ["text"],
    },
}

MEMORY_FORGET_SCHEMA = {
    "name": "memory_forget",
    "description": (
        "Remove one thing from KnockDesk's long-term memory when the user asks you to forget it. "
        "Describe the memory. Only a single clear match is removed; if the match is not clear "
        "nothing is removed and you should ask the user which memory they mean."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "What to forget, in the user's own words.",
            },
        },
        "required": ["query"],
    },
}

_UNREACHABLE = (
    "KnockDesk memory could not be reached right now (the KnockDesk desktop app may be closed "
    "or restarting)."
)
_SEARCH_NOT_RUN = (
    " Nothing was searched, so this is NOT a 'nothing found' result. Tell the user their "
    "memory is unavailable right now; do not guess and do not invent a memory."
)
_NOTHING_FOUND = (
    "MEMORY SEARCH: NOTHING FOUND. You do not have this in memory. Say that you do not "
    "remember and ask them; do not guess and do not invent."
)
_AUTOMATED_TURN = (
    "This turn is an automated KnockDesk record. The KnockDesk desktop app handles KnockDesk memory "
    "for it, so nothing was changed here. If something still has to be kept or removed, use "
    "the built-in memory tool."
)


# ── छोटे मददगार ─────────────────────────────────────────────────────────


def _bridge() -> Optional[Tuple[str, str]]:
    """Bridge का पता और चाबी, दोनों मौजूद हों तभी।

    हर call पर env से पढ़ा जाता है (hermes-plugins/knockdesk/activity.py का
    तरीक़ा)। Desktop app यह दोनों `PUT /api/env` से लिखती है: dashboard
    process का `os.environ` फ़ौरन बदल जाता है, और gateway अपने start पर
    पढ़ता है। याद रख लेने से port बदलने के बाद पुरानी जगह खटखटाते।
    """
    url = (os.getenv("STONIC_BRIDGE_URL", "") or "").strip().rstrip("/")
    key = (os.getenv("STONIC_BRIDGE_KEY", "") or "").strip()
    if not url or not key:
        return None
    return url, key


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    try:
        return str(value).strip()
    except Exception:  # noqa: BLE001
        return ""


def _is_automated(text: Any) -> bool:
    return isinstance(text, str) and text.lstrip().startswith(AUTOMATED_PREFIXES)


def _session_source() -> str:
    """इस turn की session का `source` (जैसे `stonic`, `knockdesk-voice`, `tui`)।

    Hermes इसे `initialize` में नहीं देता। वह एक ContextVar में होता है जो
    सिर्फ़ TURN के thread पर set होता है (tui_gateway/server.py), इस लिए यह
    सिर्फ़ `on_turn_start` / `prefetch` / `system_prompt_block` से बुलाया जाता
    है। `sync_turn` एक अलग worker thread पर चलता है जहाँ यह ख़ाली
    मिलता, तो वहाँ याद रखी हुई value इस्तेमाल होती है।
    """
    try:
        from gateway.session_context import get_session_env

        return _text(get_session_env("HERMES_SESSION_SOURCE", ""))
    except Exception:  # noqa: BLE001 - Hermes के बग़ैर (test) या पुराना Hermes
        return _text(os.environ.get("HERMES_SESSION_SOURCE", ""))


def _reply(payload: Dict[str, Any]) -> str:
    """Tool का जवाब। Hermes provider के tool से JSON string माँगता है।"""
    return json.dumps(payload, ensure_ascii=False)


def _tool_error(message: str) -> str:
    """वही शक्ल जो Hermes का अपना `tool_error` बनाता है: {"error": "..."}।"""
    return _reply({"error": message})


def _read_outside_content(messages: Any) -> bool:
    """क्या इस बातचीत में बाहर का मवाद पढ़ा गया (web, file, email…)?

    Memory Core ऐसी session को `external` गिनता है और उस से सिर्फ़ वही बात
    याद बनाता है जो user ने ख़ुद कही। वजह: किसी web page की एक line
    ("यह याद रखो कि…") assistant के जवाब के रास्ते याददाश्त में न उतर
    जाए। शक हो (tool चला मगर नाम न मिला) तो जवाब "हाँ" है: वह
    महफ़ूज़ तरफ़ है।
    """
    if not isinstance(messages, list):
        return False
    saw_result = False
    saw_name = False
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        if role == "assistant":
            calls = msg.get("tool_calls")
            for call in calls if isinstance(calls, list) else []:
                if not isinstance(call, dict):
                    continue
                fn = call.get("function")
                name = fn.get("name") if isinstance(fn, dict) else call.get("name")
                if name:
                    saw_name = True
                    if name not in _INTERNAL_TOOLS:
                        return True
        elif role == "tool":
            saw_result = True
            name = msg.get("name") or msg.get("tool_name")
            if name:
                saw_name = True
                if name not in _INTERNAL_TOOLS:
                    return True
    return saw_result and not saw_name


def _turn_ref(session_id: str, ts_ms: int, user: str, reply: str) -> str:
    """एक turn की मुस्तक़िल पहचान।

    क़तार में डालते वक़्त एक दफ़ा बनती है और चीज़ के साथ रहती है, इस
    लिए दोबारा कोशिश (timeout के बाद जब पहली request असल में पहुँच
    चुकी हो) वही ref ले कर जाती है और store उसे दोबारा नहीं लिखता।

    वक़्त इस में जानबूझ कर शामिल है: सिर्फ़ text का hash होता तो एक ही
    session में दो दफ़ा कहा गया "ok" / "Done." दूसरी दफ़ा असली turn हो कर
    भी "पहले से है" समझ कर गिर जाता।
    """
    digest = hashlib.sha1()
    for part in (session_id, str(ts_ms), user, reply):
        digest.update(part.encode("utf-8", "replace"))
        digest.update(b"\x00")
    return digest.hexdigest()[:24]


# ── Bridge से बात ──────────────────────────────────────────────────────────
#
# Proxy के बग़ैर opener: `urllib` system का proxy उठा लेता है (Windows पर
# registry से भी), और 127.0.0.1 हर machine की bypass list में नहीं होता।
# Proxy के रास्ते जाने वाली localhost request या तो नाकाम होती या, उस से बुरा,
# चाबी को machine से बाहर ले जाती।
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# Bridge ने आख़िरी दफ़ा जवाब नहीं दिया तो इस वक़्त तक blocking hooks चुप।
_down_until = 0.0


def _bridge_looks_down() -> bool:
    return time.monotonic() < _down_until


def _request(path: str, body: Optional[Dict[str, Any]], timeout: float,
             method: str = "POST") -> Tuple[str, Optional[Dict[str, Any]]]:
    """Bridge को एक request। कभी throw नहीं करता।

    वापस `(हालत, data)`:
        ok        bridge ने JSON दिया (`data` dict है; उस का अपना `ok` अलग देखो)
        unset     env में bridge का पता/चाबी नहीं
        down      पहुँच ही न सके (app बंद, timeout)
        denied    चाबी रद्द (401/403): app ने नई चाबी बनाई, gateway अभी पुरानी पर है
        missing   रास्ता ही नहीं (404): पुरानी desktop app, या याददाश्त wire नहीं हुई
        rejected  request रद्द (400/413…): दोबारा भेजने का कोई फ़ायदा नहीं
        error     bridge के अंदर ख़राबी (5xx) या समझ न आने वाला जवाब
    """
    global _down_until

    target = _bridge()
    if target is None:
        return "unset", None
    url, key = target
    try:
        # `replace`: टूटा हुआ unicode (आधा emoji) पूरे turn को रद्द न करवाए।
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8", "replace")
        request = urllib.request.Request(
            f"{url}{path}",
            data=data,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
            },
            method=method,
        )
    except Exception:  # noqa: BLE001 - body JSON न बन सका, या URL ख़राब
        return "rejected", None

    try:
        with _OPENER.open(request, timeout=timeout) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as err:
        _down_until = 0.0  # जवाब आया है, यानी bridge ज़िंदा है
        code = int(getattr(err, "code", 0) or 0)
        try:
            err.close()
        except Exception:  # noqa: BLE001
            pass
        if code == 404:
            return "missing", None
        if code in (401, 403):
            return "denied", None
        if 400 <= code < 500:
            return "rejected", None
        return "error", None
    except Exception:  # noqa: BLE001 - connection refused, timeout, reset…
        _down_until = time.monotonic() + DOWN_COOLDOWN_S
        return "down", None

    _down_until = 0.0
    if len(raw) > MAX_RESPONSE_BYTES:
        return "error", None
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except Exception:  # noqa: BLE001
        return "error", None
    if not isinstance(parsed, dict):
        return "error", None
    return "ok", parsed


# ── लिखने वाली क़तार ───────────────────────────────────────────────────────


_DONE = "done"
_WAIT = "wait"
_DROP = "drop"


class _Job:
    __slots__ = ("path", "body", "kind", "errors")

    def __init__(self, path: str, body: Dict[str, Any], kind: str) -> None:
        self.path = path
        self.body = body
        self.kind = kind
        # Bridge ने इस चीज़ पर कितनी दफ़ा "अंदर की ख़राबी" (5xx) दी। Bridge
        # तक न पहुँच पाना इस में नहीं गिनता: वह चीज़ का क़सूर नहीं।
        self.errors = 0


class _Writer:
    """एक हदबंद क़तार और उसे ख़ाली करने वाली एक daemon thread।

    पूरे process में एक ही है (हर agent का अपना provider होता है, मगर
    सब इसी क़तार में डालते हैं), इस लिए चीज़ें उसी तरतीब में पहुँचती
    हैं जिस में आई थीं: पहले turn, फिर उस session का ख़त्म होना।

    Thread पहली चीज़ पर बनती है, `__init__` में नहीं। Hermes हर
    `GET /api/memory` पर provider बना कर `is_available()` पूछता है; वहाँ
    thread बनाना हर दफ़ा एक बेकार thread छोड़ देता।
    """

    def __init__(self) -> None:
        self._cond = threading.Condition()
        self._items: Deque[_Job] = deque()
        self._thread: Optional[threading.Thread] = None
        self._inflight = False
        self._failures = 0
        self._retry_at = 0.0
        # गिनती: test और debug के लिए। Text कभी नहीं।
        self.sent = 0
        self.dropped = 0
        self.refused = 0

    def enqueue(self, job: _Job) -> None:
        """क़तार में डालो और फ़ौरन वापस। यहाँ से कुछ नहीं रुकता।"""
        with self._cond:
            if len(self._items) >= MAX_QUEUE:
                self._items.popleft()
                self._count_drop("क़तार भरी थी, सब से पुरानी चीज़ गिरी")
            self._items.append(job)
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(
                    target=self._drain, name="knockdesk-memory", daemon=True,
                )
                self._thread.start()
            self._cond.notify_all()

    def pending(self) -> int:
        with self._cond:
            return len(self._items) + (1 if self._inflight else 0)

    def flush(self, timeout: float) -> bool:
        """क़तार ख़ाली होने का इंतज़ार, ज़्यादा से ज़्यादा `timeout` second।

        Bridge बंद हो (thread दोबारा कोशिश के वक़्फ़े में हो) तो फ़ौरन वापस:
        उस सूरत में इंतज़ार सिर्फ़ बंद होते process को रोकता।
        """
        deadline = time.monotonic() + max(0.0, timeout)
        with self._cond:
            while self._items or self._inflight:
                now = time.monotonic()
                if not self._inflight and self._retry_at > now:
                    return False
                left = deadline - now
                if left <= 0:
                    return False
                self._cond.wait(left)
            return True

    def _count_drop(self, why: str) -> None:
        # Lock के अंदर से बुलाया जाता है। पहली दफ़ा और फिर हर 20वीं पर
        # एक line: चुपचाप गिरना मना है, मगर हर चीज़ पर लिखना शोर है।
        self.dropped += 1
        if self.dropped == 1 or self.dropped % 20 == 0:
            logger.warning("knockdesk-memory: %s (अब तक %d गिरी)", why, self.dropped)

    def _drain(self) -> None:
        while True:
            try:
                with self._cond:
                    while not self._items:
                        self._cond.notify_all()  # flush() को: क़तार ख़ाली है
                        if not self._cond.wait(IDLE_EXIT_S) and not self._items:
                            self._thread = None
                            return
                    job = self._items.popleft()
                    self._inflight = True

                verdict = self._send(job)

                pause = 0.0
                with self._cond:
                    self._inflight = False
                    if verdict == _WAIT:
                        self._failures += 1
                        if len(self._items) >= MAX_QUEUE:
                            # इंतज़ार के दौरान क़तार भर गई: यह चीज़ अब
                            # सब से पुरानी है, यही गिरती है।
                            self._count_drop("क़तार भरी थी, सब से पुरानी चीज़ गिरी")
                        else:
                            self._items.appendleft(job)
                        pause = min(RETRY_MAX_S, RETRY_BASE_S * (2 ** min(self._failures - 1, 6)))
                        self._retry_at = time.monotonic() + pause
                    else:
                        self._failures = 0
                        self._retry_at = 0.0
                        if verdict == _DROP:
                            self._count_drop(f"{job.kind} bridge ने क़ुबूल नहीं की")
                    self._cond.notify_all()
                if pause:
                    time.sleep(pause)
            except Exception as err:  # noqa: BLE001 - thread कभी न मरे
                logger.debug("knockdesk-memory: क़तार की thread में ख़राबी (%s)", type(err).__name__)
                with self._cond:
                    self._inflight = False
                    self._cond.notify_all()
                time.sleep(1.0)

    def _send(self, job: _Job) -> str:
        state, data = _request(job.path, job.body, WRITE_TIMEOUT_S)
        if state == "ok" and data is not None:
            if data.get("ok") is True and data.get("paused") is not True:
                self.sent += 1
                return _DONE
            # याददाश्त बंद है, रुकी हुई है, या इस चीज़ को store ने नहीं
            # लिया। यह नाकामी नहीं, फ़ैसला है: दोबारा भेजने का फ़ायदा नहीं।
            self.refused += 1
            reason = _text(data.get("reason"))[:40]
            if job.kind == "remember" and reason:
                # `reason` एक छोटा code है (जैसे `session_limit`), text नहीं।
                logger.info("knockdesk-memory: built-in memory की नक़ल save नहीं हुई (%s)", reason)
            else:
                logger.debug("knockdesk-memory: %s नहीं लिखी गई (याददाश्त बंद या रुकी हुई)", job.kind)
            return _DONE
        if state in ("down", "denied"):
            return _WAIT
        if state == "error":
            job.errors += 1
            return _WAIT if job.errors < MAX_ATTEMPTS else _DROP
        return _DROP


_writer = _Writer()


# ── Provider ────────────────────────────────────────────────────────────────


class KnockDeskMemoryProvider(MemoryProvider):
    """Hermes का memory provider जो KnockDesk Memory Core से बात करता है।

    हर agent (यानी हर session) का अपना instance होता है: Hermes `register`
    को हर `load_memory_provider` पर बुलाता है। इस लिए `__init__` में न
    network है न thread।
    """

    def __init__(self) -> None:
        self._session_id = ""
        self._platform = ""
        self._title = ""
        self._source = ""
        self._turn_started_ms = 0
        self._turn_automated = False
        self._lock = threading.Lock()
        # वह sessions जिन में इस instance ने turn लिखे और अभी "ख़त्म"
        # नहीं भेजा।
        self._open_sessions: set = set()

    @property
    def name(self) -> str:
        return PROVIDER_NAME

    # ── ज़िंदगी ─────────────────────────────────────────────────────────────

    def is_available(self) -> bool:
        # Network नहीं: Hermes इसे agent बनाते वक़्त और dashboard की हर
        # `GET /api/memory` पर पूछता है। False का मतलब है कि उस agent के
        # लिए provider पूरा बंद (Hermes दोबारा नहीं पूछता), इस लिए सिर्फ़
        # वही चीज़ देखी जाती है जो desktop app ने लिख दी हो।
        try:
            return _bridge() is not None
        except Exception:  # noqa: BLE001
            return False

    def initialize(self, session_id: str, **kwargs) -> None:
        # kwargs को पूरा याद नहीं रखते: `cli` platform पर उस में
        # `warning_callback` जैसे bound methods होते हैं। सिर्फ़ तीन सादे label।
        try:
            self._session_id = _text(session_id)
            self._platform = _text(kwargs.get("platform"))[:40]
            self._title = _text(kwargs.get("session_title"))[:200]
        except Exception as err:  # noqa: BLE001
            logger.debug("knockdesk-memory: initialize अधूरा रहा (%s)", type(err).__name__)

    def shutdown(self) -> None:
        # क़तार में पड़ी आख़िरी चीज़ को पहुँचने का एक मौक़ा। हद के साथ:
        # एक अटका हुआ bridge किसी session या process को बंद होने से नहीं रोकता।
        try:
            _writer.flush(SHUTDOWN_FLUSH_S)
        except Exception as err:  # noqa: BLE001
            logger.debug("knockdesk-memory: shutdown पर क़तार ख़ाली नहीं हुई (%s)", type(err).__name__)

    # ── Turn की पहचान ─────────────────────────────────────────────────────

    def _note_turn(self, message: Any) -> None:
        source = _session_source()
        if source:
            self._source = source
        self._turn_automated = _is_automated(message)

    def _stay_quiet(self) -> bool:
        """यह turn (या पूरी session) ख़ुदकार है: desktop इसे पहले लिख चुका।"""
        return self._turn_automated or self._source in VOICE_ARCHIVE_SOURCES

    def on_turn_start(self, turn_number: int, message: str, **kwargs) -> None:
        # Turn के thread पर, `prefetch` से ठीक पहले। यहीं session का
        # source हाथ आता है और यहीं से user के जुमले का वक़्त मिलता है।
        try:
            self._turn_started_ms = int(time.time() * 1000)
            self._note_turn(message)
        except Exception as err:  # noqa: BLE001
            logger.debug("knockdesk-memory: on_turn_start नाकाम (%s)", type(err).__name__)

    def on_session_switch(self, new_session_id: str, *, parent_session_id: str = "",
                          reset: bool = False, rewound: bool = False, **kwargs) -> None:
        # Hermes चलते agent की session id बदल देता है (/new, /resume,
        # compression)। `prefetch`, `on_session_end` और tools को id नहीं
        # मिलती, इस लिए मौजूदा id यहाँ ताज़ा रखी जाती है। (`sync_turn`
        # को Hermes हर दफ़ा ख़ुद देता है।)
        try:
            fresh = _text(new_session_id)
            if fresh:
                self._session_id = fresh
        except Exception as err:  # noqa: BLE001
            logger.debug("knockdesk-memory: on_session_switch नाकाम (%s)", type(err).__name__)

    # ── पढ़ना ──────────────────────────────────────────────────────────────

    def system_prompt_block(self) -> str:
        """State card: pin की हुई बातें, profile, वादे, पिछली बात।

        Hermes इसे session के शुरू में एक दफ़ा लेता और cache कर लेता है
        (resume पर भी वही पुराना block आता है)। रोज़ बदलने वाली चीज़ें
        इस लिए `prefetch` से आती हैं, यहाँ से नहीं।
        """
        try:
            source = _session_source()
            if source:
                self._source = source
            if self._source in VOICE_ARCHIVE_SOURCES or _bridge_looks_down():
                return ""
            body: Dict[str, Any] = {}
            if self._session_id:
                body["session_id"] = self._session_id
            state, data = _request("/v1/memory/context", body, CONTEXT_TIMEOUT_S)
            if state != "ok" or data is None:
                return ""
            if data.get("ok") is not True or data.get("enabled") is False:
                return ""
            text = data.get("text")
            return text.strip() if isinstance(text, str) else ""
        except Exception as err:  # noqa: BLE001
            logger.debug("knockdesk-memory: system_prompt_block नाकाम (%s)", type(err).__name__)
            return ""

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """इस turn के सवाल से जुड़ी यादें। कुछ न मिले तो ख़ाली string।

        जवाब में `<memory-context>` tag या Hermes का system-note नहीं होता:
        वह लिफ़ाफ़ा Hermes ख़ुद चढ़ाता है (और पहले से लगा हो तो उतार कर
        warning देता है)।
        """
        try:
            asked = _text(query)
            self._note_turn(asked)
            if not asked or self._stay_quiet() or _bridge_looks_down():
                return ""
            body: Dict[str, Any] = {"query": asked[:MAX_QUERY_CHARS], "for_prompt": True}
            sid = _text(session_id) or self._session_id
            if sid:
                body["session_id"] = sid
            state, data = _request("/v1/memory/recall", body, RECALL_TIMEOUT_S)
            if state != "ok" or data is None or data.get("ok") is not True:
                return ""
            text = data.get("text")
            return text.strip() if isinstance(text, str) else ""
        except Exception as err:  # noqa: BLE001
            logger.debug("knockdesk-memory: prefetch नाकाम (%s)", type(err).__name__)
            return ""

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        # जानबूझ कर ख़ाली। Hermes इसे turn के बाद बुलाता है ताकि अगले
        # turn के लिए तलाश पहले से हो जाए; मगर वह तलाश पिछले सवाल
        # पर होती, और अगला सवाल आम तौर पर कुछ और होता है। हमारी
        # तलाश local है (milliseconds), इस लिए `prefetch` असली सवाल पर
        # ताज़ा तलाश करता है। यहाँ कुछ करना सिर्फ़ एक ज़्यादा request होता।
        return None

    # ── लिखना ──────────────────────────────────────────────────────────────

    def sync_turn(self, user_content: str, assistant_content: str, *,
                  session_id: str = "", messages: Optional[List[Dict[str, Any]]] = None) -> None:
        """मुकम्मल turn को क़तार में डालना। फ़ौरन वापस।

        `messages` सिर्फ़ यह देखने के लिए छुआ जाता है कि बाहर का मवाद
        पढ़ा गया या नहीं; उस का हवाला क़तार में नहीं जाता (पूरी
        बातचीत को memory में लटकाए रखना बेवजह होता)।
        """
        try:
            if _bridge() is None:
                return
            user = _text(user_content)
            reply = _text(assistant_content)
            if not user or not reply:
                return
            if _is_automated(user) or self._source in VOICE_ARCHIVE_SOURCES:
                return
            sid = _text(session_id) or self._session_id
            if not sid:
                return

            for label, value in (("user", user), ("assistant", reply)):
                if len(value) > MAX_TURN_CHARS:
                    logger.info(
                        "knockdesk-memory: %s का text %d अक्षरों का था, पहले %d भेजे गए",
                        label, len(value), MAX_TURN_CHARS,
                    )
            user = user[:MAX_TURN_CHARS]
            reply = reply[:MAX_TURN_CHARS]

            now_ms = int(time.time() * 1000)
            started = self._turn_started_ms
            # User का जुमला turn के शुरू का है, जवाब अब का। शुरू का वक़्त
            # न मिले (या अजीब हो) तो बस इतना कि तरतीब सही रहे।
            user_ms = started if 0 < now_ms - started < 6 * 3600 * 1000 else now_ms - 1

            ref = _turn_ref(sid, user_ms, user, reply)
            body: Dict[str, Any] = {
                "session_id": sid,
                "turns": [
                    {"role": "user", "text": user, "ts": user_ms, "ref": f"{ref}:u"},
                    {"role": "assistant", "text": reply, "ts": now_ms, "ref": f"{ref}:a"},
                ],
            }
            if self._title:
                body["title"] = self._title
            if _read_outside_content(messages):
                body["external"] = True
            # दो label जो आज bridge इस्तेमाल नहीं करता (सब `hermes` channel
            # में जाता है) मगर कल काम आ सकते हैं: phone (`knockdesk`) को
            # desktop chat (`tui`) से अलग पहचानना।
            if self._platform:
                body["platform"] = self._platform
            if self._source:
                body["source"] = self._source[:40]

            _writer.enqueue(_Job("/v1/memory/turns", body, "turns"))
            with self._lock:
                self._open_sessions.add(sid)
        except Exception as err:  # noqa: BLE001
            logger.debug("knockdesk-memory: sync_turn नाकाम (%s)", type(err).__name__)

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        """Memory Core को बताना कि बात रुक गई, ताकि वह निचोड़ निकाल सके।

        यह सिर्फ़ एक इशारा है। Hermes इसे हर compression पर भी बुलाता है,
        और desktop chat बंद होने पर अक्सर बुलाता ही नहीं; इस लिए Memory
        Core अपनी ख़ामोशी वाली घड़ी से भी यही काम करता है। बाद में
        नया turn आए तो session ख़ुद दोबारा खुल जाती है।
        """
        try:
            with self._lock:
                ended = list(self._open_sessions)
                self._open_sessions.clear()
            for sid in ended:
                _writer.enqueue(_Job("/v1/memory/session-end", {"session_id": sid}, "session-end"))
        except Exception as err:  # noqa: BLE001
            logger.debug("knockdesk-memory: on_session_end नाकाम (%s)", type(err).__name__)

    def on_memory_write(self, action: str, target: str, content: str,
                        metadata: Optional[Dict[str, Any]] = None) -> None:
        """Hermes की built-in `memory` tool ने कुछ लिखा: उस की नक़ल Memory Core में।

        सिर्फ़ `add` और `replace` (नया पाठ)। `remove` जानबूझ कर नहीं:
        Hermes की file सिर्फ़ 2,200 अक्षरों की है और agent जगह बनाने के
        लिए पुरानी entries हटाता रहता है। उसे यहाँ "भूल जाओ" समझना
        लंबी याददाश्त को एक छोटी file की तंगी की सज़ा देता।
        """
        try:
            if action not in ("add", "replace"):
                return
            if _bridge() is None or self._stay_quiet():
                return
            text = " ".join(_text(content).split())
            if not text or _is_automated(text):
                return
            if len(text) > MAX_MEMORY_CHARS:
                # Store इतनी लंबी याद रद्द कर देता है (काटता नहीं), इस लिए
                # भेजने का फ़ायदा नहीं। पूरा पाठ Hermes की अपनी file में
                # महफ़ूज़ है, और वह file Recall Agent को पूरी जाती है।
                logger.info(
                    "knockdesk-memory: built-in memory की entry %d अक्षरों की थी; Memory Core "
                    "एक याद में %d रखता है, इस लिए इस की नक़ल वहाँ नहीं गई",
                    len(text), MAX_MEMORY_CHARS,
                )
                return
            body: Dict[str, Any] = {"text": text}
            sid = _text((metadata or {}).get("session_id")) or self._session_id
            if sid:
                body["session_id"] = sid
            _writer.enqueue(_Job("/v1/memory/remember", body, "remember"))
        except Exception as err:  # noqa: BLE001
            logger.debug("knockdesk-memory: on_memory_write नाकाम (%s)", type(err).__name__)

    # ── Tools ───────────────────────────────────────────────────────────────

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        # Hermes इसे `initialize` से पहले बुलाता है, और यहाँ की exception
        # provider को उस agent के लिए बंद कर देती है। इस लिए सिर्फ़ तीन
        # तैयार dicts; कोई हिसाब नहीं, कोई network नहीं।
        return [MEMORY_SEARCH_SCHEMA, MEMORY_REMEMBER_SCHEMA, MEMORY_FORGET_SCHEMA]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        try:
            given = args if isinstance(args, dict) else {}
            if tool_name == "memory_search":
                return self._tool_search(given)
            if tool_name == "memory_remember":
                return self._tool_remember(given)
            if tool_name == "memory_forget":
                return self._tool_forget(given)
            return _tool_error(f"Unknown tool: {tool_name}")
        except Exception as err:  # noqa: BLE001
            logger.debug("knockdesk-memory: tool %s नाकाम (%s)", tool_name, type(err).__name__)
            return _tool_error("The KnockDesk memory tool failed. Nothing was read or changed.")

    def _tool_search(self, args: Dict[str, Any]) -> str:
        query = _text(args.get("query"))
        if not query:
            return _tool_error("query is required")
        body: Dict[str, Any] = {"query": query[:MAX_QUERY_CHARS], "for_prompt": False}
        query_en = _text(args.get("query_en"))
        if query_en:
            body["query_en"] = query_en[:MAX_QUERY_CHARS]
        if self._session_id:
            body["session_id"] = self._session_id

        state, data = _request("/v1/memory/recall", body, TOOL_TIMEOUT_S)
        if state != "ok" or data is None:
            return _tool_error(_UNREACHABLE + _SEARCH_NOT_RUN)
        if data.get("ok") is not True:
            return _tool_error("KnockDesk memory is turned off right now." + _SEARCH_NOT_RUN)

        text = data.get("text")
        text = text.strip() if isinstance(text, str) else ""
        try:
            count = int(data.get("count") or 0)
        except (TypeError, ValueError):
            count = 0
        status = _text(data.get("status")) or "NONE"
        if not text:
            # Bridge NONE पर भी हिदायत वाला text देता है। फिर भी ख़ाली
            # आए तो model को ख़ाली जवाब नहीं मिलना चाहिए: ख़ाली जवाब को
            # वह अपनी मर्ज़ी से भर लेता है।
            status, count, text = "NONE", 0, _NOTHING_FOUND
        return _reply({"status": status, "count": count, "result": text})

    def _tool_remember(self, args: Dict[str, Any]) -> str:
        text = " ".join(_text(args.get("text")).split())
        if not text:
            return _tool_error("text is required")
        if self._stay_quiet():
            # ख़ुदकार record (voice का archive, memory note) से Memory Core
            # में याद नहीं बनती: वह बात desktop के अपने रास्ते से पहले ही
            # वहाँ है, और यहाँ से लिखना उसे दो दफ़ा कर देता। Model को
            # साफ़ जवाब मिलता है और वह Hermes की built-in tool पर चला
            # जाता है, यानी बिल्कुल वही जो आज होता है।
            return _reply({"saved": False, "reason": "automated_record", "message": _AUTOMATED_TURN})
        if len(text) > MAX_MEMORY_CHARS:
            # Store इतना लंबा text रद्द कर देता है। यहाँ पहले ही रोक कर
            # model को वजह और हल दिया जाता है — कुछ चुपचाप नहीं कटता।
            return _reply({
                "saved": False,
                "reason": "too_long",
                "message": (
                    f"That is {len(text)} characters and one memory holds at most "
                    f"{MAX_MEMORY_CHARS}. Nothing was saved. Save it as two or more "
                    "memories, one topic each."
                ),
            })
        important = args.get("important")
        pin = important is True or (isinstance(important, str) and important.strip().lower() in ("true", "yes", "1"))
        body: Dict[str, Any] = {"text": text, "pin": pin}
        about = " ".join(_text(args.get("about")).split())[:80]
        if about:
            body["about"] = about
        if self._session_id:
            body["session_id"] = self._session_id

        state, data = _request("/v1/memory/remember", body, TOOL_TIMEOUT_S)
        if state != "ok" or data is None:
            return _reply({
                "saved": False,
                "reason": "unreachable",
                "message": (
                    _UNREACHABLE + " It may not have been saved. Tell the user, or use the "
                    "built-in memory tool instead."
                ),
            })
        saved = data.get("ok") is True
        message = _text(data.get("message")) or ("Saved to memory." if saved else "It was not saved.")
        out: Dict[str, Any] = {"saved": saved, "message": message}
        reason = _text(data.get("reason"))
        if reason:
            out["reason"] = reason
        return _reply(out)

    def _tool_forget(self, args: Dict[str, Any]) -> str:
        query = _text(args.get("query"))
        if not query:
            return _tool_error("query is required")
        if self._stay_quiet():
            return _reply({"forgotten": False, "reason": "automated_record", "message": _AUTOMATED_TURN})
        state, data = _request("/v1/memory/forget", {"query": query[:500]}, TOOL_TIMEOUT_S)
        if state != "ok" or data is None:
            return _reply({
                "forgotten": False,
                "reason": "unreachable",
                "message": _UNREACHABLE + " Nothing was removed. Tell the user it was not forgotten.",
            })
        forgotten = data.get("ok") is True
        message = _text(data.get("message")) or ("Forgotten." if forgotten else "Nothing was removed.")
        out: Dict[str, Any] = {"forgotten": forgotten, "message": message}
        reason = _text(data.get("reason"))
        if reason:
            out["reason"] = reason
        return _reply(out)


def register(ctx) -> None:
    """Plugin का दरवाज़ा। Hermes इसे हर agent के लिए एक दफ़ा बुलाता है।"""
    ctx.register_memory_provider(KnockDeskMemoryProvider())
