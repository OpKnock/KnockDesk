"""`computer_task` — Hermes के लिए KnockDesk का computer-use tool।

Hermes (chat, Agent Town के Alice/Bob/…, phone से आई command, cron) जब
screen पर कोई काम इंसान की तरह करवाना चाहे, तो यह tool KnockDesk desktop
app के Agent S3 sidecar को पूरा task देता है और नतीजा वापस लाता है।

रास्ता:
    Hermes ──HTTP──▶ 127.0.0.1 bridge (desktop app) ──▶ ComputerManager ──▶ Agent S3

Tool BLOCKING है: जब तक task चलता है (एक से कई minute) यह लौटता
नहीं। Hermes का gateway "tool चल रहा है" को activity गिनता है, इस लिए
उसका inactivity timeout इस पर नहीं लगता। इंतज़ार bridge के long-poll से
होता है (हर 60 s एक request), ताकि कोई socket घंटों लटका न रहे।

एक वक़्त में एक ही task चल सकता है (mouse एक है)। दूसरा माँगे तो
`busy` वापस आता है — model को बताता है कि थोड़ी देर बाद दोबारा try करे।
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Dict

logger = logging.getLogger(__name__)

TOOLSET = "knockdesk_computer"
MAX_WAIT_S = 20 * 60          # इस से लंबा task नहीं (safety)
POLL_S = 60                   # bridge का long-poll timeout
DEFAULT_STEPS = 50

COMPUTER_TASK_SCHEMA = {
    "name": "computer_task",
    "description": (
        "Operate the user's Windows desktop like a human would — a dedicated computer-use "
        "agent takes over the real mouse and keyboard, looks at the screen, and works through "
        "the task step by step (open apps, click through menus, fill forms, use any GUI). "
        "Use it for work that can ONLY be done through a graphical interface. Prefer your "
        "terminal, file and browser tools when they can do the job — they are faster and cheaper. "
        "Give one clear, self-contained instruction with all details (app names, exact text to "
        "type, file names). The agent has no memory of earlier calls. The call blocks until the "
        "task finishes (usually 1-5 minutes) and returns what happened. Only one computer task can "
        "run at a time; if it reports busy, wait and retry. The user can stop it at any moment by "
        "moving the mouse."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "task": {
                "type": "string",
                "description": "The complete instruction for the computer-use agent, in English.",
            },
            "max_steps": {
                "type": "integer",
                "description": f"Step budget (each step = one look + one action). Default {DEFAULT_STEPS}, max 120.",
            },
        },
        "required": ["task"],
    },
}


def _bridge() -> tuple[str, str]:
    url = (os.environ.get("STONIC_BRIDGE_URL") or "").rstrip("/")
    key = os.environ.get("STONIC_BRIDGE_KEY") or ""
    return url, key


def check_requirements() -> bool:
    url, key = _bridge()
    return bool(url and key)


def _reply(**payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False)


def handle_computer_task(args: Dict[str, Any], **_kw: Any) -> str:
    import httpx

    task = str((args or {}).get("task") or "").strip()
    if not task:
        return _reply(success=False, error="task is required")
    try:
        max_steps = int((args or {}).get("max_steps") or DEFAULT_STEPS)
    except (TypeError, ValueError):
        max_steps = DEFAULT_STEPS

    url, key = _bridge()
    if not url or not key:
        return _reply(success=False, error="KnockDesk desktop app is not connected (no bridge).")
    headers = {"Authorization": f"Bearer {key}"}

    try:
        with httpx.Client(timeout=httpx.Timeout(POLL_S + 15, connect=5)) as client:
            started = client.post(
                f"{url}/v1/computer/run",
                headers=headers,
                json={"task": task, "max_steps": max_steps},
            )
            data = started.json()
            if not data.get("ok"):
                err = data.get("error", "could not start")
                if err == "busy":
                    busy = data.get("busyWith") or {}
                    return _reply(
                        success=False, busy=True,
                        error=f"The computer-use agent is already working on: {busy.get('task', '?')}. "
                              "Wait for it to finish, then retry.",
                    )
                return _reply(success=False, error=err)

            task_id = data["taskId"]
            deadline = time.time() + MAX_WAIT_S
            while time.time() < deadline:
                r = client.get(
                    f"{url}/v1/computer/wait",
                    headers=headers,
                    params={"id": task_id, "timeout": POLL_S},
                )
                body = r.json()
                if not body.get("ok"):
                    return _reply(success=False, error=body.get("error", "wait failed"), task_id=task_id)
                if body.get("done"):
                    result = body.get("result") or {}
                    status = result.get("status")
                    return _reply(
                        success=status == "done",
                        status=status,
                        steps=result.get("steps"),
                        seconds=result.get("seconds"),
                        summary=result.get("summary"),
                        notes=result.get("notes") or [],
                        error=result.get("error"),
                        task_id=task_id,
                    )
            # वक़्त ख़त्म — task रोक दो, वरना mouse लटका रहेगा।
            client.post(f"{url}/v1/computer/stop", headers=headers, json={"id": task_id})
            return _reply(success=False, status="timeout", task_id=task_id,
                          error=f"Computer task exceeded {MAX_WAIT_S // 60} minutes and was stopped.")
    except httpx.HTTPError as err:
        logger.warning("computer_task bridge error: %s", err)
        return _reply(success=False, error=f"KnockDesk desktop app unreachable: {err}")
    except Exception as err:  # noqa: BLE001
        logger.exception("computer_task failed")
        return _reply(success=False, error=str(err))


def register(ctx) -> None:
    """Plugin का दरवाज़ा — Hermes boot पर बुलाता है।"""
    ctx.register_tool(
        name="computer_task",
        toolset=TOOLSET,
        schema=COMPUTER_TASK_SCHEMA,
        handler=handle_computer_task,
        check_fn=check_requirements,
        requires_env=["STONIC_BRIDGE_URL", "STONIC_BRIDGE_KEY"],
        description="Hand a screen task to KnockDesk's computer-use agent (real mouse + keyboard).",
        emoji="🖱️",
    )
