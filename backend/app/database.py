"""SQLAlchemy engine, session factory and declarative base."""

from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings

engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    # Give the pool headroom that matches the request threadpool. Sync endpoints run in
    # a threadpool (default ~40 workers), so a small default pool (5+10) is exhausted
    # under bursty polling and requests then block for `pool_timeout` before erroring.
    pool_size=20,
    max_overflow=20,
    pool_timeout=10,
    pool_recycle=1800,
    future=True,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
