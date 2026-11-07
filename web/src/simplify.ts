// Collapse a procedure's transitions into a minimal set of shapes to draw.
import type { ProcPoint, Procedure, Segment, Transition } from "./types";

export interface Tagged<T> {
  item: T;
  /** transition the item was first seen in, for the info panel */
  t: Transition;
}

export interface SimplifiedProcedure {
  /** segments with a band or glidepath, deduplicated and merged into continuous runs */
  volumes: Tagged<Segment>[];
  /** segments without any published altitude, deduplicated */
  tracks: Tagged<Segment>[];
  /** restricted fixes, deduplicated by fix + restriction */
  gates: Tagged<ProcPoint>[];
  /** unrestricted fixes, deduplicated by name */
  fixes: Tagged<ProcPoint>[];
}

const same = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];
const segKey = (s: Segment) =>
  `${s.path[0]}|${s.path[s.path.length - 1]}|${s.path.length}|${s.lo}|${s.hi}|${s.dlo}|${s.dhi}|${s.rnp ?? ""}|${s.glide ? "g" : ""}`;

/** How far an open side (no published limit) extends at least, in feet. */
const OPEN_FT = 1500;
/** Minimum drawn thickness of a band, in feet, so an "at" altitude is not a flat sheet. */
const MIN_FT = 600;

/**
 * Display band for each leg of a transition. Published limits are kept; a side without one is
 * extended at least OPEN_FT, and as far as the neighboring legs' published limits, so a step
 * down (arrivals) or up (departures) between legs joins up instead of leaving a gap.
 */
export function setDisplayBands(t: Transition) {
  const segs = t.segments;
  segs.forEach((s, i) => {
    if (s.glide || (s.lo == null && s.hi == null)) return;
    const near = [segs[i - 1], segs[i + 1]].flatMap((n) => (n && !n.glide ? [n.lo, n.hi] : [])).filter((x) => x != null);
    let lo = s.lo ?? Math.max(0, Math.min(s.hi! - OPEN_FT, ...near.filter((x) => x < s.hi!)));
    let hi = s.hi ?? Math.max(s.lo! + OPEN_FT, ...near.filter((x) => x > s.lo!));
    if (hi - lo < MIN_FT) {
      const mid = (lo + hi) / 2;
      lo = Math.max(0, mid - MIN_FT / 2);
      hi = lo + MIN_FT;
    }
    s.dlo = lo;
    s.dhi = hi;
  });
}
const hasBand = (s: Segment) => !!s.glide || s.lo != null || s.hi != null;

/** Can `b` continue `a` as one volume? */
function mergeable(a: Segment, b: Segment): boolean {
  return (
    !a.glide &&
    !b.glide &&
    a.lo === b.lo &&
    a.hi === b.hi &&
    a.dlo === b.dlo &&
    a.dhi === b.dhi &&
    a.rnp === b.rnp &&
    a.rnpSrc === b.rnpSrc &&
    same(a.path[a.path.length - 1], b.path[0])
  );
}

/**
 * Keys of what has already been drawn. Pass one shared instance across the procedures of an
 * airport so legs and restrictions common to several procedures (e.g. ILS, LOC and RNAV to the
 * same runway) are drawn once.
 */
export interface Drawn {
  segs: Set<string>;
  gates: Set<string>;
  fixes: Set<string>;
}
export const newDrawn = (): Drawn => ({ segs: new Set(), gates: new Set(), fixes: new Set() });

export function simplify(proc: Procedure, transitions: Transition[], drawn: Drawn = newDrawn()): SimplifiedProcedure {
  const seen = drawn.segs;
  const volumes: Tagged<Segment>[] = [];
  const tracks: Tagged<Segment>[] = [];

  for (const t of transitions) {
    setDisplayBands(t);
    let run: Tagged<Segment> | undefined;
    for (const s of t.segments) {
      const key = segKey(s);
      if (seen.has(key)) {
        run = undefined; // drawn by another transition; break the run here
        continue;
      }
      seen.add(key);
      if (!hasBand(s)) {
        tracks.push({ item: s, t });
        run = undefined;
      } else if (run && mergeable(run.item, s)) {
        run.item = { ...run.item, path: [...run.item.path, ...s.path.slice(1)] };
      } else {
        run = { item: s, t };
        volumes.push(run);
      }
    }
  }

  const gates = new Map<string, Tagged<ProcPoint>>();
  const fixes = new Map<string, Tagged<ProcPoint>>();
  for (const t of transitions) {
    for (const p of t.points) {
      if (p.lat == null || p.lon == null) continue;
      if (p.alt) {
        const key = `${p.fix ?? `${p.lat},${p.lon}`}|${p.alt.k}|${p.alt.lo}|${p.alt.hi}|${p.spd?.kt ?? ""}`;
        if (!gates.has(key) && !drawn.gates.has(key)) gates.set(key, { item: p, t });
      } else if (p.fix && !fixes.has(p.fix) && !drawn.fixes.has(p.fix)) {
        fixes.set(p.fix, { item: p, t });
      }
    }
  }
  for (const k of gates.keys()) drawn.gates.add(k);
  // a fix with a restriction somewhere doesn't also need a plain label
  for (const g of gates.values()) if (g.item.fix) drawn.fixes.add(g.item.fix);
  const plain = [...fixes.values()].filter((f) => !drawn.fixes.has(f.item.fix!));
  for (const f of plain) drawn.fixes.add(f.item.fix!);
  return { volumes, tracks, gates: [...gates.values()], fixes: plain };
}

/**
 * A hard crossing restriction: an "at" or "between" altitude at a fix.
 * Runway thresholds are excluded since every approach has one.
 */
export function hasHardRestriction(transitions: Transition[]): boolean {
  return transitions.some((t) =>
    t.points.some((p) => p.alt && (p.alt.k === "at" || p.alt.k === "between") && !p.fix?.startsWith("RW")),
  );
}
