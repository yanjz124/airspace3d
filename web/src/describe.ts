// HTML shown in Cesium's InfoBox. Cesium sanitizes descriptions; keep to plain tables.
import type { AirspaceProps, AltRestriction, Procedure, SpeedRestriction, Transition } from "./types";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function formatAlt(a: AltRestriction): string {
  switch (a.k) {
    case "above":
      return `${a.lo}A`;
    case "below":
      return `${a.hi}B`;
    case "between":
      return `${a.lo}–${a.hi}`;
    default:
      return `${a.lo}`;
  }
}

export function formatSpeed(s: SpeedRestriction): string {
  return s.k === "below" ? `≤${s.kt}K` : s.k === "above" ? `≥${s.kt}K` : `${s.kt}K`;
}

const ALT_TEXT: Record<AltRestriction["k"], string> = {
  at: "at",
  above: "at or above",
  below: "at or below",
  between: "between",
};

const KIND_TEXT: Record<Transition["kind"], string> = {
  runway: "Runway transition",
  common: "Common route",
  enroute: "Enroute transition",
  approach: "Approach transition",
  final: "Final approach",
  missed: "Missed approach",
};

export function describeTransition(proc: Procedure, t: Transition): string {
  const rows = t.points
    .map((p) => {
      const alt = p.alt
        ? `${ALT_TEXT[p.alt.k]} ${formatAlt(p.alt)}${p.alt.gs != null ? ` (GS ${p.alt.gs})` : ""}`
        : "";
      const extra = [p.flags?.join(", "), p.vpa ? `VPA ${p.vpa}°` : "", p.note, holdText(p.hold)]
        .filter(Boolean)
        .join(" · ");
      return `<tr><td>${esc(p.fix ?? "")}</td><td>${p.pt}</td><td>${alt}</td><td>${p.spd ? formatSpeed(p.spd) : ""}</td><td>${esc(extra)}</td></tr>`;
    })
    .join("");
  const type = proc.type === "IAP" ? `${proc.approachType ?? "Approach"}` : proc.type;
  return `<p>${type} · ${KIND_TEXT[t.kind]}${t.name ? ` <b>${esc(t.name)}</b>` : ""}</p>
<table class="cesium-infoBox-defaultTable"><thead><tr><th>Fix</th><th>Leg</th><th>Altitude</th><th>Speed</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table>
<p style="opacity:.7">Source: FAA CIFP. Only published restrictions are shown; legs without a defined end point are not drawn.</p>`;
}

function holdText(h: Transition["points"][number]["hold"]): string {
  if (!h) return "";
  const len = h.nm ? `${h.nm} NM legs` : h.min ? `${h.min} min legs` : "";
  return `hold ${h.inbound.toFixed(0).padStart(3, "0")}°${h.true ? "T" : ""} inbound, ${h.turn === "L" ? "left" : "right"} turns${len ? `, ${len}` : ""}`;
}

const limit = (ft: number | null, ref: string | null) =>
  ref === "SFC" ? "SFC" : ft == null ? "?" : ft >= 18000 ? `FL${ft / 100}` : `${ft} ${ref ?? ""}`.trim();

export function describeAirspace(p: AirspaceProps): string {
  const kind = p.CLASS ? `Class ${p.CLASS}` : `${p.TYPE_CODE ?? ""}`;
  const rows: [string, string][] = [
    ["Type", kind],
    ["Floor", limit(p.floor_ft, p.floor_ref)],
    ["Ceiling", limit(p.ceil_ft, p.ceil_ref)],
  ];
  if (p.SECTOR) rows.push(["Sector", String(p.SECTOR)]);
  if (p.TIMESOFUSE) rows.push(["Times of use", String(p.TIMESOFUSE)]);
  if (p.CONT_AGENT) rows.push(["Controlling agency", String(p.CONT_AGENT)]);
  return `<table class="cesium-infoBox-defaultTable">${rows
    .map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`)
    .join("")}</table><p style="opacity:.7">Source: FAA AIS Open Data</p>`;
}
