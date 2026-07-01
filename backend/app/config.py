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


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
