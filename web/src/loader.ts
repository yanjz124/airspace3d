import { Math as CesiumMath, Rectangle } from "cesium";
import type { ViewInfo } from "./scene";
import type { AirportFile, AirspaceFeature, AirspaceTile, DataIndex, IndexAirport, ProcType } from "./types";

/** Procedures are only loaded below this camera height (m). */
export const PROC_MAX_HEIGHT = 450_000;
/** Airspace tiles are only loaded below this camera height (m). */
export const AIRSPACE_MAX_HEIGHT = 2_500_000;
/** Max airports with procedures drawn at once. */
const MAX_AIRPORTS = 12;
/** Rough cap on procedures drawn at once, nearest airports first. */
const PROC_BUDGET = 200;

const airportCache = new Map<string, Promise<AirportFile>>();
const tileCache = new Map<string, Promise<AirspaceTile | null>>();

export function loadAirport(id: string): Promise<AirportFile> {
  let p = airportCache.get(id);
  if (!p) {
    p = fetch(`data/airports/${id}.json`).then((r) => {
      if (!r.ok) throw new Error(`${id}: HTTP ${r.status}`);
      return r.json();
    });
    p.catch(() => airportCache.delete(id));
    airportCache.set(id, p);
  }
  return p;
}

function loadTile(key: string): Promise<AirspaceTile | null> {
  let p = tileCache.get(key);
  if (!p) {
    p = fetch(`data/airspace/${key}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    tileCache.set(key, p);
  }
  return p;
}

const procCount = (a: IndexAirport, types: Record<ProcType, boolean>) =>
  (types.SID ? a[5] : 0) + (types.STAR ? a[6] : 0) + (types.IAP ? a[7] : 0);

function inRect(rect: Rectangle | undefined, lon: number, lat: number): boolean {
  if (!rect) return true;
  return Rectangle.contains(rect, { longitude: CesiumMath.toRadians(lon), latitude: CesiumMath.toRadians(lat), height: 0 } as never);
}

/** Airports whose procedures should be drawn for this view, nearest to the view center first. */
export function pickAirports(index: DataIndex, view: ViewInfo, types: Record<ProcType, boolean>): string[] {
  if (view.height > PROC_MAX_HEIGHT || !view.center) return [];
  const { lon, lat } = view.center;
  const k = Math.cos(CesiumMath.toRadians(lat));
  const candidates = index.airports
    .filter((a) => procCount(a, types) > 0 && inRect(view.rect, a[2], a[3]))
    .map((a) => ({ a, d: ((a[2] - lon) * k) ** 2 + (a[3] - lat) ** 2 }))
    .sort((x, y) => x.d - y.d);
  const out: string[] = [];
  let budget = 0;
  for (const { a } of candidates) {
    const n = procCount(a, types);
    if (out.length && (budget + n > PROC_BUDGET || out.length >= MAX_AIRPORTS)) break;
    out.push(a[0]);
    budget += n;
  }
  return out;
}

/** Airspace features in tiles overlapping the view. */
export async function loadAirspace(index: DataIndex, view: ViewInfo): Promise<AirspaceFeature[]> {
  if (view.height > AIRSPACE_MAX_HEIGHT || !view.rect) return [];
  const deg = index.airspaceTileDeg;
  const r = view.rect;
  const w = CesiumMath.toDegrees(r.west), e = CesiumMath.toDegrees(r.east);
  const s = CesiumMath.toDegrees(r.south), n = CesiumMath.toDegrees(r.north);
  const available = new Set(index.airspaceTiles);
  const xs: number[] = [];
  // handle rectangles crossing the antimeridian
  const spans = w <= e ? [[w, e]] : [[w, 180], [-180, e]];
  for (const [a, b] of spans) for (let x = Math.floor(a / deg); x <= Math.floor(b / deg); x++) xs.push(x);
  const keys: string[] = [];
  for (const x of xs) for (let y = Math.floor(s / deg); y <= Math.floor(n / deg); y++) {
    if (available.has(`${x}_${y}`)) keys.push(`${x}_${y}`);
  }
  const tiles = await Promise.all(keys.map(loadTile));
  const byId = new Map<string, AirspaceFeature>();
  for (const t of tiles) {
    if (!t) continue;
    for (const f of [...t.class, ...t.sua]) byId.set(f.id, f);
  }
  return [...byId.values()];
}
