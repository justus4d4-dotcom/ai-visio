from __future__ import annotations

import asyncio
import datetime as dt
from typing import Self

import pytest

from app.routers import remote
from app.schemas import GeminiConfig, SolveResult


def _result() -> SolveResult:
    return SolveResult(
        question_text="Question?",
        question_type="single",
        answer_letters=["A"],
        answer_text="Correct",
        full_answer="Answer: A",
        confidence=0.9,
        model="gemini-test",
    )


def test_camera_trigger_is_solved_without_browser_poll(monkeypatch: pytest.MonkeyPatch) -> None:
    broadcasts: list[dict[str, object]] = []
    solve_calls: list[tuple[bytes, str]] = []

    async def broadcast(message: dict[str, object]) -> None:
        broadcasts.append(message)

    def solve_unattended(frame: bytes, user_key: str) -> SolveResult:
        solve_calls.append((frame, user_key))
        return _result()

    monkeypatch.setattr(remote.hub, "broadcast", broadcast)
    monkeypatch.setattr(remote, "_solve_unattended", solve_unattended)
    remote._capture.update(source="camera", user_key="owner@example.com")
    remote._camera.update(
        frame=b"camera-frame",
        frame_at=dt.datetime.now(dt.UTC),
        frame_ct="image/jpeg",
    )
    remote._state.update(
        status="idle",
        pending=False,
        answer=None,
        answer_id=None,
        scenario_count=0,
    )

    async def run() -> None:
        remote._request("solve")
        tasks = tuple(remote._solve_tasks)
        assert tasks
        await asyncio.gather(*tasks)

    asyncio.run(run())

    assert remote.poll().triggered is False
    assert solve_calls == [(b"camera-frame", "owner@example.com")]
    assert remote._state["status"] == "done"
    assert [message["type"] for message in broadcasts] == ["status", "answer"]


def test_stale_camera_frame_reports_error(monkeypatch: pytest.MonkeyPatch) -> None:
    broadcasts: list[dict[str, object]] = []

    async def broadcast(message: dict[str, object]) -> None:
        broadcasts.append(message)

    monkeypatch.setattr(remote.hub, "broadcast", broadcast)
    remote._capture.update(source="camera", user_key="owner@example.com")
    remote._camera.update(
        frame=b"stale",
        frame_at=dt.datetime.now(dt.UTC) - remote.CAMERA_STALE_WINDOW,
    )
    remote._state.update(status="idle", pending=False)

    trigger = remote._backend_trigger("trigger-1")
    remote._state["trigger_id"] = trigger.id
    asyncio.run(remote._process_backend_trigger(trigger))

    assert remote._state["status"] == "error"
    assert broadcasts[-1]["detail"] == "No fresh camera frame is available."


def test_missing_cloud_provider_configuration_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeSession:
        def __enter__(self) -> Self:
            return self

        def __exit__(self, *args: object) -> None:
            return None

    monkeypatch.setattr(remote, "SessionLocal", FakeSession)
    monkeypatch.setattr(remote.settings_store, "get_settings", lambda db, key: {})

    with pytest.raises(RuntimeError, match="cloud-synced Gemini"):
        remote._load_provider_config("owner@example.com")


def test_valid_cloud_provider_configuration_is_loaded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeSession:
        def __enter__(self) -> Self:
            return self

        def __exit__(self, *args: object) -> None:
            return None

    monkeypatch.setattr(remote, "SessionLocal", FakeSession)
    monkeypatch.setattr(
        remote.settings_store,
        "get_settings",
        lambda db, key: {"provider": {"api_key": "secret", "model": "gemini-test"}},
    )

    assert remote._load_provider_config("owner@example.com") == GeminiConfig(
        api_key="secret", model="gemini-test"
    )


def test_browser_trigger_remains_available_to_browser_poll() -> None:
    remote._capture["source"] = "browser"
    remote._state.update(status="idle", pending=False, scenario_count=0)

    trigger_id = remote._request("solve")
    result = remote.poll()

    assert result.triggered is True
    assert result.trigger_id == trigger_id


def test_case_study_solve_remains_available_to_browser_poll() -> None:
    remote._capture["source"] = "camera"
    remote._state.update(status="idle", pending=False, scenario_count=2)

    trigger_id = remote._request("solve")
    result = remote.poll()

    assert result.triggered is True
    assert result.trigger_id == trigger_id


def test_trigger_snapshots_owner_and_ignores_stale_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    solve_calls: list[str] = []
    broadcasts: list[dict[str, object]] = []

    async def broadcast(message: dict[str, object]) -> None:
        broadcasts.append(message)

    def solve_unattended(frame: bytes, user_key: str) -> SolveResult:
        solve_calls.append(user_key)
        remote._state["trigger_id"] = "newer-trigger"
        return _result()

    monkeypatch.setattr(remote.hub, "broadcast", broadcast)
    monkeypatch.setattr(remote, "_solve_unattended", solve_unattended)
    remote._capture.update(source="camera", user_key="first@example.com")
    remote._camera.update(
        frame=b"camera-frame",
        frame_at=dt.datetime.now(dt.UTC),
    )
    trigger = remote._backend_trigger("older-trigger")
    remote._capture["user_key"] = "second@example.com"
    remote._state.update(trigger_id=trigger.id, status="requested", answer=None)

    asyncio.run(remote._process_backend_trigger(trigger))

    assert solve_calls == ["first@example.com"]
    assert remote._state["answer"] is None
    assert [message["type"] for message in broadcasts] == ["status"]
