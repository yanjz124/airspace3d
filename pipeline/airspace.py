"""Fetch airspace volumes from the FAA AIS Open Data (ArcGIS) feature services."""
from __future__ import annotations

import json
import urllib.parse
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


def query(service: str, where: str, fields: list[str], bbox: list[float]) -> dict:
    features = []
    offset = 0
    while True:
        params = {
            "where": where,
            "outFields": ",".join(fields),
            "geometry": ",".join(map(str, bbox)),
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "outSR": "4326",
            "geometryPrecision": "5",
            "maxAllowableOffset": "0.0003",
            "resultOffset": str(offset),
            "f": "geojson",
        }
        url = f"{BASE}/{service}/FeatureServer/0/query?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={"User-Agent": "airspace3d-pipeline (+https://github.com/yanjz124/airspace3d)"})
        with urllib.request.urlopen(req, timeout=120) as r:
            body = r.read()
        page = json.loads(body)
        if "features" not in page:
            raise RuntimeError(f"{service}: unexpected response {body[:500]!r}")
        batch = page["features"]
        features.extend(batch)
        if not page.get("properties", {}).get("exceededTransferLimit") and not page.get("exceededTransferLimit"):
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


def fetch_all(bbox: list[float]) -> dict:
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
