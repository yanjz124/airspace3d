"""Turn CIFP procedure records into display-ready transitions.

Rule: only geometry and restrictions that the procedure itself defines are
emitted. Legs whose end point depends on aircraft performance or ATC
(heading/course-to-altitude, vectors, intercepts, DME terminations) break the
drawn track and are kept only as text notes.
"""
from __future__ import annotations

import math

from . import envelope, geo
from .arinc424 import CIFP, Leg, ProcRecord

SUBSECTION_TYPE = {"D": "SID", "E": "STAR", "F": "IAP"}

SID_KIND = {
    "0": None,  # engine-out: not shown
    "1": "runway", "4": "runway", "F": "runway", "T": "runway",
    "2": "common", "5": "common", "M": "common",
    "3": "enroute", "6": "enroute", "S": "enroute", "V": "enroute",
}
STAR_KIND = {
    "1": "enroute", "4": "enroute", "7": "enroute", "F": "enroute",
    "2": "common", "5": "common", "8": "common", "M": "common",
    "3": "runway", "6": "runway", "9": "runway", "S": "runway",
}
IAP_TYPE = {
    "B": "LOC/BC", "D": "VOR/DME", "F": "FMS", "G": "IGS", "H": "RNP", "I": "ILS",
    "J": "GLS", "L": "LOC", "N": "NDB", "P": "GPS", "Q": "NDB/DME", "R": "RNAV",
    "S": "VOR", "T": "TACAN", "U": "SDF", "V": "VOR", "W": "MLS", "X": "LDA",
}

# RNAV SID/STAR route types. FAA charts these as RNAV 1, but CIFP leaves the
# per-leg RNP field blank, so that value is tagged "spec" rather than "coded".
RNAV_ROUTE_TYPES = {"SID": set("456FMS"), "STAR": set("456FMS")}
RNAV1_NM = 1.0

# Legs that end at a published fix and whose path from the previous known
# position is defined by the leg type.
TO_FIX = {"IF", "TF", "CF", "DF", "RF", "AF"}
HOLDS = {"HA", "HF", "HM"}
# Legs with no published end position.
OPEN_ENDED = {"CA", "VA", "FA", "VM", "FM", "VI", "CI", "VR", "CR", "VD", "CD", "FD"}

# Waypoint description code, column 43
FIX_ROLE = {
    "A": "IAF", "B": "IF", "C": "IAF", "D": "IAF", "I": "FACF",
    "F": "FAF", "H": "HOLD", "M": "MAP",
}

PT_TEXT = {
    "CA": "course {crs} until {alt}", "VA": "heading {crs} until {alt}",
    "FA": "from {fix} course {crs} until {alt}", "VM": "heading {crs}, expect vectors",
    "FM": "from {fix} course {crs}, expect vectors", "VI": "heading {crs} to intercept",
    "CI": "course {crs} to intercept", "VR": "heading {crs} to radial {theta} {nav}",
    "CR": "course {crs} to radial {theta} {nav}", "VD": "heading {crs} to {rho} DME {nav}",
    "CD": "course {crs} to {rho} DME {nav}", "FD": "from {fix} course {crs} to {rho} DME {nav}",
    "PI": "procedure turn at {fix}",
}


def alt_restriction(leg: Leg) -> dict | None:
    """Map an ARINC altitude description to a restriction window (feet MSL)."""
    d, a1, a2 = leg.alt_desc, leg.alt1, leg.alt2
    if a1 is None and a2 is None:
        return None
    if d in ("+", "H", "J", "V"):
        r = {"k": "above", "lo": a1}
    elif d in ("-", "Y"):
        r = {"k": "below", "hi": a1}
    elif d == "B":
        r = {"k": "between", "lo": a2, "hi": a1}
    elif d == "C":
        r = {"k": "above", "lo": a2}
    elif d in (" ", "@", "G", "I", "X"):
        r = {"k": "at", "lo": a1, "hi": a1}
    else:
        return None
    if d in ("G", "H", "I", "J") and a2 is not None:
        r["gs"] = a2  # glideslope (intercept) altitude, informational
    r["code"] = d.strip() or "@"
    return r


def speed_restriction(leg: Leg) -> dict | None:
    if not leg.speed:
        return None
    k = {"+": "above", "-": "below"}.get(leg.speed_desc, "at")
    return {"k": k, "kt": int(leg.speed)}


def fmt_alt(r: dict | None) -> str:
    if not r:
        return "?"
    if r["k"] == "above":
        return f"{r['lo']}+"
    if r["k"] == "below":
        return f"{r['hi']}-"
    if r["k"] == "between":
        return f"{r['lo']}-{r['hi']}"
    return f"{r['lo']}"


def glide_profile(path: list[list[float]], end_ft: int, vpa_deg: float) -> list[list[float]]:
    """Altitude along a leg flown on a published vertical path angle, ending at `end_ft`."""
    tan = math.tan(math.radians(abs(vpa_deg)))
    out, remaining = [], 0.0
    for i in range(len(path) - 1, -1, -1):
        if i < len(path) - 1:
            (lon1, lat1), (lon2, lat2) = path[i], path[i + 1]
            remaining += geo.distance(lat1, lon1, lat2, lon2)
        out.append([path[i][0], path[i][1], round(end_ft + tan * remaining * 6076.12)])
    return out[::-1]


class Builder:
    def __init__(self, cifp: CIFP):
        self.c = cifp

    def _true(self, airport: str, course: float | None, is_true: bool) -> float | None:
        if course is None:
            return None
        if is_true:
            return course
        mv = self.c.airports[airport].magvar or 0.0
        return (course + mv) % 360

    def build_transition(self, rec: ProcRecord, legs: list[Leg], from_first_fix: bool = False) -> dict:
        """from_first_fix: treat the first leg as a starting position only (missed approach at the MAP)."""
        apt = rec.airport
        paths: list[list[list[float]]] = []
        cur: list[list[float]] = []
        points: list[dict] = []
        notes: list[dict] = []
        pos: tuple[float, float] | None = None
        unresolved: list[str] = []
        corridors: list[dict] = []
        pieces: list[dict] = []  # drawn geometry per leg, for the 3D envelope
        cons: list[tuple[int, int | None, int | None]] = []  # (leg index, floor, ceiling)
        ptype = SUBSECTION_TYPE[rec.subsection]
        rnav_spec = rec.route_type in RNAV_ROUTE_TYPES.get(ptype, set())

        def pen_up():
            nonlocal cur
            if len(cur) >= 2:
                paths.append(cur)
            cur = []

        def line_to(pts):
            nonlocal cur
            for lat, lon in pts:
                p = [round(lon, 6), round(lat, 6)]
                if not cur or cur[-1] != p:
                    cur.append(p)

        for k, leg in enumerate(legs):
            pt = leg.pt
            fixp = self.c.resolve(apt, leg.fix, leg.fix_icao, leg.fix_sec) if leg.fix else None
            if leg.fix and fixp is None:
                unresolved.append(leg.fix)
            fixll = (fixp.lat, fixp.lon) if fixp else None
            alt = alt_restriction(leg)
            spd = speed_restriction(leg)
            crs = self._true(apt, leg.course, leg.course_true)
            before, before_len = cur, len(cur)

            if from_first_fix and leg is legs[0] and fixll:
                pen_up()
                line_to([fixll])
                pos = fixll
            elif pt in TO_FIX and fixll:
                if pt == "IF" or pos is None:
                    if pt == "CF" and pos is None and crs is not None and leg.dist:
                        # inbound course and leg length are both published
                        start = geo.destination(*fixll, (crs + 180) % 360, leg.dist)
                        pen_up()
                        line_to([start, fixll])
                    else:
                        pen_up()
                        line_to([fixll])
                elif pt == "RF":
                    ctr = self.c.resolve(apt, leg.center, leg.center_icao, leg.center_sec)
                    if ctr and leg.turn in ("L", "R"):
                        line_to(geo.arc((ctr.lat, ctr.lon), pos, fixll, leg.turn, leg.arc_radius))
                    else:
                        line_to([fixll])
                elif pt == "AF":
                    nav = self.c.resolve(apt, leg.navaid, leg.fix_icao, leg.navaid_sec)
                    if nav and leg.turn in ("L", "R"):
                        line_to(geo.arc((nav.lat, nav.lon), pos, fixll, leg.turn, leg.rho))
                    else:
                        line_to([fixll])
                else:
                    line_to([fixll])
                pos = fixll
            elif pt in HOLDS and fixll:
                if pos is not None and pos != fixll:
                    line_to([fixll])
                elif pos is None:
                    pen_up()
                    line_to([fixll])
                pos = fixll
            elif pt == "FC" and fixll and crs is not None and leg.dist:
                if pos is None or pos != fixll:
                    pen_up()
                    line_to([fixll])
                end = geo.destination(*fixll, crs, leg.dist)
                line_to([end])
                pos = end
            else:
                # open-ended leg: no defined end point -> break the track
                if pt == "PI" and fixll:
                    pos = fixll
                else:
                    pen_up()
                    pos = None

            # points this leg drew, including its starting point
            drawn = cur[max(0, before_len - 1):] if cur is before else cur[:]
            if leg.rnp:
                rnp, rnp_src = leg.rnp, "coded"
            elif rnav_spec:
                rnp, rnp_src = RNAV1_NM, "spec"
            else:
                rnp, rnp_src = None, None
            if alt:
                cons.append((k, alt.get("lo") if alt["k"] != "below" else None,
                             alt.get("hi") if alt["k"] != "above" else None))
            if len(drawn) >= 2:
                piece = {"k": k, "path": [list(q) for q in drawn]}
                if rnp:
                    piece["rnp"], piece["rnpSrc"] = rnp, rnp_src
                if leg.vert_angle and alt and alt["k"] == "at":
                    piece["glide"] = glide_profile(piece["path"], alt["lo"], leg.vert_angle)
                pieces.append(piece)
            if rnp and len(drawn) >= 2:
                last = corridors[-1] if corridors else None
                if last and last["rnp"] == rnp and last["src"] == rnp_src and last["path"][-1] == drawn[0]:
                    last["path"].extend(drawn[1:])
                else:
                    corridors.append({"rnp": rnp, "src": rnp_src, "path": list(drawn)})

            p = {"seq": leg.seq, "pt": pt}
            if rnp:
                p["rnp"], p["rnpSrc"] = rnp, rnp_src
            if len(drawn) >= 2:
                # inbound true track at the fix, for orienting the restriction window
                (lon1, lat1), (lon2, lat2) = drawn[-2], drawn[-1]
                p["trk"] = round(geo.bearing(lat1, lon1, lat2, lon2), 1)
            if leg.fix:
                p["fix"] = leg.fix
            if fixll and (pt in TO_FIX or pt in HOLDS or pt in ("FC", "PI", "FA", "FM", "FD")):
                p["lat"], p["lon"] = round(fixll[0], 6), round(fixll[1], 6)
            if alt:
                p["alt"] = alt
            if spd:
                p["spd"] = spd
            flags = []
            if leg.desc[1:2] == "Y":
                flags.append("flyover")
            role = FIX_ROLE.get(leg.desc[3:4])
            if role:
                flags.append(role)
            if flags:
                p["flags"] = flags
            if leg.vert_angle:
                p["vpa"] = leg.vert_angle
            if pt in HOLDS:
                p["hold"] = {
                    "inbound": leg.course, "true": leg.course_true, "turn": leg.turn or "R",
                    **({"nm": leg.dist} if leg.dist else {}),
                    **({"min": leg.time_min} if leg.time_min else {}),
                }
            if pt in PT_TEXT:
                txt = PT_TEXT[pt].format(
                    crs=f"{leg.course:05.1f}" if leg.course is not None else "?",
                    alt=fmt_alt(alt), fix=leg.fix, nav=leg.navaid,
                    theta=f"{leg.theta:05.1f}" if leg.theta is not None else "?",
                    rho=f"{leg.rho:g}" if leg.rho is not None else "?",
                )
                p["note"] = txt
                notes.append({"seq": leg.seq, "text": txt})
            points.append(p)
        pen_up()
        # fixes that start a drawn segment take the outbound track instead
        for p in points:
            if "trk" in p or "lat" not in p:
                continue
            here = [p["lon"], p["lat"]]
            for path in paths:
                i = next((k for k, q in enumerate(path[:-1]) if q == here), None)
                if i is not None:
                    (lon2, lat2) = path[i + 1]
                    p["trk"] = round(geo.bearing(p["lat"], p["lon"], lat2, lon2), 1)
                    break
        out = {"path": paths, "points": points, "corridors": corridors,
               "_pieces": pieces, "_cons": cons}
        if unresolved:
            out["unresolved"] = sorted(set(unresolved))
        return out

    def build_airport(self, apt: str) -> list[dict]:
        procs: dict[tuple[str, str], dict] = {}
        for key, rec in sorted(self.c.procs.items()):
            if rec.airport != apt:
                continue
            ptype = SUBSECTION_TYPE[rec.subsection]
            legs = sorted(rec.legs, key=lambda l: l.seq)
            pid = (ptype, rec.ident)
            proc = procs.setdefault(pid, {
                "airport": apt, "type": ptype, "id": rec.ident, "transitions": [],
            })
            if ptype == "IAP":
                if rec.route_type == "A":
                    groups = [("approach", rec.transition or "?", legs)]
                else:
                    proc["approachType"] = IAP_TYPE.get(rec.route_type, rec.route_type)
                    # split final approach from missed approach at the MAP
                    mi = next((i for i, l in enumerate(legs) if l.desc[3:4] == "M"), None)
                    if mi is None:
                        groups = [("final", "", legs)]
                    else:
                        groups = [("final", "", legs[: mi + 1]), ("missed", "", legs[mi:])]
            else:
                kinds = SID_KIND if ptype == "SID" else STAR_KIND
                kind = kinds.get(rec.route_type, "common")
                if kind is None:
                    continue
                groups = [(kind, rec.transition, legs)]
            for kind, name, gl in groups:
                t = self.build_transition(rec, gl, from_first_fix=(kind == "missed"))
                t = {"kind": kind, "name": name, "routeType": rec.route_type, **t}
                if kind == "missed":
                    # MAP itself belongs to the final segment; keep it only as path start
                    t["points"] = t["points"][1:]
                proc["transitions"].append(t)
        out = list(procs.values())
        for proc in out:
            envelope.apply(proc)
        return out
