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
  hold?: { inbound: number; true: boolean; turn: string; nm?: number; min?: number };
  /** NM; "coded" in CIFP, or "spec" = RNAV 1 from the charted navigation specification */
  rnp?: number;
  rnpSrc?: "coded" | "spec";
  /** true track at the fix, degrees */
  trk?: number;
}

/**
 * One drawn leg with its legal altitude band (feet MSL), derived from published
 * restrictions only. null = no published limit on that side.
 */
export interface Segment {
  path: [number, number][];
  lo: number | null;
  hi: number | null;
  rnp?: number;
  rnpSrc?: "coded" | "spec";
  /** [lon, lat, ft] along a published vertical path (glideslope / VPA) */
  glide?: [number, number, number][];
}

export interface Transition {
  kind: "runway" | "common" | "enroute" | "approach" | "final" | "missed";
  name: string;
  routeType: string;
  path: [number, number][][];
  points: ProcPoint[];
  segments: Segment[];
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

export interface AirportFile {
  airport: Airport;
  procedures: Procedure[];
}

/** [id, name, lon, lat, elev, sids, stars, iaps] */
export type IndexAirport = [string, string, number, number, number, number, number, number];

export interface DataIndex {
  cycle: string;
  effective: string;
  built: string;
  airports: IndexAirport[];
  airspaceTileDeg: number;
  airspaceTiles: string[];
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

export type AirspaceFeature = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon, AirspaceProps> & { id: string };

export interface AirspaceTile {
  class: AirspaceFeature[];
  sua: AirspaceFeature[];
}

export const procKey = (p: Pick<Procedure, "airport" | "type" | "id">) => `${p.airport}/${p.type}/${p.id}`;
export const transKey = (p: Procedure, i: number) => `${procKey(p)}/${i}`;
