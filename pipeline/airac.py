"""AIRAC cycle arithmetic and FAA download URLs."""
from __future__ import annotations

import datetime as dt

EPOCH = dt.date(2026, 1, 22)  # AIRAC 2601


def current_cycle(today: dt.date | None = None) -> dt.date:
    today = today or dt.date.today()
    n = (today - EPOCH).days // 28
    return EPOCH + dt.timedelta(days=28 * n)


def cycle_ident(eff: dt.date) -> str:
    """AIRAC ident like '2610'."""
    first = current_cycle(dt.date(eff.year, 1, 1))
    if first.year < eff.year:
        first += dt.timedelta(days=28)
    return f"{eff.year % 100:02d}{(eff - first).days // 28 + 1:02d}"


def cifp_url(eff: dt.date) -> str:
    return f"https://aeronav.faa.gov/Upload_313-d/cifp/CIFP_{eff:%y%m%d}.zip"
