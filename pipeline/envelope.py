"""Legal altitude band along each drawn leg, derived only from published restrictions.

Arrivals and approaches only descend; departures and missed approaches only
climb. Under that rule a restriction bounds every point on one side of it:

    descending: ceiling(s) = min ceiling of restrictions at or before s
                floor(s)   = max floor of restrictions at or after s
    climbing:   floor(s)   = max floor of restrictions at or before s
                ceiling(s) = min ceiling of restrictions at or after s

Within a leg (between its start and end fix) the band is therefore constant.
No descent/climb gradient is assumed. Where nothing bounds a side, it is None
(open). A transition can belong to several routes (e.g. a common route after
each enroute transition); its band is the union over those routes.
"""
from __future__ import annotations

from itertools import product

ORDER = {
    "SID": ["runway", "common", "enroute"],
    "STAR": ["enroute", "common", "runway"],
    "IAP": ["approach", "final"],
}
CLIMBING = {"SID"}


def _band(cons, k, climbing):
    """cons: list of (position, floor, ceiling); band for the leg ending at position k."""
    before = [c for c in cons if c[0] < k]
    after = [c for c in cons if c[0] >= k]
    if climbing:
        floors = [c[1] for c in before if c[1] is not None]
        ceils = [c[2] for c in after if c[2] is not None]
    else:
        ceils = [c[2] for c in before if c[2] is not None]
        floors = [c[1] for c in after if c[1] is not None]
    lo = max(floors) if floors else None
    hi = min(ceils) if ceils else None
    return lo, hi


def _union(a, b):
    if a is None:
        return b
    lo = None if a[0] is None or b[0] is None else min(a[0], b[0])
    hi = None if a[1] is None or b[1] is None else max(a[1], b[1])
    return lo, hi


def _routes(proc):
    ts = proc["transitions"]
    groups = [[i for i, t in enumerate(ts) if t["kind"] == kind] for kind in ORDER[proc["type"]]]
    groups = [g for g in groups if g]
    return list(product(*groups)) if groups else []


def apply(proc: dict) -> None:
    ts = proc["transitions"]
    bands: dict[tuple[int, int], tuple | None] = {}

    def run(route, climbing):
        cons, offsets, off = [], {}, 0
        for ti in route:
            offsets[ti] = off
            cons += [(off + k, lo, hi) for k, lo, hi in ts[ti]["_cons"]]
            off += 1000  # legs per transition are far fewer
        for ti in route:
            for pi, piece in enumerate(ts[ti]["_pieces"]):
                b = _band(cons, offsets[ti] + piece["k"], climbing)
                bands[(ti, pi)] = _union(bands.get((ti, pi)), b)

    for route in _routes(proc):
        run(route, proc["type"] in CLIMBING)
    for ti, t in enumerate(ts):
        if t["kind"] == "missed":
            run((ti,), True)

    for ti, t in enumerate(ts):
        segs = []
        for pi, piece in enumerate(t["_pieces"]):
            lo, hi = bands.get((ti, pi)) or (None, None)
            seg = {"path": piece["path"], "lo": lo, "hi": hi}
            for key in ("rnp", "rnpSrc", "glide"):
                if key in piece:
                    seg[key] = piece[key]
            segs.append(seg)
        t["segments"] = segs
        del t["_pieces"], t["_cons"]
