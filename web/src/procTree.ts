import type { TreeNodeData } from "@mantine/core";
import type { ProcType, Procedure, ProcedureBundle, Transition } from "./types";
import { procKey } from "./types";

export const TYPE_LABEL: Record<ProcType, string> = {
  SID: "Departures",
  STAR: "Arrivals",
  IAP: "Approaches",
};

const KIND_LABEL: Record<Transition["kind"], string> = {
  runway: "Runway",
  common: "Common route",
  enroute: "Enroute",
  approach: "Transition",
  final: "Final",
  missed: "Missed approach",
};

export function transitionLabel(t: Transition): string {
  return t.name ? `${KIND_LABEL[t.kind]} ${t.name}` : KIND_LABEL[t.kind];
}

const transKey = (p: Procedure, i: number) => `${procKey(p)}/${i}`;

function matches(p: Procedure, q: string): boolean {
  if (!q) return true;
  const s = q.toUpperCase();
  return p.id.includes(s) || p.transitions.some((t) => t.name.includes(s) || t.points.some((x) => x.fix === s));
}

/** Airport -> type -> procedure -> transition. Procedures with a single transition are leaves. */
export function buildTree(bundle: ProcedureBundle, query: string): TreeNodeData[] {
  return bundle.airports
    .map((a) => {
      const types = (["SID", "STAR", "IAP"] as ProcType[])
        .map((type) => {
          const procs = bundle.procedures.filter((p) => p.airport === a.id && p.type === type && matches(p, query));
          return {
            value: `${a.id}/${type}`,
            label: `${TYPE_LABEL[type]} (${procs.length})`,
            children: procs.map((p) => ({
              value: procKey(p),
              label: p.type === "IAP" && p.approachType ? `${p.id} · ${p.approachType}` : p.id,
              children:
                p.transitions.length > 1
                  ? p.transitions.map((t, i) => ({ value: transKey(p, i), label: transitionLabel(t) }))
                  : undefined,
            })),
          };
        })
        .filter((n) => n.children.length > 0);
      return { value: a.id, label: a.id, nodeProps: { name: a.name }, children: types };
    })
    .filter((n) => n.children.length > 0);
}

/** All leaf values below the given node prefixes. */
export function leavesUnder(bundle: ProcedureBundle, prefixes: string[]): string[] {
  const out: string[] = [];
  for (const p of bundle.procedures) {
    const k = procKey(p);
    if (!prefixes.some((pre) => k === pre || k.startsWith(`${pre}/`))) continue;
    if (p.transitions.length > 1) p.transitions.forEach((_, i) => out.push(transKey(p, i)));
    else out.push(k);
  }
  return out;
}

/** Map checked leaf values to the transitions to draw, per procedure. */
export function selectedTransitions(bundle: ProcedureBundle, checked: string[]): Map<Procedure, Transition[]> {
  const set = new Set(checked);
  const out = new Map<Procedure, Transition[]>();
  for (const p of bundle.procedures) {
    const ts =
      p.transitions.length > 1
        ? p.transitions.filter((_, i) => set.has(transKey(p, i)))
        : set.has(procKey(p))
          ? p.transitions
          : [];
    if (ts.length) out.set(p, ts);
  }
  return out;
}
