"""Live activity feed — agent अभी क्या कर रहा है, desktop की screen तक।

======================================================================
  यह फ़ाइल क्यों बनी
======================================================================

KnockDesk की chat window Hermes के DASHBOARD से जुड़ी हुई है (`/api/ws`)। मगर
हर काम वहाँ नहीं होता:

    phone से आई command      ─┐
    Agent Town के teammates    ─┼─▶  Hermes का GATEWAY process
    cron का वक़्त पर चलना      ─┘

Gateway एक अलग process है, और उसके live events dashboard तक जाते ही नहीं।
नतीजा user की नज़र से बिल्कुल साफ़ था: chat खोलो और वह "अटकी हुई" लगती
है — अंदर तीन tool चल चुके होते हैं और screen पर पत्ता तक नहीं
हिलता।

यह फ़ाइल वही ख़ाली जगह भरती है। Hermes के अपने plugin hooks से हर tool का
शुरू और अंजाम पकड़ कर desktop के local bridge पर भेज देती है, और
वहाँ से वह सीधा chat window में tool cards बन जाते हैं।

======================================================================
  Hermes को हाथ नहीं लगाया गया
======================================================================

यह Hermes का अपना, दस्तावेज़ वाला रास्ता है — `pre_tool_call` और
`post_tool_call` (hermes_cli/plugins.py: VALID_HOOKS)। Hermes हर callback को
अपने try/except में बुलाता है, और observer callback का `None` लौटाना उसके
लिए बिल्कुल आम बात है। यानी यहाँ की कोई भी ख़राबी agent के turn तक
पहुँच ही नहीं सकती।

Hook में `session_id` भी आता है — यही वह धागा है जिस से desktop
पहचानता है कि यह काम किस chat का है।

======================================================================
  तीन उसूल जिन पर यह पूरी फ़ाइल खड़ी है
======================================================================

  1. TURN कभी न रुके। Hook agent के अपने loop के अंदर, उसी thread पर
     चलता है। Network वहाँ से छूना एक गंभीर ग़लती होती: bridge का
     एक सुस्त जवाब सीधा user के इंतज़ार में जुड़ जाता। इस लिए hook सिर्फ़
     एक क़तार में डाल कर फ़ौरन वापस आ जाता है, और भेजने का काम एक
     अलग, background thread करती है।

  2. क़तार भर जाए तो नया गिरा दो। यह सिर्फ़ दिखाने की चीज़ है। Desktop
     बंद हो या bridge जवाब न दे, तो यहाँ चीज़ें जमा होती रहें — वह
     memory का रास्ता है। एक छोटी हद, और उस से आगे ख़ामोशी से गिर जाना
     ही ठीक बर्ताव है।

  3. यह सब सिर्फ़ इसी computer पर रहता है। Tool के args और नतीजे में
     file के रास्ते, API के जवाब, और संवेदनशील चीज़ें होती हैं। यह 127.0.0.1
     पर desktop app तक जाता है और वहीं screen पर दिखता है — बिल्कुल
     वैसे ही जैसे desktop की अपनी chat window में दिखता है। Cloud पर,
     या phone तक, यह कभी नहीं जाता (देखो src/lib/remote/link.ts, जहाँ
     `activity` frame जानबूझ कर phone वाले रास्ते से बाहर रखा गया है)।
"""

from __future__ import annotations

import json
import logging
import os
import queue
import threading
import time
import urllib.request
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# Bridge पर इस नाम का frame जाता है। Desktop इसी से पहचानता है कि यह
# phone के लिए नहीं, अपनी screen के लिए है।
FRAME_KIND = "activity"

# ── हदें ─────────────────────────────────────────────────────────────────
#
# Tool के args और नतीजे बेहिसाब बड़े हो सकते हैं (एक पूरी file पढ़ ली
# गई हो, या एक बड़ा API जवाब)। Chat window को उन का सिर्फ़ एक झलक चाहिए —
# पूरा पाठ वहाँ वैसे भी नहीं समाता। काट कर भेजना दो फ़ायदे देता है:
# bridge पर बोझ नहीं पड़ता, और एक भारी tool का नतीजा app की memory नहीं
# खा जाता।
MAX_ARGS_CHARS = 1_000
MAX_RESULT_CHARS = 2_000

# क़तार की हद। एक आम turn में 5-20 tool events होते हैं; 256 उस से कहीं
# ज़्यादा है। इस से आगे का मतलब है कि दूसरी तरफ़ कोई सुन ही नहीं रहा।
MAX_QUEUE = 256

# Bridge को जवाब देने के लिए इतना वक़्त। छोटा जानबूझ कर है: यह काम
# background thread का है, मगर एक मरता हुआ desktop उस thread को भी
# हमेशा के लिए नहीं रोक सकता।
POST_TIMEOUT_S = 5.0

# Bridge न मिले तो इतनी देर ख़ामोश रहना — हर event पर दोबारा कोशिश
# करना सिर्फ़ logs भरता है और CPU खाता है।
BACKOFF_S = 15.0


def _bridge() -> Optional[tuple]:
    """Bridge का पता और उसकी चाबी — दोनों मौजूद हों तभी।

    Desktop app यह दोनों env vars ख़ुद लिखती है (`PUT /api/env`)। Gateway
    उन्हें अपने start पर पढ़ता है, इस लिए यहाँ हर दफ़ा पढ़ना सस्ता भी
    है और सही भी — app ने बीच में port बदला हो तो अगला event नई
    जगह चला जाता है।
    """
    url = (os.getenv("STONIC_BRIDGE_URL", "") or "").strip().rstrip("/")
    key = (os.getenv("STONIC_BRIDGE_KEY", "") or "").strip()
    if not url or not key:
        return None
    return url, key


def _clip(value: Any, limit: int) -> str:
    """किसी भी चीज़ को एक सीमित, पढ़ने के क़ाबिल string में बदलना।"""
    if value is None:
        return ""
    if isinstance(value, str):
        text = value
    else:
        try:
            text = json.dumps(value, ensure_ascii=False, default=str)
        except Exception:
            text = str(value)
    if len(text) <= limit:
        return text
    return text[:limit] + "…"


class _Publisher:
    """एक background thread जो क़तार ख़ाली करती रहती है।

    Thread पहले event पर बनती है (`_ensure_thread`), इस लिए जिन
    installs पर यह feature चलता ही नहीं वहाँ एक भी ज़्यादा thread नहीं
    बनती। Daemon इस लिए कि gateway बंद होने पर यह किसी को रोक न सके।
    """

    def __init__(self) -> None:
        self._queue: "queue.Queue[Dict[str, Any]]" = queue.Queue(maxsize=MAX_QUEUE)
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._quiet_until = 0.0
        self._dropped = 0

    def publish(self, frame: Dict[str, Any]) -> None:
        """क़तार में डालो और फ़ौरन वापस। यहाँ से कुछ भी नहीं रुकता।"""
        if _bridge() is None:
            return
        try:
            self._queue.put_nowait(frame)
        except queue.Full:
            # दूसरी तरफ़ कोई सुन नहीं रहा। गिनती रख लेते हैं ताकि logs
            # में एक दफ़ा साफ़ नज़र आए कि क्या हो रहा था।
            self._dropped += 1
            if self._dropped % 100 == 1:
                logger.debug("knockdesk activity: क़तार भरी, %d events गिरे", self._dropped)
            return
        self._ensure_thread()

    def _ensure_thread(self) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._thread = threading.Thread(
                target=self._drain,
                name="knockdesk-activity",
                daemon=True,
            )
            self._thread.start()

    def _drain(self) -> None:
        while True:
            try:
                frame = self._queue.get(timeout=30.0)
            except queue.Empty:
                # काम ख़त्म। Thread बंद हो जाती है; अगला event उसे दोबारा
                # बना लेगा।
                with self._lock:
                    if self._queue.empty():
                        self._thread = None
                        return
                continue
            self._send(frame)

    def _send(self, frame: Dict[str, Any]) -> None:
        if time.monotonic() < self._quiet_until:
            return
        target = _bridge()
        if target is None:
            return
        url, key = target
        try:
            request = urllib.request.Request(
                f"{url}/v1/out",
                data=json.dumps(frame, ensure_ascii=False).encode("utf-8"),
                headers={
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                },
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=POST_TIMEOUT_S):
                pass
        except Exception as err:  # noqa: BLE001 - हर ख़राबी बराबर है
            # Desktop बंद है या restart हो रही है — यह बिल्कुल आम हालत
            # है, कोई ख़राबी नहीं। थोड़ी देर ख़ामोश हो जाते हैं।
            self._quiet_until = time.monotonic() + BACKOFF_S
            logger.debug("knockdesk activity: bridge तक नहीं पहुँचा (%s)", err)


_publisher = _Publisher()


# ── Hermes के hooks ──────────────────────────────────────────────────────
#
# दोनों callbacks `**kwargs` लेते हैं और `None` लौटाते हैं। यह दो बातें
# इत्तेफ़ाक़ी नहीं हैं:
#
#   • Hermes वक़्त के साथ नए kwargs भेजता रहता है (जैसे
#     `telemetry_schema_version`)। सख़्त signature लिखने का मतलब होता कि
#     अगले Hermes update पर यह चुपचाप काम करना बंद कर दे।
#
#   • `pre_tool_call` का लौटाया हुआ dict एक POLICY फ़ैसला समझा जाता है —
#     `{"action": "block"}` tool को रोक देता है। हम सिर्फ़ देखने वाले हैं,
#     रोकने वाले नहीं, इस लिए यहाँ से हमेशा `None`।


def on_pre_tool_call(**kwargs: Any) -> None:
    """एक tool शुरू हुआ।"""
    try:
        session_id = str(kwargs.get("session_id") or "").strip()
        if not session_id:
            # बिना session के desktop यह नहीं जान सकता कि कौन सी chat है —
            # और ग़लत chat में दिखाना न दिखाने से बुरा है।
            return
        _publisher.publish({
            "kind": FRAME_KIND,
            "event": "tool.start",
            "session_id": session_id,
            "tool_id": str(kwargs.get("tool_call_id") or "") or None,
            "name": str(kwargs.get("tool_name") or "tool"),
            "args": _clip(kwargs.get("args"), MAX_ARGS_CHARS),
            "ts": time.time(),
        })
    except Exception as err:  # noqa: BLE001
        logger.debug("knockdesk activity: pre_tool_call frame नहीं बन सका (%s)", err)
    return None


def on_post_tool_call(**kwargs: Any) -> None:
    """एक tool ख़त्म हुआ — नतीजे के साथ।"""
    try:
        session_id = str(kwargs.get("session_id") or "").strip()
        if not session_id:
            return
        status = str(kwargs.get("status") or "").strip().lower()
        error = kwargs.get("error_message")
        _publisher.publish({
            "kind": FRAME_KIND,
            "event": "tool.complete",
            "session_id": session_id,
            "tool_id": str(kwargs.get("tool_call_id") or "") or None,
            "name": str(kwargs.get("tool_name") or "tool"),
            "result": _clip(kwargs.get("result"), MAX_RESULT_CHARS),
            "error": _clip(error, MAX_ARGS_CHARS) or None,
            # Hermes "ok" / "error" भेजता है। ख़ाली हो तो error की मौजूदगी
            # से फ़ैसला — यानी शक का फ़ायदा कामयाबी को नहीं, सच को।
            "ok": (status == "ok") if status else not error,
            "duration_ms": kwargs.get("duration_ms"),
            "ts": time.time(),
        })
    except Exception as err:  # noqa: BLE001
        logger.debug("knockdesk activity: post_tool_call frame नहीं बन सका (%s)", err)
    return None


def register_hooks(ctx) -> None:
    """दोनों hooks Hermes के plugin system पर लगाना।"""
    ctx.register_hook("pre_tool_call", on_pre_tool_call)
    ctx.register_hook("post_tool_call", on_post_tool_call)
