"""Build static data for the web viewer: one file per airport plus tiled airspace.

    python -m pipeline.build                       # current AIRAC cycle, everything
    python -m pipeline.build --cifp data/raw/cifp/FAACIFP18 --skip-airspace
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import math
import pathlib
import shutil
import urllib.request
import zipfile

from . import airac, airspace
from .arinc424 import CIFP
from .procedures import Builder

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "web" / "public" / "data"
TILE_DEG = 4  # airspace tile size


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


def write_json(path: pathlib.Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":")), encoding="utf-8")


def runways(c: CIFP, apt: str) -> list[dict]:
    """Pair runway thresholds into strips (e.g. 04L/22R)."""
    ends = {k[1]: v for k, v in c.runways.items() if k[0] == apt}
    out, seen = [], set()
    for ident, p in sorted(ends.items()):
        if ident in seen or not ident[2:4].isdigit():
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


def build_procedures(c: CIFP) -> list[list]:
    b = Builder(c)
    apts = sorted({k[0] for k in c.procs} & set(c.airports))
    index = []
    for n, apt in enumerate(apts, 1):
        a = c.airports[apt]
        procs = b.build_airport(apt)
        counts = [sum(1 for p in procs if p["type"] == t) for t in ("SID", "STAR", "IAP")]
        write_json(OUT / "airports" / f"{apt}.json", {
            "airport": {
                "id": apt, "name": a.extra["name"], "lon": round(a.lon, 6), "lat": round(a.lat, 6),
                "elev": a.elev, "magvar": a.magvar, "runways": runways(c, apt),
            },
            "procedures": procs,
        })
        index.append([apt, a.extra["name"], round(a.lon, 5), round(a.lat, 5), a.elev or 0, *counts])
        if n % 500 == 0:
            print(f"  {n}/{len(apts)} airports")
    print(f"  wrote {len(apts)} airport files")
    return index


def tile_airspace(bundle: dict) -> list[str]:
    """Split features into TILE_DEG grid cells by bounding box; a feature may sit in several cells."""
    tiles: dict[str, dict[str, list]] = {}
    for layer in ("class", "sua"):
        for i, f in enumerate(bundle[layer]["features"]):
            g = f["geometry"]
            if not g:
                continue
            polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
            xs = [x for poly in polys for x, _ in poly[0]]
            ys = [y for poly in polys for _, y in poly[0]]
            f["id"] = f"{layer}-{i}"
            for tx in range(math.floor(min(xs) / TILE_DEG), math.floor(max(xs) / TILE_DEG) + 1):
                for ty in range(math.floor(min(ys) / TILE_DEG), math.floor(max(ys) / TILE_DEG) + 1):
                    tiles.setdefault(f"{tx}_{ty}", {"class": [], "sua": []})[layer].append(f)
    shutil.rmtree(OUT / "airspace", ignore_errors=True)
    for key, t in tiles.items():
        write_json(OUT / "airspace" / f"{key}.json", t)
    print(f"  wrote {len(tiles)} airspace tiles "
          f"({len(bundle['class']['features'])} class, {len(bundle['sua']['features'])} SUA)")
    return sorted(tiles)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cifp", help="path to an existing FAACIFP18 file")
    ap.add_argument("--date", help="effective date YYYY-MM-DD (default: current cycle)")
    ap.add_argument("--skip-airspace", action="store_true")
    args = ap.parse_args()

    eff = airac.current_cycle(dt.date.fromisoformat(args.date) if args.date else None)
    cifp_path = pathlib.Path(args.cifp) if args.cifp else ensure_cifp(eff)
    print(f"parsing {cifp_path}")
    c = CIFP(str(cifp_path))
    shutil.rmtree(OUT / "airports", ignore_errors=True)
    airports = build_procedures(c)

    if not args.skip_airspace:
        bundle = airspace.fetch_all()
        tiles = tile_airspace(bundle)
        class_features = bundle["class"]["features"]
    else:
        # reuse previously written tiles
        tiles = sorted(f.stem for f in (OUT / "airspace").glob("*.json"))
        seen = {}
        for t in tiles:
            for f in json.loads((OUT / "airspace" / f"{t}.json").read_text(encoding="utf-8"))["class"]:
                seen[f["id"]] = f
        class_features = list(seen.values())

    classes = airspace.surface_class({a[0]: (a[2], a[3]) for a in airports}, class_features)
    for a in airports:
        a.append(classes[a[0]])
    counts = {k: sum(1 for v in classes.values() if v == k) for k in ("B", "C", "D", "E/G")}
    print(f"  surface class: {counts}")

    write_json(OUT / "index.json", {
        "cycle": airac.cycle_ident(eff),
        "effective": eff.isoformat(),
        "built": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "airportFields": ["id", "name", "lon", "lat", "elev", "sids", "stars", "iaps", "class"],
        "airports": airports,
        "airspaceTileDeg": TILE_DEG,
        "airspaceTiles": tiles or [],
    })


if __name__ == "__main__":
    main()
