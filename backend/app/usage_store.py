"""Usage / cost monitoring persistence + aggregation.

Every solve (cache hit or real API call) is recorded as a ``UsageEvent`` so the
monitoring dashboard can show running token usage and an estimated spend, plus how
much the dedup cache saved.
"""

from __future__ import annotations

import datetime as dt

from sqlalchemy import Integer, func, select
from sqlalchemy.orm import Session

from app import models
from app.schemas import (
    SolveResult,
    UsageDayPoint,
    UsageModelPoint,
    UsageSummary,
    UsageTotals,
)


def record_usage(db: Session, result: SolveResult) -> None:
    """Persist one metered call. Best-effort: callers should not fail a solve on error."""
    db.add(
        models.UsageEvent(
            model=result.model,
            prompt_tokens=result.prompt_tokens or 0,
            output_tokens=result.output_tokens or 0,
            total_tokens=result.tokens_used or 0,
            cost_usd=result.cost_usd or 0.0,
            cached=bool(result.cached),
            elapsed_ms=result.elapsed_ms,
        )
    )
    db.commit()


def _totals(db: Session, since: dt.datetime | None) -> UsageTotals:
    q = select(
        func.count(models.UsageEvent.id),
        func.coalesce(func.sum(models.UsageEvent.prompt_tokens), 0),
        func.coalesce(func.sum(models.UsageEvent.output_tokens), 0),
        func.coalesce(func.sum(models.UsageEvent.total_tokens), 0),
        func.coalesce(func.sum(models.UsageEvent.cost_usd), 0.0),
        func.coalesce(func.sum(func.cast(models.UsageEvent.cached, Integer)), 0),
    )
    if since is not None:
        q = q.where(models.UsageEvent.created_at >= since)
    calls, p, o, t, cost, cached = db.execute(q).one()
    cached = int(cached or 0)
    return UsageTotals(
        calls=int(calls or 0),
        billable_calls=int(calls or 0) - cached,
        cached_calls=cached,
        prompt_tokens=int(p or 0),
        output_tokens=int(o or 0),
        total_tokens=int(t or 0),
        cost_usd=round(float(cost or 0.0), 6),
    )


def get_summary(db: Session) -> UsageSummary:
    now = dt.datetime.now(dt.timezone.utc)
    start_today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    start_week = now - dt.timedelta(days=7)
    start_month = now - dt.timedelta(days=30)

    # Per-day breakdown (last 30 days), most recent first.
    day_expr = func.date(models.UsageEvent.created_at)
    day_rows = db.execute(
        select(
            day_expr,
            func.count(models.UsageEvent.id),
            func.coalesce(func.sum(models.UsageEvent.total_tokens), 0),
            func.coalesce(func.sum(models.UsageEvent.cost_usd), 0.0),
        )
        .where(models.UsageEvent.created_at >= start_month)
        .group_by(day_expr)
        .order_by(day_expr.desc())
    ).all()
    daily = [
        UsageDayPoint(
            day=str(d), calls=int(c or 0), total_tokens=int(tok or 0), cost_usd=round(float(cost or 0.0), 6)
        )
        for d, c, tok, cost in day_rows
    ]

    # Per-model breakdown (all time), highest cost first.
    model_rows = db.execute(
        select(
            models.UsageEvent.model,
            func.count(models.UsageEvent.id),
            func.coalesce(func.sum(models.UsageEvent.total_tokens), 0),
            func.coalesce(func.sum(models.UsageEvent.cost_usd), 0.0),
        )
        .group_by(models.UsageEvent.model)
        .order_by(func.coalesce(func.sum(models.UsageEvent.cost_usd), 0.0).desc())
    ).all()
    by_model = [
        UsageModelPoint(
            model=m or "unknown",
            calls=int(c or 0),
            total_tokens=int(tok or 0),
            cost_usd=round(float(cost or 0.0), 6),
        )
        for m, c, tok, cost in model_rows
    ]

    return UsageSummary(
        today=_totals(db, start_today),
        last_7_days=_totals(db, start_week),
        all_time=_totals(db, None),
        daily=daily,
        by_model=by_model,
    )
