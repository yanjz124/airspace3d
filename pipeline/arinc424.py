"""Minimal fixed-width ARINC 424 v18 reader for the FAA CIFP (FAACIFP18).

Only the record types needed to place terminal procedures are parsed:
airports (PA), runways (PG), terminal waypoints (PC), enroute waypoints (EA),
VHF/NDB navaids (D, DB, PN) and SID/STAR/IAP legs (PD/PE/PF).
Column numbers below are 1-indexed, as in the spec.
"""
from __future__ import annotations

from dataclasses import dataclass, field


def col(line: str, a: int, b: int) -> str:
    return line[a - 1:b]


def parse_lat(s: str) -> float | None:
    # N40382374 -> N 40deg 38min 23.74sec
    s = s.strip()
    if len(s) != 9 or s[0] not in "NS":
        return None
    v = int(s[1:3]) + int(s[3:5]) / 60 + int(s[5:9]) / 100 / 3600
    return -v if s[0] == "S" else v


def parse_lon(s: str) -> float | None:
    # W073464329 -> W 073deg 46min 43.29sec
    s = s.strip()
    if len(s) != 10 or s[0] not in "EW":
        return None
    v = int(s[1:4]) + int(s[4:6]) / 60 + int(s[6:10]) / 100 / 3600
    return -v if s[0] == "W" else v


def parse_magvar(s: str) -> float | None:
    # W0130 -> -13.0 (west negative, so true = magnetic + magvar)
    s = s.strip()
    if len(s) != 5 or s[0] not in "EWT" or not s[1:].isdigit():
        return None
    v = int(s[1:]) / 10
    return -v if s[0] == "W" else v


def parse_alt(s: str) -> int | None:
    s = s.strip()
    if not s:
        return None
    if s.startswith("FL") and s[2:].isdigit():
        return int(s[2:]) * 100
    if s.lstrip("-").isdigit():
        return int(s)
    return None


def parse_int(s: str, scale: float = 1.0) -> float | None:
    s = s.strip()
    if not s or not s.lstrip("-").isdigit():
        return None
    return int(s) / scale


@dataclass
class Point:
    ident: str
    lat: float
    lon: float
    kind: str  # airport | runway | terminal | enroute | vor | ndb
    region: str = ""  # airport ident for terminal records, else ""
    magvar: float | None = None
    elev: int | None = None
    extra: dict = field(default_factory=dict)


@dataclass
class Leg:
    seq: int
    fix: str
    fix_icao: str
    fix_sec: str  # e.g. "PC", "EA", "D ", "PG"
    desc: str
    turn: str
    pt: str  # path terminator
    navaid: str
    navaid_sec: str
    arc_radius: float | None  # NM (RF)
    theta: float | None
    rho: float | None  # NM
    course: float | None  # degrees magnetic (or true if 'T' suffix)
    course_true: bool
    dist: float | None  # NM
    time_min: float | None  # minutes (holds)
    alt_desc: str
    alt1: int | None
    alt2: int | None
    trans_alt: int | None
    speed: int | None
    speed_desc: str
    vert_angle: float | None
    center: str
    center_icao: str
    center_sec: str


@dataclass
class ProcRecord:
    airport: str
    subsection: str  # D=SID E=STAR F=IAP
    ident: str
    route_type: str
    transition: str
    legs: list[Leg] = field(default_factory=list)


class CIFP:
    def __init__(self, path: str, airports: set[str] | None = None):
        self.airports: dict[str, Point] = {}
        self.runways: dict[tuple[str, str], Point] = {}
        self.terminal: dict[tuple[str, str], Point] = {}  # (airport, ident)
        self.enroute: dict[tuple[str, str], Point] = {}  # (icao region, ident)
        self.navaids: dict[tuple[str, str], Point] = {}  # (icao region, ident)
        self.ndbs: dict[tuple[str, str], Point] = {}
        self.terminal_ndbs: dict[tuple[str, str], Point] = {}
        self.procs: dict[tuple[str, str, str, str, str], ProcRecord] = {}
        self._read(path, airports)

    def _read(self, path: str, want: set[str] | None) -> None:
        with open(path, encoding="latin-1") as f:
            for raw in f:
                line = raw.rstrip("\r\n").ljust(132)
                if line[0] != "S":
                    continue
                sec = line[4]
                if sec == "P":
                    apt = col(line, 7, 10).strip()
                    sub = line[12]
                    if sub == "A":
                        self._airport(line, apt)
                    if want is not None and apt not in want:
                        # terminal waypoints of other airports may still be referenced
                        if sub == "C":
                            self._terminal_wp(line, apt)
                        continue
                    if sub == "G":
                        self._runway(line, apt)
                    elif sub == "C":
                        self._terminal_wp(line, apt)
                    elif sub == "N":
                        self._point(line, apt, "ndb", self.terminal_ndbs, key=(apt, col(line, 14, 17).strip()))
                    elif sub in "DEF":
                        self._proc_leg(line, apt, sub)
                elif sec == "E" and line[5] == "A":
                    ident = col(line, 14, 18).strip()
                    self._point(line, "", "enroute", self.enroute, key=(col(line, 20, 21), ident))
                elif sec == "D":
                    ident = col(line, 14, 17).strip()
                    if line[5] == "B":
                        self._point(line, "", "ndb", self.ndbs, key=(col(line, 20, 21), ident))
                    elif line[5] == " ":
                        self._vhf(line, ident)

    # --- point records -------------------------------------------------
    def _point(self, line, region, kind, table, key):
        if col(line, 22, 22) not in ("0", "1"):
            return  # continuation record
        lat, lon = parse_lat(col(line, 33, 41)), parse_lon(col(line, 42, 51))
        if lat is None or lon is None:
            return
        table[key] = Point(key[1], lat, lon, kind, region, parse_magvar(col(line, 75, 79)))

    def _vhf(self, line, ident):
        if col(line, 22, 22) not in ("0", "1"):
            return
        lat, lon = parse_lat(col(line, 33, 41)), parse_lon(col(line, 42, 51))
        if lat is None:  # DME-only: use DME position
            lat, lon = parse_lat(col(line, 56, 64)), parse_lon(col(line, 65, 74))
        if lat is None or lon is None:
            return
        self.navaids[(col(line, 20, 21), ident)] = Point(
            ident, lat, lon, "vor", "", parse_magvar(col(line, 75, 79)),
            extra={"name": col(line, 94, 123).strip()},
        )

    def _airport(self, line, apt):
        if col(line, 22, 22) not in ("0", "1"):
            return
        lat, lon = parse_lat(col(line, 33, 41)), parse_lon(col(line, 42, 51))
        if lat is None:
            return
        self.airports[apt] = Point(
            apt, lat, lon, "airport", apt, parse_magvar(col(line, 52, 56)),
            elev=parse_alt(col(line, 57, 61)),
            extra={
                "name": col(line, 94, 123).strip(),
                "trans_alt": parse_alt(col(line, 71, 75)),
                "trans_level": parse_alt(col(line, 76, 80)),
            },
        )

    def _runway(self, line, apt):
        if col(line, 22, 22) not in ("0", "1"):
            return
        ident = col(line, 14, 18).strip()
        lat, lon = parse_lat(col(line, 33, 41)), parse_lon(col(line, 42, 51))
        if lat is None:
            return
        self.runways[(apt, ident)] = Point(
            ident, lat, lon, "runway", apt, elev=parse_alt(col(line, 67, 71)),
            extra={
                "length_ft": parse_int(col(line, 23, 27)),
                "bearing_mag": parse_int(col(line, 28, 31), 10),
                "displaced_ft": parse_int(col(line, 72, 75)),
            },
        )

    def _terminal_wp(self, line, apt):
        ident = col(line, 14, 18).strip()
        self._point(line, apt, "terminal", self.terminal, key=(apt, ident))

    # --- procedure legs ------------------------------------------------
    def _proc_leg(self, line, apt, sub):
        if col(line, 39, 39) not in ("0", "1"):
            return  # skip continuation records
        ident = col(line, 14, 19).strip()
        rtype = col(line, 20, 20)
        trans = col(line, 21, 25).strip()
        key = (apt, sub, ident, rtype, trans)
        rec = self.procs.get(key)
        if rec is None:
            rec = self.procs[key] = ProcRecord(apt, sub, ident, rtype, trans)
        crs_raw = col(line, 71, 74)
        dist_raw = col(line, 75, 78)
        time_min = None
        dist = None
        if dist_raw.startswith("T"):
            time_min = parse_int(dist_raw[1:], 10)
        else:
            dist = parse_int(dist_raw, 10)
        rec.legs.append(Leg(
            seq=int(col(line, 27, 29)),
            fix=col(line, 30, 34).strip(),
            fix_icao=col(line, 35, 36),
            fix_sec=col(line, 37, 38),
            desc=col(line, 40, 43),
            turn=col(line, 44, 44).strip(),
            pt=col(line, 48, 49),
            navaid=col(line, 51, 54).strip(),
            navaid_sec=col(line, 79, 80),
            arc_radius=parse_int(col(line, 57, 62), 1000),
            theta=parse_int(col(line, 63, 66), 10),
            rho=parse_int(col(line, 67, 70), 10),
            # "0438" = 043.8 magnetic; "043T" = 043 true
            course=parse_int(crs_raw[:3]) if crs_raw.endswith("T") else parse_int(crs_raw, 10),
            course_true=crs_raw.endswith("T"),
            dist=dist,
            time_min=time_min,
            alt_desc=col(line, 83, 83),
            alt1=parse_alt(col(line, 85, 89)),
            alt2=parse_alt(col(line, 90, 94)),
            trans_alt=parse_alt(col(line, 95, 99)),
            speed=parse_int(col(line, 100, 102)),
            speed_desc=col(line, 118, 118),
            vert_angle=parse_int(col(line, 103, 106), 100),
            center=col(line, 107, 111).strip(),
            center_icao=col(line, 113, 114),
            center_sec=col(line, 115, 116),
        ))

    # --- lookup --------------------------------------------------------
    def resolve(self, airport: str, ident: str, icao: str, sec: str) -> Point | None:
        """Resolve a fix reference from a procedure leg."""
        if not ident:
            return None
        s, sub = sec[0], sec[1] if len(sec) > 1 else " "
        if s == "P" and sub == "C":
            return self.terminal.get((airport, ident)) or self.enroute.get((icao, ident))
        if s == "P" and sub == "G":
            return self.runways.get((airport, ident))
        if s == "P" and sub == "N":
            return self.terminal_ndbs.get((airport, ident))
        if s == "P" and sub == "A":
            return self.airports.get(ident)
        if s == "E":
            return self.enroute.get((icao, ident))
        if s == "D" and sub == "B":
            return self.ndbs.get((icao, ident))
        if s == "D":
            return self.navaids.get((icao, ident))
        return None
