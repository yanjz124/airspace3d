import type { TreeNodeData } from "@mantine/core";
import type { AirportFile, ProcType, Procedure, Transition } from "./types";
import { procKey, transKey } from "./types";

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

function matches(p: Procedure, q: string): boolean {
  if (!q) return true;
  const s = q.toUpperCase();
  return p.id.includes(s) || p.transitions.some((t) => t.name.includes(s) || t.points.some((x) => x.fix === s));
}

/** Leaf keys of one procedure: its transitions, or the procedure itself when it has only one. */
export function procLeaves(p: Procedure): string[] {
  return p.transitions.length > 1 ? p.transitions.map((_, i) => transKey(p, i)) : [procKey(p)];
}

/** Airport -> type -> procedure -> transition, for the airports currently loaded. */
export function buildTree(files: AirportFile[], types: Record<ProcType, boolean>, query: string): TreeNodeData[] {
  return files
    .map(({ airport: a, procedures }) => {
      const children = (["SID", "STAR", "IAP"] as ProcType[])
        .filter((type) => types[type])
        .map((type) => {
          const procs = procedures.filter((p) => p.type === type && matches(p, query));
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
      return { value: a.id, label: a.id, nodeProps: { name: a.name }, children };
    })
    .filter((n) => n.children.length > 0);
}
