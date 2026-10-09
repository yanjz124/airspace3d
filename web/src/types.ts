export type ProcType = "SID" | "STAR" | "IAP";

export interface AltRestriction {
  k: "at" | "above" | "below" | "between";
  lo?: number;
  hi?: number;
  gs?: number;
  code: string;
}

export interface SpeedRestriction {
  k: "at" | "above" | "below";
  kt: number;
}

export interface ProcPoint {
  seq: number;
  pt: string;
  fix?: string;
  lat?: number;
  lon?: number;
  alt?: AltRestriction;
  spd?: SpeedRestriction;
  flags?: string[];
  vpa?: number;
  note?: string;
  /** NM; "coded" in CIFP, or "spec" = RNAV 1 from the charted navigation specification */
  rnp?: number;
  rnpSrc?: "coded" | "spec";
  /** true track at the fix, degrees */
  trk?: number;
  hold?: { inbound: number; true: boolean; turn: string; nm?: number; min?: number };
}

export interface Transition {
  kind: "runway" | "common" | "enroute" | "approach" | "final" | "missed";
  name: string;
  routeType: string;
  path: [number, number][][];
  points: ProcPoint[];
  corridors: { rnp: number; src: "coded" | "spec"; path: [number, number][] }[];
}

export interface Procedure {
  airport: string;
  type: ProcType;
  id: string;
  approachType?: string;
  transitions: Transition[];
}

export interface Runway {
  id: string;
  ends: [number, number, number | null][];
}

export interface Airport {
  id: string;
  name: string;
  lon: number;
  lat: number;
  elev: number | null;
  magvar: number | null;
  runways: Runway[];
}

export interface MetroConfig {
  id: string;
  name: string;
  airports: string[];
  bbox: [number, number, number, number];
  view: { lon: number; lat: number; range_m: number; heading: number; pitch: number };
  geoid_m: number;
}

export interface ProcedureBundle {
  meta: { cycle: string; effective: string; source: string; built: string };
  metro: MetroConfig;
  airports: Airport[];
  procedures: Procedure[];
}

export interface AirspaceProps {
  NAME: string;
  CLASS?: string;
  TYPE_CODE?: string;
  SECTOR?: string;
  floor_ft: number | null;
  floor_ref: string | null;
  ceil_ft: number | null;
  ceil_ref: string | null;
  [k: string]: unknown;
}

export interface AirspaceBundle {
  class: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, AirspaceProps>;
  sua: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, AirspaceProps>;
}

export const procKey = (p: Pick<Procedure, "airport" | "type" | "id">) => `${p.airport}/${p.type}/${p.id}`;
