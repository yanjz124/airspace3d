"""Spherical geodesy helpers (NM / degrees). Accuracy is well inside chart precision."""
from __future__ import annotations

import math

R_NM = 3440.065


def bearing(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def distance(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_NM * math.asin(min(1.0, math.sqrt(a)))


def destination(lat, lon, brg, dist_nm) -> tuple[float, float]:
    d = dist_nm / R_NM
    p1, l1, t = math.radians(lat), math.radians(lon), math.radians(brg)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(t))
    l2 = l1 + math.atan2(math.sin(t) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), (math.degrees(l2) + 540) % 360 - 180


def arc(center, start, end, turn: str, radius_nm: float | None = None, step_deg: float = 3.0):
    """Points along an arc around `center` from `start` to `end` (lat, lon tuples).

    turn: 'L' (counter-clockwise) or 'R' (clockwise). Radius defaults to the
    start point's distance from center; the end point is appended exactly.
    """
    b0 = bearing(*center, *start)
    b1 = bearing(*center, *end)
    r = radius_nm if radius_nm else distance(*center, *start)
    if turn == "R":
        sweep = (b1 - b0) % 360
        sign = 1
    else:
        sweep = (b0 - b1) % 360
        sign = -1
    n = max(2, int(sweep / step_deg))
    pts = [start]
    for i in range(1, n):
        pts.append(destination(*center, b0 + sign * sweep * i / n, r))
    pts.append(end)
    return pts
