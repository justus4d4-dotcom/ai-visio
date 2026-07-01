"""Self-update helpers: version detection, GitHub Releases, and triggering updates.

The frontend "Update" section calls the router in ``app/routers/updates.py`` which
delegates here. Design notes:

* **Version detection** reads the git checkout in ``settings.app_dir`` (the release
  tag it is on, via ``git describe``). Falls back to the FastAPI app version.
* **Release list / notes / history** come from the GitHub Releases API (each release
  carries ``tag_name``, ``name``, ``body`` markdown, ``published_at`` and ``html_url``).
* **Applying an update** runs the privileged ``deploy/update.sh`` detached (via
  ``sudo`` + ``setsid``) so it survives the backend restart the script performs. The
  target ref is validated against the known release tags to avoid command injection,
  and progress is streamed to ``settings.update_log`` which the UI polls.
"""

from __future__ import annotations

import os
import re
import subprocess
import time
from pathlib import Path

import httpx

from app.config import settings
from app.schemas import ReleaseInfo, UpdateProgress, UpdateStatus

# Sentinels the update script writes so we can report progress state without a DB.
_MARKER_DONE = "AI-VISIO-UPDATE: SUCCESS"
_MARKER_FAIL = "AI-VISIO-UPDATE: FAILED"
_MARKER_START = "AI-VISIO-UPDATE: START"

# If a "running" update log hasn't been written to for this long, assume the updater
# died without a terminal marker and report it as failed (so the UI stops spinning).
_UPDATE_STALE_SECS = 600

# A conservative allowlist for a git ref we are willing to hand to the update script.
# Matches release tags/branches like "v1.2.3", "release/1.2.3", "1.2.3-rc.1".
_REF_RE = re.compile(r"^[A-Za-z0-9._/-]{1,100}$")

_GITHUB_API = "https://api.github.com"


def _run_git(*args: str) -> str | None:
    """Run a git command inside the deployment checkout; return stdout or None."""
    repo = Path(settings.app_dir)
    if not (repo / ".git").exists():
        return None
    try:
        out = subprocess.run(  # noqa: S603 - fixed argv, no shell
            ["git", "-C", str(repo), *args],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    return out.stdout.strip() or None


def current_version() -> str:
    """The release/ref the deployment is currently on.

    Prefers the nearest tag (``git describe``); falls back to the short commit, then
    to the packaged app version so the UI always has something to show in dev.
    """
    described = _run_git("describe", "--tags", "--always", "--dirty")
    if described:
        return described
    from app.main import app  # local import to avoid a cycle at module load

    return app.version


def _github_headers() -> dict[str, str]:
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if settings.github_token:
        headers["Authorization"] = f"Bearer {settings.github_token}"
    return headers


def list_releases(limit: int = 20) -> list[ReleaseInfo]:
    """Fetch published releases (newest first) from the GitHub Releases API.

    Raises ``httpx.HTTPError`` on network/API failure so the caller can surface a
    friendly message while still returning the locally-known current version.
    """
    url = f"{_GITHUB_API}/repos/{settings.github_repo}/releases"
    with httpx.Client(timeout=10) as client:
        resp = client.get(url, headers=_github_headers(), params={"per_page": limit})
        resp.raise_for_status()
        data = resp.json()

    releases: list[ReleaseInfo] = []
    for item in data:
        if item.get("draft"):
            continue
        releases.append(
            ReleaseInfo(
                tag=item["tag_name"],
                name=item.get("name") or item["tag_name"],
                notes=item.get("body"),
                published_at=item.get("published_at"),
                url=item.get("html_url"),
                prerelease=bool(item.get("prerelease")),
            )
        )
    return releases


def _progress_state() -> tuple[str, str | None, str]:
    """Read the update log and derive (state, target, log_text)."""
    log_path = Path(settings.update_log)
    if not log_path.exists():
        return "idle", None, ""
    try:
        text = log_path.read_text(errors="replace")
    except OSError:
        return "idle", None, ""

    target: str | None = None
    for line in text.splitlines():
        if line.startswith(_MARKER_START):
            target = line.split(_MARKER_START, 1)[1].strip(" :") or None

    if _MARKER_DONE in text:
        state = "success"
    elif _MARKER_FAIL in text:
        state = "failed"
    else:
        state = "running"
        # Safety net: if the updater died without a terminal marker (SIGKILL/OOM, or a
        # process killed by a service restart), the log stops growing. Treat a long-idle
        # "running" log as a timed-out failure so the UI never spins forever.
        try:
            idle = time.time() - log_path.stat().st_mtime
        except OSError:
            idle = 0.0
        if idle > _UPDATE_STALE_SECS:
            state = "failed"
            text += (
                f"\n[updater timed out: no progress for {int(idle)}s — check "
                "/opt/ai-visio/update.log and `journalctl -u ai-visio-update-*`]"
            )
    # Only keep the tail so we never ship a huge payload to the browser.
    tail = "\n".join(text.splitlines()[-200:])
    return state, target, tail


def progress() -> UpdateProgress:
    state, target, log = _progress_state()
    return UpdateProgress(state=state, target=target, log=log)  # type: ignore[arg-type]


def is_in_progress() -> bool:
    return _progress_state()[0] == "running"


def _friendly_api_error(exc: httpx.HTTPError) -> str:
    """Turn a raw httpx error into an actionable message for the Update panel."""
    repo = settings.github_repo
    has_token = bool(settings.github_token)
    status = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else None

    if status in (401, 403):
        return (
            f"GitHub rejected the token while reading releases for {repo} "
            f"(HTTP {status}). Set a valid GITHUB_TOKEN in the backend .env with "
            "Contents:read access, and authorize it for the organization's SSO."
        )
    if status == 404:
        if not has_token:
            return (
                f"{repo} is private, so listing releases needs credentials. Set "
                "GITHUB_TOKEN in the backend .env (fine-grained PAT with Contents:read, "
                "or a classic PAT with the 'repo' scope) and restart the backend."
            )
        return (
            f"GitHub returned 404 for {repo}. The token can't see this repo — check "
            "the repository name, that the token has Contents:read access to it, and "
            "that the token is authorized for the organization's SAML SSO."
        )
    if status is not None:
        return f"GitHub Releases API error for {repo} (HTTP {status})."
    return f"Could not reach the GitHub Releases API: {exc}"


def get_status() -> UpdateStatus:
    """Assemble the full status the Update section renders."""
    current = current_version()
    can_apply = settings.update_enabled and Path(settings.update_script).exists()

    releases: list[ReleaseInfo] = []
    detail: str | None = None
    latest: str | None = None
    try:
        releases = list_releases()
        # First non-prerelease is the "latest"; fall back to the newest entry.
        stable = next((r for r in releases if not r.prerelease), None)
        latest = (stable or (releases[0] if releases else None)).tag if releases else None
        if not releases:
            detail = (
                f"No releases have been published for {settings.github_repo} yet. "
                "Create a GitHub Release (with a version tag) to enable updates."
            )
    except httpx.HTTPError as exc:
        detail = _friendly_api_error(exc)

    update_available = bool(latest) and _normalize(latest) != _normalize(current)

    return UpdateStatus(
        current_version=current,
        latest_version=latest,
        update_available=update_available,
        releases=releases,
        repo=settings.github_repo,
        can_apply=can_apply,
        in_progress=is_in_progress(),
        detail=detail,
    )


def _normalize(ref: str | None) -> str:
    """Loose comparison so ``v1.2.3`` and ``1.2.3`` match."""
    if not ref:
        return ""
    return ref.strip().lstrip("vV").split("-dirty")[0]


class UpdateError(RuntimeError):
    """Raised when an update cannot be started (bad ref, disabled, missing script)."""


def _mark_launch_failed(log_path: Path, message: str) -> None:
    """Write a FAILED marker so the UI shows the failure instead of spinning on 'running'."""
    try:
        with log_path.open("a") as fh:
            fh.write(f"{_MARKER_START} (launch)\n[update] {message}\n{_MARKER_FAIL}\n")
    except OSError:
        pass


def apply_update(target: str | None) -> str:
    """Validate the target ref and launch the detached update script.

    Returns the resolved target ref. Raises ``UpdateError`` for any refusal.
    """
    if not settings.update_enabled:
        raise UpdateError("Updates are disabled on this server (UPDATE_ENABLED=false).")

    script = Path(settings.update_script)
    if not script.exists():
        raise UpdateError(f"Update script not found at {script}.")

    if is_in_progress():
        raise UpdateError("An update is already running.")

    # Resolve + validate the target against the known release tags. Never trust the
    # raw client value as a shell/git argument beyond the strict allowlist.
    try:
        releases = list_releases()
    except httpx.HTTPError as exc:
        raise UpdateError(f"Could not list releases to validate the target: {exc}") from exc

    tags = {r.tag for r in releases}
    if target is None:
        stable = next((r for r in releases if not r.prerelease), None)
        chosen = stable or (releases[0] if releases else None)
        if chosen is None:
            raise UpdateError("No published releases found to update to.")
        target = chosen.tag
    elif target not in tags:
        raise UpdateError(f"Unknown release '{target}'.")

    if not _REF_RE.match(target):
        raise UpdateError("Target ref contains disallowed characters.")

    # Reset the log so progress polling reflects only this run.
    log_path = Path(settings.update_log)
    try:
        log_path.write_text("")
    except OSError:
        pass  # the script itself will (re)create it

    # Launch detached and privileged. update.sh re-execs itself via systemd-run, so the
    # `sudo` process exits ~immediately on success; if sudo is not permitted (missing
    # sudoers rule) it exits non-zero right away. Wait briefly to tell these apart so a
    # denied launch surfaces a clear error instead of a UI that spins forever.
    env = dict(os.environ)
    if settings.github_token:
        env["GITHUB_TOKEN"] = settings.github_token
    try:
        proc = subprocess.Popen(  # noqa: S603 - fixed argv, validated ref
            ["sudo", "-n", str(script), target],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
            env=env,
        )
    except OSError as exc:
        _mark_launch_failed(log_path, f"Failed to launch update script: {exc}")
        raise UpdateError(f"Failed to launch update script: {exc}") from exc

    try:
        _, stderr = proc.communicate(timeout=3)
    except subprocess.TimeoutExpired:
        # Still running (e.g. an update.sh without the systemd-run self-detach runs the
        # whole update inline) — that's a successful launch.
        return target
    if proc.returncode:
        tail = (stderr or b"").decode(errors="replace").strip().splitlines()
        reason = tail[-1] if tail else ""
        detail = (
            f"The updater could not be started (exit {proc.returncode})."
            + (f" {reason}" if reason else "")
            + " This is usually a missing sudoers rule — add "
            "'aivisio ALL=(root) NOPASSWD: /opt/ai-visio/deploy/update.sh' to "
            "/etc/sudoers.d/ai-visio-update (mode 0440)."
        )
        _mark_launch_failed(log_path, detail)
        raise UpdateError(detail)

    return target
