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
  `${s.path[0]}|${s.path[s.path.length - 1]}|${s.path.length}|${s.lo}|${s.hi}|${s.rnp ?? ""}|${s.glide ? "g" : ""}`;
const hasBand = (s: Segment) => !!s.glide || s.lo != null || s.hi != null;

/** Can `b` continue `a` as one volume? */
function mergeable(a: Segment, b: Segment): boolean {
  return (
    !a.glide &&
    !b.glide &&
    a.lo === b.lo &&
    a.hi === b.hi &&
    a.rnp === b.rnp &&
    a.rnpSrc === b.rnpSrc &&
    same(a.path[a.path.length - 1], b.path[0])
  );
}

export function simplify(proc: Procedure, transitions: Transition[]): SimplifiedProcedure {
  const seen = new Set<string>();
  const volumes: Tagged<Segment>[] = [];
  const tracks: Tagged<Segment>[] = [];

  for (const t of transitions) {
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
        const key = `${p.fix ?? `${p.lat},${p.lon}`}|${p.alt.k}|${p.alt.lo}|${p.alt.hi}`;
        if (!gates.has(key)) gates.set(key, { item: p, t });
      } else if (p.fix && !fixes.has(p.fix)) {
        fixes.set(p.fix, { item: p, t });
      }
    }
  }
  // a fix with a restriction somewhere doesn't also need a plain label
  const restricted = new Set([...gates.values()].map((g) => g.item.fix));
  return {
    volumes,
    tracks,
    gates: [...gates.values()],
    fixes: [...fixes.values()].filter((f) => !restricted.has(f.item.fix)),
  };
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
