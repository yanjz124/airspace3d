"""Build static data bundles for the web viewer.

    python -m pipeline.build                 # all metros, current AIRAC cycle
    python -m pipeline.build --metro n90 --cifp data/raw/cifp/FAACIFP18
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import pathlib
import urllib.request
import zipfile

from . import airac, airspace
from .arinc424 import CIFP
from .procedures import Builder

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "web" / "public" / "data"


def ensure_cifp(eff: dt.date) -> pathlib.Path:
    dest = RAW / f"CIFP_{eff:%y%m%d}"
    path = dest / "FAACIFP18"
    if path.exists():
        return path
    url = airac.cifp_url(eff)
    print(f"downloading {url}")
    with urllib.request.urlopen(url, timeout=300) as r:
        data = r.read()
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        z.extract("FAACIFP18", dest)
    return path


def runways(c: CIFP, apt: str) -> list[dict]:
    """Pair runway thresholds into strips (e.g. 04L/22R)."""
    ends = {k[1]: v for k, v in c.runways.items() if k[0] == apt}
    out, seen = [], set()
    for ident, p in sorted(ends.items()):
        if ident in seen:
            continue
        num, side = int(ident[2:4]), ident[4:]
        recip = f"RW{(num + 18 - 1) % 36 + 1:02d}" + {"L": "R", "R": "L"}.get(side, side)
        q = ends.get(recip)
        seen.update({ident, recip})
        strip = {"id": ident[2:] + ("/" + recip[2:] if q else ""),
                 "ends": [[round(p.lon, 6), round(p.lat, 6), p.elev]]}
        if q:
            strip["ends"].append([round(q.lon, 6), round(q.lat, 6), q.elev])
        out.append(strip)
    return out


def build_metro(cfg: dict, cifp_path: pathlib.Path, eff: dt.date, skip_airspace: bool) -> None:
    apts = set(cfg["airports"])
    print(f"[{cfg['id']}] parsing {cifp_path}")
    c = CIFP(str(cifp_path), apts)
    b = Builder(c)
    airports, procs, unresolved = [], [], set()
    for apt in cfg["airports"]:
        a = c.airports.get(apt)
        if a is None:
            print(f"  ! {apt} not in CIFP")
            continue
        airports.append({
            "id": apt, "name": a.extra["name"], "lon": round(a.lon, 6), "lat": round(a.lat, 6),
            "elev": a.elev, "magvar": a.magvar, "runways": runways(c, apt),
        })
        ap = b.build_airport(apt)
        for p in ap:
            for t in p["transitions"]:
                unresolved.update(t.get("unresolved", []))
        procs.extend(ap)
        n = {k: sum(1 for p in ap if p["type"] == k) for k in ("SID", "STAR", "IAP")}
        print(f"  {apt}: {n}")
    if unresolved:
        print(f"  ! unresolved fixes: {sorted(unresolved)}")

    out = OUT / cfg["id"]
    out.mkdir(parents=True, exist_ok=True)
    meta = {"cycle": airac.cycle_ident(eff), "effective": eff.isoformat(),
            "source": "FAA CIFP", "built": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}
    bundle = {"meta": meta, "metro": cfg, "airports": airports, "procedures": procs}
    (out / "procedures.json").write_text(json.dumps(bundle, separators=(",", ":")), encoding="utf-8")
    print(f"  wrote {out / 'procedures.json'} ({len(procs)} procedures)")

    if not skip_airspace:
        a = airspace.fetch_all(cfg["bbox"])
        a["meta"] = {"source": "FAA AIS Open Data", "fetched": meta["built"]}
        (out / "airspace.json").write_text(json.dumps(a, separators=(",", ":")), encoding="utf-8")
        print(f"  wrote airspace.json ({ {k: len(v['features']) for k, v in a.items() if k != 'meta'} })")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--metro", action="append", help="metro id(s); default all in metros/")
    ap.add_argument("--cifp", help="path to an existing FAACIFP18 file")
    ap.add_argument("--date", help="effective date YYYY-MM-DD (default: current cycle)")
    ap.add_argument("--skip-airspace", action="store_true")
    args = ap.parse_args()

    eff = airac.current_cycle(dt.date.fromisoformat(args.date) if args.date else None)
    cifp_path = pathlib.Path(args.cifp) if args.cifp else ensure_cifp(eff)
    cfgs = sorted((ROOT / "metros").glob("*.json"))
    index = []
    for f in cfgs:
        cfg = json.loads(f.read_text(encoding="utf-8"))
        index.append({"id": cfg["id"], "name": cfg["name"]})
        if args.metro and cfg["id"] not in args.metro:
            continue
        build_metro(cfg, cifp_path, eff, args.skip_airspace)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "index.json").write_text(json.dumps({"metros": index, "cycle": airac.cycle_ident(eff)}), encoding="utf-8")


if __name__ == "__main__":
    main()
