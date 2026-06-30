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
