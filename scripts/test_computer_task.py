"""Behavioral regression tests for the `computer_task` Hermes plugin.

The plugin talks to the desktop bridge over HTTP. These tests replace `httpx`
with a tiny in-process fake so the real handler, its long-poll loop and its
cleanup path are exercised without a running Electron app or API credentials.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
TOOL_PATH = ROOT / "resources" / "hermes-plugins" / "knockdesk-computer" / "tool.py"


class FakeHTTPError(Exception):
    """Stands in for httpx.HTTPError (including ReadTimeout)."""


class FakeTimeout:
    def __init__(self, *args: object, **kwargs: object) -> None:
        self.args = args
        self.kwargs = kwargs


class FakeResponse:
    def __init__(self, payload: dict | None = None, json_error: Exception | None = None) -> None:
        self.payload = payload
        self.json_error = json_error

    def json(self) -> dict:
        if self.json_error is not None:
            raise self.json_error
        return self.payload or {}


class _Harness:
    def __init__(self) -> None:
        self.run_payload: dict = {"ok": True, "taskId": "task-1"}
        self.wait_events: list[object] = []
        self.stop_calls: list[dict] = []
        self._previous_httpx: types.ModuleType | None = None

    def install(self) -> None:
        module = types.ModuleType("httpx")
        module.HTTPError = FakeHTTPError
        module.Timeout = FakeTimeout
        module.Client = FakeClient
        self._previous_httpx = sys.modules.get("httpx")
        sys.modules["httpx"] = module

    def uninstall(self) -> None:
        if self._previous_httpx is None:
            sys.modules.pop("httpx", None)
        else:
            sys.modules["httpx"] = self._previous_httpx


HARNESS = _Harness()


class FakeClient:
    def __init__(self, timeout: object = None, **kwargs: object) -> None:
        self.timeout = timeout
        self.kwargs = kwargs

    def __enter__(self) -> "FakeClient":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def post(self, url: str, **kwargs: object) -> FakeResponse:
        if url.endswith("/v1/computer/run"):
            return FakeResponse(HARNESS.run_payload)
        if url.endswith("/v1/computer/stop"):
            HARNESS.stop_calls.append({"url": url, **kwargs})
            return FakeResponse({"ok": True})
        raise AssertionError(f"unexpected POST: {url}")

    def get(self, url: str, **kwargs: object) -> FakeResponse:
        if not url.endswith("/v1/computer/wait"):
            raise AssertionError(f"unexpected GET: {url}")
        if not HARNESS.wait_events:
            raise AssertionError("plugin polled /v1/computer/wait more times than expected")
        event = HARNESS.wait_events.pop(0)
        if isinstance(event, Exception):
            raise event
        return event


def _load_tool() -> types.ModuleType:
    spec = importlib.util.spec_from_file_location("knockdesk_computer_tool", TOOL_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {TOOL_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TOOL = _load_tool()


def _done_payload() -> dict:
    return {
        "ok": True,
        "done": True,
        "result": {
            "status": "done",
            "steps": 7,
            "seconds": 42,
            "summary": "notepad opened",
        },
    }


class ComputerTaskCleanupTests(unittest.TestCase):
    def setUp(self) -> None:
        global HARNESS
        HARNESS = _Harness()
        HARNESS.install()
        self.addCleanup(HARNESS.uninstall)
        logging.disable(logging.CRITICAL)
        self.addCleanup(logging.disable, logging.NOTSET)
        env = patch.dict(
            os.environ,
            {
                "KNOCKDESK_BRIDGE_URL": "http://127.0.0.1:45678",
                "KNOCKDESK_BRIDGE_KEY": "test-key",
            },
            clear=False,
        )
        env.start()
        self.addCleanup(env.stop)

    def call(self) -> dict:
        return json.loads(TOOL.handle_computer_task({"task": "open notepad"}))

    def assert_stopped_once(self) -> None:
        self.assertEqual(len(HARNESS.stop_calls), 1, HARNESS.stop_calls)
        stop = HARNESS.stop_calls[0]
        self.assertTrue(stop["url"].endswith("/v1/computer/stop"))
        self.assertEqual(stop["headers"], {"Authorization": "Bearer test-key"})
        self.assertEqual(stop["json"], {"id": "task-1"})

    def test_finished_task_is_not_stopped(self) -> None:
        HARNESS.wait_events = [FakeResponse(_done_payload())]

        reply = self.call()

        self.assertTrue(reply["success"])
        self.assertEqual(reply["task_id"], "task-1")
        self.assertEqual(HARNESS.stop_calls, [])

    def test_wait_http_error_stops_the_running_task(self) -> None:
        HARNESS.wait_events = [FakeHTTPError("ReadTimeout")]

        reply = self.call()

        self.assertFalse(reply["success"])
        self.assertIn("unreachable", reply["error"])
        self.assert_stopped_once()

    def test_non_json_wait_response_stops_the_running_task(self) -> None:
        HARNESS.wait_events = [FakeResponse(json_error=ValueError("not json"))]

        reply = self.call()

        self.assertFalse(reply["success"])
        self.assert_stopped_once()

    def test_wait_ok_false_stops_the_running_task(self) -> None:
        HARNESS.wait_events = [FakeResponse({"ok": False, "error": "poll rejected"})]

        reply = self.call()

        self.assertFalse(reply["success"])
        self.assertEqual(reply["error"], "poll rejected")
        self.assert_stopped_once()

    def test_timeout_stops_the_running_task(self) -> None:
        with patch.object(TOOL, "MAX_WAIT_S", -1):
            reply = self.call()

        self.assertFalse(reply["success"])
        self.assertEqual(reply["status"], "timeout")
        self.assert_stopped_once()

    def test_busy_start_does_not_issue_a_stop(self) -> None:
        HARNESS.run_payload = {
            "ok": False,
            "error": "busy",
            "busyWith": {"task": "another task"},
        }

        reply = self.call()

        self.assertFalse(reply["success"])
        self.assertTrue(reply["busy"])
        self.assertEqual(HARNESS.stop_calls, [])


if __name__ == "__main__":
    unittest.main()
