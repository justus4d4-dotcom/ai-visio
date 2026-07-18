"""Application configuration loaded from environment variables."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://postgres:aiexams@localhost:5432/aiexams"
    auth_secret: str = "change-me"
    encryption_key: str = "change-me"
    bootstrap_admins: str = ""
    frontend_origins: str = "http://localhost:3000"

    ocr_lang: str = "eng"
    frame_diff_threshold: int = 8

    # ── Request-log retention (Feature 2) ───────────────────────────────────────
    # Every solve (success or failure, with its image) is logged to the answers table.
    # To bound storage the log is auto-pruned after each write: rows older than
    # history_retention_days OR beyond history_max_rows (most recent kept) are deleted.
    history_retention_days: int = 30
    history_max_rows: int = 2000

    # ── Google sign-in (protects the public deployment) ─────────────────────────
    # Google OAuth 2.0 web client. When BOTH id and secret are set, every /api route
    # (except the auth handshake + health) requires a signed-in, allowed Google account.
    # Left empty (local dev) the app stays open. Secrets come from backend/.env.
    google_client_id: str = ""
    google_client_secret: str = ""
    # Public HTTPS origin the browser reaches, used to build the OAuth redirect URI as
    # "<public_base_url>/api/auth/callback" (must be registered in the Google console).
    public_base_url: str = ""
    # Comma-separated allowlist of Google emails permitted to sign in. Empty = allow any
    # Google account that completes login (less strict — set this to lock the demo down).
    allowed_emails: str = ""
    # Shared secret for non-browser clients (native agent, ESP32) that can't do OAuth.
    # Sent as the "X-Device-Token" header (or "?token="); bypasses the session check.
    device_token: str = ""
    # Session cookie lifetime (seconds); default 12h.
    session_ttl_seconds: int = 43200

    # ── Self-update (used by the "Update" section in the frontend settings) ──────
    # GitHub repo the deployment tracks, as "owner/name".
    github_repo: str = "justus4d4-dotcom/ai-visio"
    # Read-only token used for the GitHub Releases API and to pull code on a private
    # repo. A fine-grained PAT with read-only "Contents" access is enough. Optional
    # for public repos. Supplied via the GITHUB_TOKEN env var / backend .env (mode
    # 0600); never hardcode a real token here and never send it to clients.
    github_token: str = ""
    # Root of the checked-out deployment and the privileged update script + its log.
    app_dir: str = "/opt/ai-visio"
    update_script: str = "/opt/ai-visio/deploy/update.sh"
    update_log: str = "/opt/ai-visio/update.log"
    # Master switch: when false, POST /api/updates/apply is refused (e.g. in dev).
    update_enabled: bool = True

    @property
    def admin_emails(self) -> set[str]:
        return {e.strip().lower() for e in self.bootstrap_admins.split(",") if e.strip()}

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.frontend_origins.split(",") if o.strip()]

    @property
    def allowed_email_set(self) -> set[str]:
        return {e.strip().lower() for e in self.allowed_emails.split(",") if e.strip()}

    @property
    def auth_configured(self) -> bool:
        """True when Google sign-in is fully configured and should be enforced."""
        return bool(self.google_client_id and self.google_client_secret)


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
