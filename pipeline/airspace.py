"""Fetch airspace volumes from the FAA AIS Open Data (ArcGIS) feature services."""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.error
import urllib.request

BASE = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services"

LAYERS = {
    "class": {
        "service": "Class_Airspace",
        "where": "TYPE_CODE='CLASS' AND CLASS IN ('B','C','D')",
        "fields": ["NAME", "IDENT", "CLASS", "LOCAL_TYPE", "SECTOR", "LOWER_VAL", "LOWER_CODE",
                   "LOWER_UOM", "UPPER_VAL", "UPPER_CODE", "UPPER_UOM", "WKHR_CODE"],
    },
    "sua": {
        "service": "Special_Use_Airspace",
        "where": "1=1",
        "fields": ["NAME", "TYPE_CODE", "CLASS", "LOWER_VAL", "LOWER_CODE", "LOWER_UOM",
                   "UPPER_VAL", "UPPER_CODE", "UPPER_UOM", "TIMESOFUSE", "CONT_AGENT"],
    },
}


def _get(url: str, attempts: int = 4) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "airspace3d-pipeline (+https://github.com/yanjz124/airspace3d)"})
    for i in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                body = r.read()
            page = json.loads(body)
            if "features" in page:
                return page
            err = f"unexpected response {body[:300]!r}"
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            err = repr(e)
        print(f"    retry {i + 1}: {err}")
        time.sleep(5 * (i + 1))
    raise RuntimeError(f"giving up on {url[:200]}: {err}")


def query(service: str, where: str, fields: list[str], bbox: list[float] | None = None,
          page_size: int = 500) -> dict:
    features = []
    offset = 0
    while True:
        params = {
            "where": where,
            "outFields": ",".join(fields),
            "outSR": "4326",
            "geometryPrecision": "5",
            "maxAllowableOffset": "0.0003",
            "resultOffset": str(offset),
            "resultRecordCount": str(page_size),
            "orderByFields": "OBJECTID",
            "f": "geojson",
        }
        if bbox:
            params.update({
                "geometry": ",".join(map(str, bbox)),
                "geometryType": "esriGeometryEnvelope",
                "inSR": "4326",
                "spatialRel": "esriSpatialRelIntersects",
            })
        url = f"{BASE}/{service}/FeatureServer/0/query?" + urllib.parse.urlencode(params)
        batch = _get(url)["features"]
        features.extend(batch)
        if len(batch) < page_size:
            break
        offset += len(batch)
    return {"type": "FeatureCollection", "features": features}


def to_feet(val, uom, code):
    """Normalize a vertical limit to feet. Returns (feet, reference) with reference SFC/MSL/AGL."""
    if val is None:
        return None, code
    if uom == "FL":
        return int(val) * 100, "MSL"
    return int(val), code or "MSL"


def fetch_all(bbox: list[float] | None = None) -> dict:
    out = {}
    for key, spec in LAYERS.items():
        fc = query(spec["service"], spec["where"], spec["fields"], bbox)
        if not fc["features"]:
            raise RuntimeError(f"{spec['service']}: no features in {bbox}; refusing to publish empty airspace")
        for f in fc["features"]:
            p = f["properties"]
            lo, lo_ref = to_feet(p.get("LOWER_VAL"), p.get("LOWER_UOM"), p.get("LOWER_CODE"))
            hi, hi_ref = to_feet(p.get("UPPER_VAL"), p.get("UPPER_UOM"), p.get("UPPER_CODE"))
            p["floor_ft"], p["floor_ref"] = lo, lo_ref
            p["ceil_ft"], p["ceil_ref"] = hi, hi_ref
        out[key] = fc
    return out


def _in_ring(x: float, y: float, ring) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def _contains(geom: dict, x: float, y: float) -> bool:
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    return any(_in_ring(x, y, rings[0]) and not any(_in_ring(x, y, h) for h in rings[1:]) for rings in polys)


def surface_class(points: dict[str, tuple[float, float]], class_features: list[dict]) -> dict[str, str]:
    """Airspace class at the surface for each (lon, lat): B, C, D, or "E/G" when no B/C/D surface area covers it."""
    rank = {"B": 0, "C": 1, "D": 2}
    areas = []
    for f in class_features:
        p, g = f["properties"], f.get("geometry")
        if not g or p.get("CLASS") not in rank or p.get("floor_ref") != "SFC":
            continue
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        xs = [x for poly in polys for x, _ in poly[0]]
        ys = [y for poly in polys for _, y in poly[0]]
        areas.append((min(xs), min(ys), max(xs), max(ys), p["CLASS"], g))
    out = {}
    for key, (x, y) in points.items():
        best = None
        for x0, y0, x1, y1, cls, g in areas:
            if x0 <= x <= x1 and y0 <= y <= y1 and (best is None or rank[cls] < rank[best]) and _contains(g, x, y):
                best = cls
        out[key] = best or "E/G"
    return out
