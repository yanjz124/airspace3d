// Where other procedures cross a focused one, and how their published altitude bands relate there.
import type { Procedure, Segment, Transition } from "./types";
import { procKey } from "./types";
import { setDisplayBands } from "./simplify";

export interface Band {
  lo: number | null;
  hi: number | null;
  /** display band (published limits, open sides extended), for drawing */
  dlo: number;
  dhi: number;
}

export interface Crossing {
  lon: number;
  lat: number;
  focus: Band;
  other: Band;
  /**
   * Vertical gap between the bands guaranteed by published limits (ft), or null when an open
   * side ("at or above" / "at or below") or overlapping bands leave it to ATC.
   */
  gap: number | null;
  /** which procedure is on top when separated */
  above: "focus" | "other" | null;
}

export interface Relation {
  key: string;
  proc: Procedure;
  crossings: Crossing[];
  /** smallest published gap among the separated crossings, or null if none is separated */
  minGap: number | null;
  /** which is on top at that tightest separated crossing */
  above: "focus" | "other" | null;
  /** crossings where published limits do not keep the two apart */
  open: number;
}

type Piece = { a: [number, number]; b: [number, number]; s: Segment };

function pieces(ts: Transition[]): Piece[] {
  const out: Piece[] = [];
  for (const t of ts) {
    setDisplayBands(t);
    for (const s of t.segments) {
      if (s.dlo == null || s.dhi == null) continue; // no published altitude: nothing to compare
      for (let i = 1; i < s.path.length; i++) out.push({ a: s.path[i - 1], b: s.path[i], s });
    }
  }
  return out;
}

/** Interior intersection of two legs in a local flat frame; returns the parameter along `p`. */
function intersect(p: Piece, q: Piece, k: number): number | null {
  const [x1, y1] = [p.a[0] * k, p.a[1]];
  const [x2, y2] = [p.b[0] * k, p.b[1]];
  const [x3, y3] = [q.a[0] * k, q.a[1]];
  const [x4, y4] = [q.b[0] * k, q.b[1]];
  const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
  if (Math.abs(d) < 1e-12) return null; // parallel or a shared leg
  const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
  const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
  // strictly inside both legs: touching at a shared fix is joining, not crossing
  return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6 ? t : null;
}

const band = (s: Segment): Band => ({ lo: s.lo, hi: s.hi, dlo: s.dlo!, dhi: s.dhi! });

function compare(f: Band, o: Band): { gap: number | null; above: Crossing["above"] } {
  if (f.hi != null && o.lo != null && o.lo >= f.hi) return { gap: o.lo - f.hi, above: "other" };
  if (o.hi != null && f.lo != null && f.lo >= o.hi) return { gap: f.lo - o.hi, above: "focus" };
  return { gap: null, above: null };
}

/**
 * Procedures whose legs cross the focused procedure's legs in plan view, with the published
 * vertical relationship at each crossing. Legs without any published altitude are ignored.
 * Fully separated relations come first (tightest gap first), then partly, then not at all.
 */
export function findRelations(
  focused: Procedure,
  focusedTs: Transition[],
  others: { proc: Procedure; ts: Transition[] }[],
  limit = 15,
): Relation[] {
  const fp = pieces(focusedTs);
  if (!fp.length) return [];
  const k = Math.cos((fp[0].a[1] * Math.PI) / 180);
  const out: Relation[] = [];
  for (const { proc, ts } of others) {
    if (procKey(proc) === procKey(focused)) continue;
    const crossings: Crossing[] = [];
    const seen = new Set<string>();
    for (const q of pieces(ts)) {
      for (const p of fp) {
        const t = intersect(p, q, k);
        if (t == null) continue;
        const lon = p.a[0] + t * (p.b[0] - p.a[0]);
        const lat = p.a[1] + t * (p.b[1] - p.a[1]);
        const id = `${lon.toFixed(3)},${lat.toFixed(3)}`; // same crossing reached via several transitions
        if (seen.has(id)) continue;
        seen.add(id);
        const f = band(p.s);
        const o = band(q.s);
        crossings.push({ lon, lat, focus: f, other: o, ...compare(f, o) });
      }
    }
    if (!crossings.length) continue;
    const sep = crossings.filter((c) => c.gap != null);
    const tight = sep.length ? sep.reduce((m, c) => (c.gap! < m.gap! ? c : m)) : undefined;
    out.push({
      key: procKey(proc),
      proc,
      crossings,
      minGap: tight?.gap ?? null,
      above: tight?.above ?? null,
      open: crossings.length - sep.length,
    });
  }
  // fully separated first (tightest gap first), then partly, then not at all
  const rank = (r: Relation) => (r.minGap == null ? 2 : r.open ? 1 : 0);
  out.sort((a, b) => rank(a) - rank(b) || (a.minGap ?? 0) - (b.minGap ?? 0));
  return out.slice(0, limit);
}
