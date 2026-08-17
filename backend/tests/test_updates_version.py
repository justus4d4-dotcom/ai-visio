from __future__ import annotations

from app import updates


def test_current_version_uses_highest_exact_tag(monkeypatch) -> None:
    def run_git(*args: str) -> str | None:
        if args[0] == "tag":
            return "v0.22.4\nv0.22.3"
        if args[0] == "status":
            return None
        raise AssertionError(args)

    monkeypatch.setattr(updates, "_run_git", run_git)

    assert updates.current_version() == "v0.22.4"


def test_current_version_marks_real_source_changes_dirty(monkeypatch) -> None:
    def run_git(*args: str) -> str | None:
        if args[0] == "tag":
            return "v0.22.4"
        if args[0] == "status":
            assert ":(exclude)frontend/next-env.d.ts" in args
            return " M backend/app/main.py"
        raise AssertionError(args)

    monkeypatch.setattr(updates, "_run_git", run_git)

    assert updates.current_version() == "v0.22.4-dirty"


def test_current_version_falls_back_to_described_commit(monkeypatch) -> None:
    def run_git(*args: str) -> str | None:
        if args[0] == "tag":
            return None
        if args[0] == "describe":
            return "abc1234"
        if args[0] == "status":
            return None
        raise AssertionError(args)

    monkeypatch.setattr(updates, "_run_git", run_git)

    assert updates.current_version() == "abc1234"
