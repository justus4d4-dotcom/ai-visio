"""Gemini token pricing + cost estimation (USD).

Prices are per 1,000,000 tokens and are approximate public list prices for the
paid tier; they are used only to give the user a rough running-cost estimate in the
monitoring dashboard. Update the table if Google changes pricing. Unknown models fall
back to ``_DEFAULT`` so a cost is always produced.
"""

from __future__ import annotations

# (input_per_1m_usd, output_per_1m_usd)
_PRICES: dict[str, tuple[float, float]] = {
    "gemini-2.5-flash-lite": (0.10, 0.40),
    "gemini-2.5-flash": (0.30, 2.50),
    "gemini-2.5-pro": (1.25, 10.00),
    "gemini-2.0-flash-lite": (0.075, 0.30),
    "gemini-2.0-flash": (0.10, 0.40),
    "gemini-1.5-flash": (0.075, 0.30),
    "gemini-1.5-flash-8b": (0.0375, 0.15),
    "gemini-1.5-pro": (1.25, 5.00),
}

# Used when the model id is not in the table (e.g. a newly released model).
_DEFAULT = (0.10, 0.40)


def price_for(model: str) -> tuple[float, float]:
    """Return (input_per_1m, output_per_1m) for ``model`` (case/prefix tolerant)."""
    key = (model or "").replace("models/", "").strip().lower()
    if key in _PRICES:
        return _PRICES[key]
    # Tolerate suffixes like "-001" / "-preview-xx" by matching the longest known prefix.
    best: tuple[float, float] | None = None
    best_len = -1
    for name, price in _PRICES.items():
        if key.startswith(name) and len(name) > best_len:
            best, best_len = price, len(name)
    return best if best is not None else _DEFAULT


def estimate_cost(model: str, prompt_tokens: int | None, output_tokens: int | None) -> float:
    """Estimate the USD cost of a single call from its token counts."""
    in_rate, out_rate = price_for(model)
    p = prompt_tokens or 0
    o = output_tokens or 0
    return (p / 1_000_000) * in_rate + (o / 1_000_000) * out_rate
