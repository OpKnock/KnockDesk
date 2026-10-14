"""KnockDesk Mobile platform adapter (Hermes plugin)।

KnockDesk की mobile app को Hermes का एक पूरा messaging
platform बना देता है — WhatsApp, Telegram और Discord के बराबर का
दर्जा, उन्हीं के साथ एक ही क़तार में।

======================================================================
  यह PLUGIN क्यों, कोई अपना रास्ता क्यों नहीं
======================================================================

पहले KnockDesk desktop app ख़ुद Hermes के chat gateway से जुड़ी थी और ख़ुद
ही जवाब जमा कर के phone तक भेजती थी। वह चलता था, मगर वह Hermes
की नक़ल थी — और नक़ल हमेशा असल से पीछे रहती है:

  - tool का progress ("🔍 web_search: …")  — हाथ से बनाना पड़ता
  - सोचने का अमल (thinking relay)         — बिल्कुल नहीं था
  - streaming जवाब                         — सिर्फ़ आख़िर में आता था
  - /model, /stop, /new और बाक़ी commands   — काम ही नहीं करते थे
  - clarify और approval के buttons         — नहीं थे
  - cron से ख़ुद संदेश भेजना             — मुमकिन ही नहीं था
  - send_message tool से phone पर भेजना   — मुमकिन ही नहीं था

यह सब Hermes के gateway (gateway/run.py) में पहले से मौजूद है। एक
platform adapter बन जाने से यह सब मुफ़्त मिल जाता है, और कल Hermes में
कोई नया feature आया तो वह भी ख़ुद-ब-ख़ुद phone तक पहुँच जाएगा —
क्योंकि हम Hermes के अपने रास्ते पर हैं, उसके समानांतर अपना रास्ता बना
कर नहीं चल रहे।

======================================================================
  यह ADAPTER INTERNET से बात नहीं करता
======================================================================

Phone तक संदेश Supabase Realtime से जाता है, मगर वह काम यह adapter
नहीं करता — KnockDesk desktop app (Electron) करती है। यह adapter सिर्फ़ उसी
app के अंदर चलते हुए एक छोटे से local bridge से जुड़ा रहता है:

    Hermes plugin  ──NDJSON stream──▶  127.0.0.1 bridge  ──▶  Supabase  ──▶  📱
                   ◀──── HTTP POST ───

यह तरतीब जानबूझ कर है। Hermes के Python packages exact-pinned हैं
और उनका अपना लिखा हुआ उसूल है: "सिर्फ़ वह package जो हर session इस्तेमाल
करे"। Supabase का Python client उस शर्त पर पूरा नहीं उतरता, और उस
runtime को छेड़ना हमारे पहले उसूल ("Hermes को हाथ नहीं लगाना") के
ख़िलाफ़ है।

Hermes ने ख़ुद यही रास्ता दिखाया है: WhatsApp का adapter भी Python में
है मगर असल WhatsApp से एक local Node bridge बात करता है। हम वही
कर रहे हैं — बस bridge हमारी अपनी desktop app है, जिस में Supabase
का पूरा काम पहले से लिखा हुआ है।

नतीजा: इस plugin को सिर्फ़ ``httpx`` चाहिए, जो Hermes की core dependency
है। कोई नई चीज़ install नहीं होती।

======================================================================
  CONFIG
======================================================================

यह सब env vars KnockDesk desktop app ख़ुद लिखती है (Hermes के अपने
``PUT /api/env`` से) — user को कुछ भरना नहीं पड़ता::

    STONIC_BRIDGE_URL      http://127.0.0.1:<port>   (लाज़मी)
    STONIC_BRIDGE_KEY      shared secret             (लाज़मी)
    STONIC_CHAT_ID         KnockDesk account का user id
    STONIC_ALLOWED_USERS   वही user id
    STONIC_HOME_CHANNEL    वही user id (cron के लिए)

======================================================================
  पहचान और भरोसा
======================================================================

Bridge सिर्फ़ 127.0.0.1 पर सुनता है और हर request पर एक secret माँगता
है जो सिर्फ़ इसी machine पर मौजूद है। उस से पहले का पूरा पहरा Supabase
पर है: phone को उस account का signed token दिखाना पड़ता है जिस का
channel है, वरना संदेश यहाँ तक पहुँचता ही नहीं।

``user_id`` bridge देता है (Supabase का तस्दीक़शुदा user id) — संदेश
के अंदर लिखी हुई किसी चीज़ से नहीं बनता। यह फ़र्क़ अहम है: संदेश का
पाठ भेजने वाले के इख़्तियार में होता है, उस पर पहचान नहीं रखी जा
सकती।
"""

import asyncio
import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

try:
    import httpx
    HTTPX_AVAILABLE = True
except ImportError:  # pragma: no cover - httpx is a core Hermes dependency
    HTTPX_AVAILABLE = False
    httpx = None  # type: ignore[assignment]

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)

logger = logging.getLogger(__name__)

PLATFORM_NAME = "knockdesk"

# Phone की chat पर लंबा जवाब बुरा नहीं लगता (WhatsApp की तरह 4096 की
# कोई सख़्त हद नहीं), मगर बेहद भी नहीं छोड़ना: Supabase Realtime का
# एक broadcast 256 KB तक जाता है, और उस से बड़ा संदेश चुपचाप गिर
# जाता। 12,000 अक्षर उस हद से बहुत नीचे हैं और phone पर आराम से पढ़े
# जाते हैं। इस से लंबा जवाब कई संदेश में बँट जाता है।
MAX_MESSAGE_LENGTH = 12_000

# Bridge गिरने पर दोबारा जोड़ने के वक़्फ़े। Bridge वही desktop app है जो इस
# Hermes को चला रही है — वह बंद हो तो Hermes भी देर तक नहीं रहता,
# इस लिए लंबी backoff की ज़रूरत नहीं।
RECONNECT_BACKOFF = [1, 2, 3, 5, 10]

# Bridge हर 20 second पर एक ping भेजता है। 60 second तक कुछ न आए तो
# connection मरा हुआ समझ लो और नई कोशिश करो।
STREAM_TIMEOUT_SECONDS = 60

DEDUP_WINDOW_SECONDS = 300
DEDUP_MAX_SIZE = 500


class _FatalStreamError(Exception):
    """ऐसी ख़राबी जिस के बाद दोबारा कोशिश बेफ़ायदा है (जैसे: 401)।"""


def _bridge_url() -> str:
    return (os.getenv("STONIC_BRIDGE_URL", "") or "").strip().rstrip("/")


def _bridge_key() -> str:
    return (os.getenv("STONIC_BRIDGE_KEY", "") or "").strip()


def _auth_headers(key: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {key}"} if key else {}


def _default_chat_id() -> str:
    return (os.getenv("STONIC_CHAT_ID", "") or "").strip()


class KnockDeskAdapter(BasePlatformAdapter):
    """KnockDesk mobile adapter — local bridge के ज़रिए phone तक।

    Inbound  : bridge से NDJSON stream (हर line एक संदेश)
    Outbound : bridge पर HTTP POST
    """

    MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH

    # Phone की chat markdown render करती है (code blocks समेत) — desktop
    # app का अपना chat भी वही करता है। इस लिए Hermes का जवाब जैसा है
    # वैसा ही भेजते हैं; tool-progress भी असली fenced code block में।
    supports_code_blocks = True

    # एक turn ख़त्म होने के बाद भी हम संदेश भेज सकते हैं — bridge
    # और Supabase का channel खुला रहता है। इस के बग़ैर Hermes background
    # काम के मुकम्मल होने की ख़बर देने से इनकार कर देता है (और वह भी
    # ठीक ही करता है — ऐसा वादा नहीं करना चाहिए जो पूरा न हो सके)।
    supports_async_delivery = True

    # `send()` ख़ुद लंबे जवाब को टुकड़ों में बाँटता है, इस लिए gateway को
    # अपनी तरफ़ से काटने की ज़रूरत नहीं।
    splits_long_messages = True

    def __init__(self, config: PlatformConfig):
        super().__init__(config=config, platform=Platform(PLATFORM_NAME))

        extra = config.extra or {}
        self._url: str = (extra.get("bridge_url") or _bridge_url()).rstrip("/")
        self._key: str = extra.get("bridge_key") or _bridge_key()
        self._chat_id: str = str(extra.get("chat_id") or _default_chat_id() or "knockdesk")

        self._stream_task: Optional[asyncio.Task] = None
        self._http: Optional["httpx.AsyncClient"] = None
        self._seen: Dict[str, float] = {}

        # किस chat पर अभी एक turn चल रहा है। `_keep_typing` इसे भरता
        # है; bridge इसे phone तक पहुँचा देता है ताकि वहाँ "काम हो रहा
        # है" दिख सके और voice assistant जान सके कि जवाब आ चुका।
        self._turns: set = set()

        # वह tasks जो cancel के दायरे से बाहर भेजी गईं (देखें
        # `_keep_typing`)। Reference रखना लाज़मी है: asyncio सिर्फ़ कमज़ोर
        # reference रखता है, और बिना इस के Python task को बीच में ही
        # उठा सकता है — संदेश कभी भेजता ही नहीं।
        self._detached: set = set()

    # ── Connection ──────────────────────────────────────────────────────────

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if not HTTPX_AVAILABLE:
            logger.warning("[%s] httpx नहीं मिला।", self.name)
            return False
        if not self._url or not self._key:
            logger.warning(
                "[%s] STONIC_BRIDGE_URL या STONIC_BRIDGE_KEY set नहीं। "
                "यह KnockDesk desktop app ख़ुद लिखती है — क्या वह चल रही है?",
                self.name,
            )
            return False

        try:
            self._http = httpx.AsyncClient(timeout=None)
            self._stream_task = asyncio.create_task(self._run_stream())
            self._mark_connected()
            logger.info("[%s] Bridge से जुड़ा: %s", self.name, self._url)
            return True
        except Exception as e:
            logger.error("[%s] Connect fail हुआ: %s", self.name, e)
            return False

    async def disconnect(self) -> None:
        self._running = False
        self._mark_disconnected()

        if self._stream_task:
            self._stream_task.cancel()
            try:
                await self._stream_task
            except asyncio.CancelledError:
                pass
            self._stream_task = None

        if self._http:
            await self._http.aclose()
            self._http = None

        self._seen.clear()
        self._turns.clear()
        logger.info("[%s] Bridge से अलग हो गया", self.name)

    async def _run_stream(self) -> None:
        """Bridge का stream — गिरते ही दोबारा जुड़ जाता है।"""
        backoff = 0
        while self._running:
            started = time.monotonic()
            try:
                await self._consume_stream()
            except asyncio.CancelledError:
                return
            except _FatalStreamError:
                self._running = False
                return
            except Exception as e:
                if not self._running:
                    return
                logger.debug("[%s] Stream टूटा: %s", self.name, e)

            if not self._running:
                return

            # एक minute से ज़्यादा चला तो backoff भूल जाओ — यह एक नई
            # ख़राबी है, पुरानी का सिलसिला नहीं।
            if time.monotonic() - started >= 60.0:
                backoff = 0
            delay = RECONNECT_BACKOFF[min(backoff, len(RECONNECT_BACKOFF) - 1)]
            await asyncio.sleep(delay)
            backoff += 1

    async def _consume_stream(self) -> None:
        """Bridge का NDJSON stream पढ़ना — हर line एक संदेश।"""
        assert self._http is not None
        url = f"{self._url}/v1/in"

        async with self._http.stream(
            "GET",
            url,
            headers=_auth_headers(self._key),
            timeout=httpx.Timeout(
                connect=10.0, read=STREAM_TIMEOUT_SECONDS, write=10.0, pool=10.0
            ),
        ) as response:
            if response.status_code in (401, 403):
                logger.error(
                    "[%s] Bridge ने key क़ुबूल नहीं की (%d)। KnockDesk app दोबारा "
                    "खोल कर देखें।", self.name, response.status_code,
                )
                self._set_fatal_error(
                    "knockdesk_unauthorized",
                    "KnockDesk bridge ने key रद्द कर दी। Desktop app दोबारा चलाएँ।",
                    retryable=False,
                )
                raise _FatalStreamError("unauthorized")
            response.raise_for_status()

            # Stream खुल गया — bridge अब जानता है कि Hermes तैयार है,
            # और वह phone पर हरा नुक्ता जला देता है।
            logger.info("[%s] Bridge का stream खुल गया", self.name)

            async for line in response.aiter_lines():
                if not self._running:
                    return
                line = line.strip()
                if not line:
                    continue
                try:
                    frame = json.loads(line)
                except json.JSONDecodeError:
                    continue

                kind = frame.get("type")
                if kind == "ping":
                    continue
                if kind == "message":
                    await self._on_message(frame)

    # ── Inbound ─────────────────────────────────────────────────────────────

    async def _on_message(self, frame: Dict[str, Any]) -> None:
        message_id = str(frame.get("id") or uuid.uuid4().hex)
        if self._is_duplicate(message_id):
            return

        text = str(frame.get("text") or "").strip()
        if not text:
            return

        # ── पहचान BRIDGE से आती है, संदेश से नहीं ────────────────────
        #
        # `user_id` वह Supabase user id है जिसे Supabase ने ख़ुद verify किया
        # और desktop app ने bridge तक पहुँचाया। संदेश के अंदर लिखी हुई
        # किसी चीज़ पर पहचान नहीं रखी जाती — पाठ भेजने वाले के
        # इख़्तियार में होता है, और उस पर भरोसा करना authorization को
        # बेमानी कर देता।
        user_id = str(frame.get("user_id") or self._chat_id)
        chat_id = str(frame.get("chat_id") or user_id)
        user_name = str(frame.get("user_name") or "KnockDesk")

        source = self.build_source(
            chat_id=chat_id,
            chat_name="KnockDesk Mobile",
            chat_type="dm",
            user_id=user_id,
            user_name=user_name,
            message_id=message_id,
        )

        ts = frame.get("ts")
        try:
            timestamp = (
                datetime.fromtimestamp(float(ts) / 1000.0, tz=timezone.utc)
                if ts else datetime.now(tz=timezone.utc)
            )
        except (ValueError, OSError, TypeError):
            timestamp = datetime.now(tz=timezone.utc)

        event = MessageEvent(
            text=text,
            message_type=MessageType.TEXT,
            source=source,
            message_id=message_id,
            raw_message=frame,
            timestamp=timestamp,
        )

        logger.debug("[%s] Phone से: %s", self.name, text[:80])
        await self.handle_message(event)

    def _is_duplicate(self, message_id: str) -> bool:
        now = time.time()
        if len(self._seen) > DEDUP_MAX_SIZE:
            cutoff = now - DEDUP_WINDOW_SECONDS
            self._seen = {k: v for k, v in self._seen.items() if v > cutoff}
        if message_id in self._seen:
            return True
        self._seen[message_id] = now
        return False

    # ── Outbound ────────────────────────────────────────────────────────────

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        if not self._http:
            return SendResult(success=False, error="KnockDesk bridge से राब्ता नहीं है")

        chunks = self.truncate_message(content, max_length=self.MAX_MESSAGE_LENGTH)
        last_id: Optional[str] = None

        for chunk in chunks:
            payload: Dict[str, Any] = {
                "kind": "message",
                "chat_id": str(chat_id or self._chat_id),
                "text": chunk,
                "message_id": uuid.uuid4().hex,
            }
            if reply_to:
                payload["reply_to"] = str(reply_to)

            result = await self._post(payload)
            if not result.get("ok"):
                return SendResult(success=False, error=str(result.get("error") or "bridge send fail"))
            last_id = payload["message_id"]

        return SendResult(success=True, message_id=last_id or uuid.uuid4().hex)

    async def edit_message(
        self,
        chat_id: str,
        message_id: str,
        content: str,
        *,
        finalize: bool = False,
    ) -> SendResult:
        """एक भेजा हुआ संदेश बदल देना।

        ── यह METHOD क्यों है (सिर्फ़ "अच्छा लगता है" नहीं) ────────────────

        Hermes tool का progress एक नए संदेश के तौर पर नहीं भेजता — वह
        एक ही bubble बनाता है और उसे बार-बार बदलता रहता है:

            🔍 web_search: "gpt-5.6 pricing"
            🔍 web_search: "gpt-5.6 pricing"
            📄 read_file: report.md          ← वही bubble, नई लकीर

        और उसका फ़ैसला बिल्कुल साफ़ है (gateway/run.py, send_progress_messages):

            if type(adapter).edit_message is BasePlatformAdapter.edit_message:
                ...सारा progress चुपचाप फेंक दो...

        यानी जो adapter यह method नहीं लिखता, Hermes उसके लिए tool progress
        भेजता ही नहीं — एक भी लकीर नहीं, कोई error भी नहीं। बिल्कुल यही
        हुआ था: phone पर सिर्फ़ आख़िरी जवाब आता था, जबकि उसी turn में
        तीन tools चल चुके होते थे।

        वही शर्त streaming पर भी लगती है (SUPPORTS_MESSAGE_EDITING) —
        बिना edit के Hermes आधा संदेश भेजने से इनकार कर देता है, और
        ठीक करता है: बिना बदले जा सकने वाले आधे संदेश से तो पूरा
        संदेश बेहतर है।

        Phone की तरफ़ यह एक `edit` event बन कर जाता है और वहाँ उसी id
        वाला संदेश जगह पर बदल जाता है — कोई नई bubble नहीं बनती।
        Id `send()` की दी हुई होती है, इस लिए दोनों तरफ़ एक ही नाम चलता
        है।

        `finalize` यहाँ बेअसर है: हमारी chat का कोई "अभी बन रहा है"
        वाला अलग रूप नहीं जो बंद करना पड़े (वह DingTalk जैसे rich cards
        के लिए है)। फिर भी phone तक भेज देते हैं — सस्ता है, और उस
        से वह जान सकता है कि यह आख़िरी तब्दीली थी।
        """
        if not self._http:
            return SendResult(success=False, error="KnockDesk bridge से राब्ता नहीं है")

        result = await self._post({
            "kind": "edit",
            "chat_id": str(chat_id or self._chat_id),
            "message_id": str(message_id),
            "text": content[:MAX_MESSAGE_LENGTH],
            "final": bool(finalize),
        })
        if not result.get("ok"):
            # `success=False` का मतलब Hermes के लिए "edit नहीं हो सका" है,
            # और वह ख़ुद नया संदेश भेज कर सँभाल लेता है। इस लिए
            # यहाँ से throw करना कभी ठीक नहीं।
            return SendResult(success=False, error=str(result.get("error") or "bridge edit fail"))

        return SendResult(success=True, message_id=str(message_id))

    # ── Files: desktop की disk से phone तक ─────────────────────────────────
    #
    # ════════════════════════════════════════════════════════════════════════
    #  यह तीन METHOD ही पूरा FEATURE हैं
    # ════════════════════════════════════════════════════════════════════════
    #
    #  Hermes का base adapter ख़ुद पहचान लेता है कि जवाब में किसी file का
    #  रास्ता है (gateway/platforms/base.py, `_non_image_local` वग़ैरा) और
    #  उस पर यह methods बुलाता है। जो adapter इन्हें नहीं लिखता, उसके लिए
    #  वह file एक सादी सी text लकीर बन कर रह जाती है:
    #
    #      "📎 File: C:\\Users\\<account>\\report.pdf"
    #
    #  यानी phone पर एक ऐसा रास्ता जो उस पर खुलता ही नहीं। बिल्कुल यही
    #  पहले हो रहा था — user "वह file भेजो" कहता और उसे file का पता
    #  मिलता, file नहीं।
    #
    #  इन्हें लिख देने से पूरा सिलसिला ख़ुद-ब-ख़ुद चल पड़ता है: agent ने
    #  जो file बनाई या ढूँढी, वह सीधा phone पर पहुँच जाती है। हम यहाँ
    #  file ख़ुद नहीं भेजते — सिर्फ़ उसका रास्ता bridge को देते हैं, और आगे
    #  का काम (Supabase Storage पर रखना) desktop करता है। वजह साफ़ है:
    #  एक 20MB की file को base64 बना कर HTTP पर भेजना Hermes के turn को
    #  रोक देता, जबकि वह file bridge से दो क़दम दूर ही पड़ी है।

    async def _send_file(
        self,
        chat_id: str,
        file_path: str,
        caption: Optional[str] = None,
        file_name: Optional[str] = None,
    ) -> SendResult:
        """एक file का पता bridge तक। असल upload desktop करता है।"""
        if not self._http:
            return SendResult(success=False, error="KnockDesk bridge से राब्ता नहीं है")

        message_id = uuid.uuid4().hex
        result = await self._post({
            "kind": "file",
            "chat_id": str(chat_id or self._chat_id),
            "path": str(file_path),
            "name": str(file_name) if file_name else "",
            "caption": (caption or "")[:MAX_MESSAGE_LENGTH],
            "message_id": message_id,
        })

        if not result.get("ok"):
            return SendResult(success=False, error=str(result.get("error") or "bridge file fail"))
        return SendResult(success=True, message_id=message_id)

    async def send_document(
        self,
        chat_id: str,
        file_path: str,
        caption: Optional[str] = None,
        file_name: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs,
    ) -> SendResult:
        return await self._send_file(chat_id, file_path, caption, file_name)

    async def send_image_file(
        self,
        chat_id: str,
        image_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs,
    ) -> SendResult:
        # तस्वीर और document का रास्ता एक ही है — फ़र्क़ सिर्फ़ phone पर
        # दिखने का है, और वह फ़ैसला वहाँ mime type से होता है। यहाँ दो
        # अलग रास्ते बनाने का मतलब एक ही चीज़ दो जगह सँभालना होता।
        return await self._send_file(chat_id, image_path, caption)

    async def send_video(
        self,
        chat_id: str,
        video_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs,
    ) -> SendResult:
        return await self._send_file(chat_id, video_path, caption)

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        # Phone पर "लिख रहा है" वाला निशान। नाकाम हो जाए तो कोई बात
        # नहीं — यह सिर्फ़ आराम के लिए है, काम इस पर नहीं रुका।
        await self._post({"kind": "typing", "chat_id": str(chat_id or self._chat_id)})

    async def _keep_typing(
        self,
        chat_id: str,
        interval: float = 2.0,
        metadata=None,
        stop_event: "asyncio.Event | None" = None,
    ) -> None:
        """Turn का आग़ाज़ और अंजाम — phone को दोनों की ख़बर देता है।

        ── यह OVERRIDE क्यों है ────────────────────────────────────────────

        Hermes एक turn के दौरान कई संदेश भेजता है: tool का progress,
        फिर असली जवाब। Phone को यह जानना ज़रूरी है कि turn कब ख़त्म
        हुआ — दो वजह से:

          1. Screen पर "काम हो रहा है" तभी तक दिखना चाहिए
          2. Voice assistant को जवाब बोलना है, और उसे पता होना चाहिए
             कि अब और कुछ नहीं आ रहा

        `handle_message` इस के लिए काम नहीं आता — वह फ़ौरन वापस आ जाता
        है और असल काम एक background task में होता है। `_keep_typing`
        पूरे turn के दौरान चलता है और turn ख़त्म होते ही cancel होता
        है, इस लिए यही वह दो लमहे जानने की ठीक जगह है। Hermes के
        अपने docs इसी को इस क़िस्म की चीज़ के लिए extension point कहते हैं।

        `super()` को बुलाना लाज़मी है, वरना typing का निशान चलता ही नहीं।
        और `finally` ज़रूरी है: turn cancel हो कर ख़त्म हो तो भी phone
        को बताना है, वरना वह हमेशा "काम हो रहा है" पर अटका रहेगा।
        """
        chat = str(chat_id or self._chat_id)
        if chat not in self._turns:
            self._turns.add(chat)
            await self._post({"kind": "turn", "chat_id": chat, "active": True})
        try:
            await super()._keep_typing(
                chat_id, interval=interval, metadata=metadata, stop_event=stop_event
            )
        finally:
            self._turns.discard(chat)
            # ── TURN-END को अलग TASK में भेजते हैं — जानबूझ कर ──────
            #
            # यह `finally` उस वक़्त चलता है जब gateway ने इस task को CANCEL
            # किया होता है (turn ख़त्म होने पर वह यही करता है)। ऐसी
            # हालत में सीधा await करना भरोसे के लायक़ नहीं —
            # cancel होती हुई task का अगला await ख़ुद भी cancel हो सकता है,
            # और जो तरफ़ हमारा इंतज़ार कर रही है उस का अपना आधा
            # second का timeout है।
            #
            # उस सूरत में turn-end का संदेश कभी भेजता ही नहीं, और
            # phone हमेशा "काम हो रहा है" पर अटका रह जाता — जवाब
            # सामने होते हुए भी। यह उस क़िस्म की ख़राबी है जो महीने बाद,
            # किसी और चीज़ को ढूँढते हुए मिलती है।
            #
            # अलग task cancel के दायरे से बाहर होती है। उसका reference
            # रखना ज़रूरी है: बिना reference के Python उसे बीच में ही
            # उठा (garbage collect कर) सकता है।
            self._detach(self._post({"kind": "turn", "chat_id": chat, "active": False}))

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": "KnockDesk Mobile", "type": "dm", "chat_id": chat_id}

    def _detach(self, coro) -> None:
        """एक काम को मौजूदा task के cancel से बाहर भेज देना।

        सिर्फ़ turn-end के लिए — उस का पहुँचना लाज़मी है, चाहे जिस task ने
        उसे शुरू किया वह मर रही हो। तफ़सील `_keep_typing` में लिखी है।

        Loop ही बंद हो रहा हो तो नई task बन ही नहीं सकती। उस सूरत में
        gateway वैसे भी जा रहा है और phone का connection अपने आप गिरेगा,
        इस लिए चुपचाप छोड़ देना ठीक है।
        """
        try:
            task = asyncio.create_task(coro)
        except RuntimeError:
            coro.close()
            return
        self._detached.add(task)
        task.add_done_callback(self._detached.discard)

    async def _post(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Bridge पर एक संदेश। कभी throw नहीं करता।

        Bridge का न मिलना एक आम बात है (desktop app बंद हो गई, या
        restart हो रही है)। उस पर exception फेंकना Hermes के turn को मार
        देता — जबकि मसला सिर्फ़ "आख़िरी क़दम" का है। इस लिए हर ख़राबी
        यहाँ एक सादा dict बन कर वापस जाती है।
        """
        if not self._http:
            return {"ok": False, "error": "bridge client not ready"}
        try:
            res = await self._http.post(
                f"{self._url}/v1/out",
                json=payload,
                headers={**_auth_headers(self._key), "Content-Type": "application/json"},
                timeout=15.0,
            )
            if res.status_code < 300:
                return {"ok": True}
            return {"ok": False, "error": f"HTTP {res.status_code}: {res.text[:200]}"}
        except Exception as e:  # noqa: BLE001 - हर ख़राबी बराबर है
            return {"ok": False, "error": str(e)}


# ═══════════════════════════════════════════════════════════════════════════
#  Plugin registration
# ═══════════════════════════════════════════════════════════════════════════


def check_requirements() -> bool:
    return HTTPX_AVAILABLE


def validate_config(pconfig) -> bool:
    extra = getattr(pconfig, "extra", {}) or {}
    url = extra.get("bridge_url") or _bridge_url()
    key = extra.get("bridge_key") or _bridge_key()
    return bool(url and key)


def is_connected(pconfig) -> bool:
    return validate_config(pconfig)


def _env_enablement() -> Optional[dict]:
    """Env vars से platform को ख़ुद-ब-ख़ुद on करना।

    KnockDesk desktop app यह vars Hermes के अपने ``PUT /api/env`` से लिखती है।
    उन के मौजूद होते ही platform config में आ जाता है — user को config.yaml
    खोलने की ज़रूरत नहीं पड़ती, और ``hermes gateway status`` में भी नज़र
    आ जाता है।
    """
    url = _bridge_url()
    key = _bridge_key()
    if not url or not key:
        return None

    chat_id = _default_chat_id()
    seed: dict = {"bridge_url": url, "bridge_key": key}
    if chat_id:
        seed["chat_id"] = chat_id

    home = (os.getenv("STONIC_HOME_CHANNEL", "") or "").strip() or chat_id
    if home:
        seed["home_channel"] = {"chat_id": home, "name": "KnockDesk Mobile"}
    return seed


async def _standalone_send(
    pconfig,
    chat_id: str,
    message: str,
    *,
    thread_id: Optional[str] = None,
    media_files: Optional[List[str]] = None,
    force_document: bool = False,
) -> Dict[str, Any]:
    """Gateway के बाहर से भेजना — cron और ``send_message`` tool के लिए।

    जब ``hermes cron`` gateway से अलग process में चलता है तो कोई ज़िंदा
    adapter मौजूद नहीं होता। इस hook के बग़ैर ``deliver=knockdesk`` वाला cron
    job चलता तो है मगर संदेश "No live adapter" कह कर गिर जाता है।

    यहाँ हम एक वक़्ती HTTP client से सीधा bridge पर भेज देते हैं —
    bridge चल रहा हो तो संदेश phone तक पहुँच जाता है।
    """
    if not HTTPX_AVAILABLE:
        return {"error": "knockdesk: httpx नहीं मिला"}

    extra = getattr(pconfig, "extra", {}) or {}
    url = (extra.get("bridge_url") or _bridge_url()).rstrip("/")
    key = extra.get("bridge_key") or _bridge_key()
    target = str(chat_id or extra.get("chat_id") or _default_chat_id() or "").strip()

    if not url or not key:
        return {"error": "knockdesk: bridge configured नहीं है (desktop app बंद है?)"}
    if not target:
        return {"error": "knockdesk: chat id मालूम नहीं"}

    message_id = uuid.uuid4().hex
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            res = await client.post(
                f"{url}/v1/out",
                json={
                    "kind": "message",
                    "chat_id": target,
                    "text": message[:MAX_MESSAGE_LENGTH],
                    "message_id": message_id,
                },
                headers={**_auth_headers(key), "Content-Type": "application/json"},
            )
            if res.status_code >= 300:
                return {"error": f"knockdesk bridge HTTP {res.status_code}: {res.text[:200]}"}

            # ── Files भी, अगर साथ हों ────────────────────────────────
            #
            # यह हिस्सा cron के लिए है। Gateway के बाहर कोई ज़िंदा adapter
            # नहीं होता, इस लिए ऊपर वाले `send_document` यहाँ चलते ही
            # नहीं। बिना इस के "हर रात report बना कर phone पर भेजो"
            # जैसा job चलता तो है, मगर phone पर सिर्फ़ text पहुँचता है
            # और report पीछे रह जाती है — यानी job का असल मक़सद ही
            # पूरा नहीं होता।
            #
            # हर file अपना अलग संदेश बनती है (बिल्कुल वैसे ही जैसे
            # ज़िंदा adapter में बनती है), और एक file का न जाना बाक़ी को
            # नहीं रोकता।
            for media_path, _is_voice in (media_files or []):
                try:
                    file_res = await client.post(
                        f"{url}/v1/out",
                        json={
                            "kind": "file",
                            "chat_id": target,
                            "path": str(media_path),
                            "name": "",
                            "caption": "",
                            "message_id": uuid.uuid4().hex,
                        },
                        headers={**_auth_headers(key), "Content-Type": "application/json"},
                    )
                    if file_res.status_code >= 300:
                        logger.warning(
                            "knockdesk: file bridge तक नहीं गई (HTTP %s)", file_res.status_code
                        )
                except Exception as file_err:  # noqa: BLE001
                    logger.warning("knockdesk: file भेजने में मसला: %s", file_err)

        return {
            "success": True,
            "platform": PLATFORM_NAME,
            "chat_id": target,
            "message_id": message_id,
        }
    except Exception as e:  # noqa: BLE001
        return {"error": f"knockdesk standalone send fail: {e}"}


def register(ctx) -> None:
    """Plugin का दरवाज़ा — Hermes का plugin system boot पर इसे बुलाता है।"""
    # ── Live activity — desktop की chat window के लिए ──────────────────────
    #
    # Platform से अलग चीज़ है, इस लिए पहले। Platform सिर्फ़ phone की chat
    # है; यह hooks हर उस काम को देखते हैं जो इस gateway process में
    # चलता है — phone से आई command, Agent Town के teammates, और cron के
    # वक़्त पर चलने वाले काम — और उनका live progress desktop की screen तक
    # पहुँचाते हैं।
    #
    # Bridge न मिले तो यह ख़ुद-ब-ख़ुद ख़ामोश रहते हैं, इस लिए यहाँ कोई
    # शर्त लगाने की ज़रूरत नहीं। तफ़सील: activity.py
    try:
        from . import activity

        activity.register_hooks(ctx)
    except Exception as err:  # noqa: BLE001
        # Live activity एक बेहतरी है, शर्त नहीं। इसकी नाकामी पर पूरा
        # plugin (यानी phone का पूरा राब्ता) नहीं गिरना चाहिए।
        logger.warning("KnockDesk live activity hooks नहीं लग सके: %s", err)

    ctx.register_platform(
        name=PLATFORM_NAME,
        label="KnockDesk Mobile",
        adapter_factory=lambda cfg: KnockDeskAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=["STONIC_BRIDGE_URL", "STONIC_BRIDGE_KEY"],
        install_hint="httpx पहले से Hermes की dependency है — कुछ install नहीं करना।",
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var="STONIC_HOME_CHANNEL",
        standalone_sender_fn=_standalone_send,
        allowed_users_env="STONIC_ALLOWED_USERS",
        allow_all_env="STONIC_ALLOW_ALL_USERS",
        max_message_length=MAX_MESSAGE_LENGTH,
        emoji="📱",
        # KnockDesk की पहचान एक Supabase user id है — कोई phone number या
        # email नहीं जिसे logs में छुपाना पड़े।
        pii_safe=True,
        allow_update_command=True,
        platform_hint=(
            "You are talking to the user through the KnockDesk mobile app. "
            "The app renders full Markdown, including fenced code blocks, "
            "tables and links — use them freely. "
            "The user is on a PHONE: keep answers tight and scannable, put the "
            "answer first and the detail after, and avoid very wide tables. "
            "You are running on the user's own desktop computer, so you can act "
            "on their files, apps and browser — the phone is only the remote "
            "control they are speaking through. "
            # यह दो जुमले बिल्कुल ज़रूरी हैं। Agent को file भेजने की
            # सलाहियत मिल चुकी है, मगर वह उस से ख़ुद नहीं जानता कि
            # मिल चुकी है — और जो सलाहियत वह अपनी नहीं समझता, उसे
            # कभी इस्तेमाल नहीं करता। बिना इन जुमलों के वह "यह file मेरे
            # पास है, आप desktop पर देख लें" कहता रहता, जबकि file
            # भेजना अब एक line का काम है।
            "You CAN send files to the phone: when the user asks for a file, "
            "a screenshot, a document or an image that exists on this computer, "
            "put its absolute path in your reply and it is delivered to their "
            "phone as a real attachment they can open and save. Files up to "
            "25 MB work; for anything larger, compress it or send a link instead."
        ),
    )
