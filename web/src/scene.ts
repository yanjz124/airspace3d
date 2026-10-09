import {
  ArcType,
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ColorMaterialProperty,
  CornerType,
  CustomDataSource,
  DistanceDisplayCondition,
  HeadingPitchRange,
  HorizontalOrigin,
  ImageMaterialProperty,
  ImageryLayer,
  LabelCollection,
  LabelStyle,
  Math as CesiumMath,
  NearFarScalar,
  PointPrimitiveCollection,
  PolygonHierarchy,
  PolylineArrowMaterialProperty,
  PolylineDashMaterialProperty,
  Rectangle,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  UrlTemplateImageryProvider,
  VerticalOrigin,
  Viewer,
} from "cesium";
import type {
  AirportFile,
  AirspaceFeature,
  IndexAirport,
  ProcPoint,
  Procedure,
  Segment,
  Transition,
} from "./types";
import { describeAirspace, describeTransition, formatAlt, formatSpeed } from "./describe";

const FT = 0.3048;
const NM = 1852;
/** How far an open-ended band (no published limit on one side) is drawn before it has faded out, in feet. */
const OPEN_FT = 1500;
/** Half-width used when a leg has no RNP value: purely a display width. */
const NOMINAL_HALF_NM = 0.3;
/** Thickness of the glidepath volume, in feet (before exaggeration). */
const GLIDE_THICK_FT = 100;

export const HOME = { lon: -73.95, lat: 40.68, range_m: 160_000, heading: 15, pitch: -32 };
const OVERVIEW = { lon: -97, lat: 38, height_m: 6_000_000 };

export const AIRSPACE_COLORS: Record<string, string> = {
  B: "#4e79a7",
  C: "#b07aa1",
  D: "#76b7b2",
  SUA: "#e15759",
};

export interface DisplayOptions {
  exaggeration: number;
  labels: boolean;
  /** 3D procedure volumes at their published altitude band */
  volumes: boolean;
  /** use RNAV 1 width for RNAV SIDs/STARs, whose legs carry no coded RNP */
  rnavSpec: boolean;
  classB: boolean;
  classC: boolean;
  classD: boolean;
  sua: boolean;
}

export interface ViewInfo {
  rect: Rectangle | undefined;
  center: { lon: number; lat: number } | undefined;
  height: number;
}

/** Decides what to draw: returns the transitions of a procedure to render. */
export type ProcFilter = (p: Procedure) => Transition[];
export type ColorFn = (p: Procedure) => string;

const esriTiles = (service: string, maximumLevel: number) =>
  new UrlTemplateImageryProvider({
    url: `https://services.arcgisonline.com/arcgis/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`,
    credit: "Esri, HERE, Garmin, © OpenStreetMap contributors",
    maximumLevel,
  });

/** Spherical destination point; returns [lon, lat]. */
function destination(lon: number, lat: number, brg: number, nm: number): [number, number] {
  const d = nm / 3440.065;
  const p1 = CesiumMath.toRadians(lat);
  const t = CesiumMath.toRadians(brg);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const dl = Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [lon + CesiumMath.toDegrees(dl), CesiumMath.toDegrees(p2)];
}

function bearing(a: [number, number], b: [number, number]): number {
  const p1 = CesiumMath.toRadians(a[1]);
  const p2 = CesiumMath.toRadians(b[1]);
  const dl = CesiumMath.toRadians(b[0] - a[0]);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (CesiumMath.toDegrees(Math.atan2(y, x)) + 360) % 360;
}

/** Left/right edges of a path offset by `half` NM, using the bisector at each vertex. */
function offsetEdges(path: [number, number][], half: number): [[number, number][], [number, number][]] {
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i < path.length; i++) {
    const bIn = i > 0 ? bearing(path[i - 1], path[i]) : bearing(path[i], path[i + 1]);
    const bOut = i < path.length - 1 ? bearing(path[i], path[i + 1]) : bIn;
    let turn = ((bOut - bIn + 540) % 360) - 180;
    const brg = bIn + turn / 2;
    // stretch at corners so the band keeps its width, capped for sharp turns
    const k = Math.min(1 / Math.max(Math.cos(CesiumMath.toRadians(turn / 2)), 0.5), 2);
    left.push(destination(path[i][0], path[i][1], brg - 90, half * k));
    right.push(destination(path[i][0], path[i][1], brg + 90, half * k));
  }
  return [left, right];
}

/** Vertical alpha gradients for wall textures (t = 0 at the bottom of a wall). */
function gradient(kind: "fadeUp" | "fadeDown"): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 256;
  const g = c.getContext("2d")!;
  // canvas y grows downwards; the wall's top maps to canvas y = 0
  const grad = g.createLinearGradient(0, 0, 0, 256);
  const solid = "rgba(255,255,255,1)";
  const clear = "rgba(255,255,255,0)";
  if (kind === "fadeUp") {
    grad.addColorStop(0, clear);
    grad.addColorStop(1, solid);
  } else {
    grad.addColorStop(0, solid);
    grad.addColorStop(1, clear);
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  return c;
}

export class AirspaceScene {
  readonly viewer: Viewer;
  private airspaceSrc = new CustomDataSource("airspace");
  private airports = new Map<string, { file: AirportFile; src: CustomDataSource }>();
  private airspace = new Map<string, AirspaceFeature>();
  private dots: PointPrimitiveCollection;
  private dotLabels: LabelCollection;
  private opts: DisplayOptions;
  private filter: ProcFilter = (p) => p.transitions;
  private colorOf: ColorFn = () => "#ffffff";
  private fadeUp = gradient("fadeUp");
  private fadeDown = gradient("fadeDown");
  onView?: (v: ViewInfo) => void;
  onAirportClick?: (id: string) => void;

  constructor(container: HTMLElement, opts: DisplayOptions) {
    this.opts = opts;
    this.viewer = new Viewer(container, {
      baseLayer: new ImageryLayer(esriTiles("Canvas/World_Dark_Gray_Base", 16)),
      baseLayerPicker: false,
      geocoder: false,
      timeline: false,
      animation: false,
      fullscreenButton: false,
      sceneModePicker: true,
      navigationHelpButton: true,
      navigationInstructionsInitiallyVisible: false,
      homeButton: true,
      infoBox: true,
      selectionIndicator: true,
    });
    this.viewer.imageryLayers.addImageryProvider(esriTiles("Canvas/World_Dark_Gray_Reference", 16));
    const scene = this.viewer.scene;
    scene.globe.baseColor = Color.fromCssColorString("#1b1d22");
    scene.globe.depthTestAgainstTerrain = false;
    scene.backgroundColor = Color.fromCssColorString("#101113");
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    scene.fog.enabled = false;
    scene.screenSpaceCameraController.enableCollisionDetection = false;

    this.viewer.dataSources.add(this.airspaceSrc);
    this.dots = scene.primitives.add(new PointPrimitiveCollection());
    this.dotLabels = scene.primitives.add(new LabelCollection());

    this.viewer.homeButton.viewModel.command.beforeExecute.addEventListener((e) => {
      e.cancel = true;
      this.viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(OVERVIEW.lon, OVERVIEW.lat, OVERVIEW.height_m) });
    });

    // clicking an airport dot flies there
    new ScreenSpaceEventHandler(scene.canvas).setInputAction((e: { position: Cartesian2 }) => {
      const picked = scene.pick(e.position);
      const id = picked?.primitive?.id;
      if (typeof id === "string" && id.startsWith("apt:")) this.onAirportClick?.(id.slice(4));
    }, ScreenSpaceEventType.LEFT_CLICK);

    const cam = new URLSearchParams(location.hash.slice(1)).get("cam");
    if (!cam || !this.setCameraString(cam)) this.flyTo(HOME.lon, HOME.lat, HOME.range_m, 0);
    this.viewer.camera.moveEnd.addEventListener(() => {
      const params = new URLSearchParams(location.hash.slice(1));
      params.set("cam", this.getCameraString());
      history.replaceState(null, "", `#${params.toString().replaceAll("%2C", ",")}`);
      this.onView?.(this.getView());
    });
  }

  destroy() {
    this.viewer.destroy();
  }

  // --- camera ---------------------------------------------------------------

  getView(): ViewInfo {
    const scene = this.viewer.scene;
    const camera = this.viewer.camera;
    const mid = new Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2);
    const hit = camera.pickEllipsoid(mid);
    let center;
    if (hit) {
      const c = Cartographic.fromCartesian(hit);
      center = { lon: CesiumMath.toDegrees(c.longitude), lat: CesiumMath.toDegrees(c.latitude) };
    }
    return { rect: camera.computeViewRectangle(), center, height: camera.positionCartographic.height };
  }

  getCameraString(): string {
    const c = this.viewer.camera;
    const g = c.positionCartographic;
    return [
      CesiumMath.toDegrees(g.longitude).toFixed(4),
      CesiumMath.toDegrees(g.latitude).toFixed(4),
      g.height.toFixed(0),
      CesiumMath.toDegrees(c.heading).toFixed(1),
      CesiumMath.toDegrees(c.pitch).toFixed(1),
    ].join(",");
  }

  setCameraString(s: string): boolean {
    const v = s.split(",").map(Number);
    if (v.length !== 5 || v.some((x) => !Number.isFinite(x))) return false;
    this.viewer.camera.setView({
      destination: Cartesian3.fromDegrees(v[0], v[1], v[2]),
      orientation: { heading: CesiumMath.toRadians(v[3]), pitch: CesiumMath.toRadians(v[4]), roll: 0 },
    });
    return true;
  }

  flyTo(lon: number, lat: number, range = 60_000, duration = 1.5) {
    this.viewer.camera.flyToBoundingSphere(new BoundingSphere(Cartesian3.fromDegrees(lon, lat), 1), {
      offset: new HeadingPitchRange(CesiumMath.toRadians(HOME.heading), CesiumMath.toRadians(HOME.pitch), range),
      duration,
    });
  }

  /** Feet MSL -> height in metres above the (sea-level) globe, with vertical exaggeration. */
  private h(ft: number) {
    return Math.max(0, ft) * FT * this.opts.exaggeration;
  }

  // --- options & data ---------------------------------------------------------

  setOptions(opts: DisplayOptions) {
    const prev = this.opts;
    this.opts = opts;
    const airspaceChanged =
      prev.classB !== opts.classB || prev.classC !== opts.classC || prev.classD !== opts.classD || prev.sua !== opts.sua;
    if (prev.exaggeration !== opts.exaggeration || airspaceChanged) this.renderAirspace();
    if (
      prev.exaggeration !== opts.exaggeration ||
      prev.labels !== opts.labels ||
      prev.volumes !== opts.volumes ||
      prev.rnavSpec !== opts.rnavSpec
    ) {
      this.renderAllAirports();
    }
  }

  setStyle(filter: ProcFilter, colorOf: ColorFn) {
    this.filter = filter;
    this.colorOf = colorOf;
    this.renderAllAirports();
  }

  /** Nationwide airport dots (cheap primitives); procedures are only drawn for active airports. */
  setIndex(airports: IndexAirport[]) {
    this.dots.removeAll();
    this.dotLabels.removeAll();
    for (const [id, , lon, lat, , sids, stars, iaps] of airports) {
      const big = sids + stars > 0;
      const position = Cartesian3.fromDegrees(lon, lat);
      this.dots.add({
        id: `apt:${id}`,
        position,
        pixelSize: big ? 6 : 4,
        color: Color.fromCssColorString(big ? "#e8e8e8" : "#9a9a9a").withAlpha(0.9),
        outlineColor: Color.BLACK,
        outlineWidth: 1,
      });
      this.dotLabels.add({
        position,
        text: id,
        font: "11px system-ui, sans-serif",
        fillColor: Color.fromCssColorString("#d0d0d0"),
        outlineColor: Color.BLACK,
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cartesian2(0, -10),
        verticalOrigin: VerticalOrigin.BOTTOM,
        distanceDisplayCondition: new DistanceDisplayCondition(0, big ? 900_000 : 150_000 + iaps * 10_000),
      });
    }
  }

  /** Replace the set of airports whose procedures are drawn. */
  setActiveAirports(files: AirportFile[]) {
    const want = new Set(files.map((f) => f.airport.id));
    for (const [id, a] of this.airports) {
      if (!want.has(id)) {
        this.viewer.dataSources.remove(a.src, true);
        this.airports.delete(id);
      }
    }
    for (const file of files) {
      if (this.airports.has(file.airport.id)) continue;
      const src = new CustomDataSource(file.airport.id);
      this.viewer.dataSources.add(src);
      this.airports.set(file.airport.id, { file, src });
      this.renderAirport(file, src);
    }
  }

  setAirspace(features: AirspaceFeature[]) {
    this.airspace = new Map(features.map((f) => [f.id, f]));
    this.renderAirspace();
  }

  // --- airspace ---------------------------------------------------------------

  private renderAirspace() {
    const ents = this.airspaceSrc.entities;
    ents.suspendEvents();
    ents.removeAll();
    const shown: Record<string, boolean> = { B: this.opts.classB, C: this.opts.classC, D: this.opts.classD };
    for (const f of this.airspace.values()) {
      if (f.id.startsWith("sua")) {
        if (this.opts.sua) this.addVolume(f, AIRSPACE_COLORS.SUA);
      } else {
        const cls = f.properties.CLASS ?? "";
        if (shown[cls]) this.addVolume(f, AIRSPACE_COLORS[cls] ?? "#999");
      }
    }
    ents.resumeEvents();
  }

  private addVolume(f: AirspaceFeature, css: string) {
    const p = f.properties;
    // Only volumes whose limits are published in MSL (or surface) can be placed without terrain.
    if (p.ceil_ft == null || p.ceil_ft < 0 || p.ceil_ref !== "MSL") return;
    if (p.floor_ref !== "SFC" && p.floor_ref !== "MSL") return;
    const floor = p.floor_ref === "SFC" ? 0 : (p.floor_ft ?? 0);
    const color = Color.fromCssColorString(css);
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    const name = `${p.NAME}${p.SECTOR ? ` — ${p.SECTOR}` : ""}`;
    const description = describeAirspace(p);
    const ents = this.airspaceSrc.entities;
    for (const rings of polys) {
      const [outer, ...holes] = rings.map((r) => Cartesian3.fromDegreesArray(r.flat()));
      ents.add({
        name,
        description,
        polygon: {
          hierarchy: new PolygonHierarchy(outer, holes.map((x) => new PolygonHierarchy(x))),
          height: this.h(floor),
          extrudedHeight: this.h(p.ceil_ft),
          material: new ColorMaterialProperty(color.withAlpha(0.06)),
        },
      });
      // Edges at floor and ceiling only; polygon outlines would add a vertical line per vertex.
      for (const ring of rings) {
        for (const ft of [floor, p.ceil_ft]) {
          ents.add({
            name,
            description,
            polyline: {
              positions: Cartesian3.fromDegreesArrayHeights(ring.flatMap(([lon, lat]) => [lon, lat, this.h(ft)])),
              width: 1.5,
              arcType: ArcType.NONE,
              material: color.withAlpha(0.7),
            },
          });
        }
      }
    }
  }

  // --- airports & procedures ----------------------------------------------------

  private renderAllAirports() {
    for (const { file, src } of this.airports.values()) this.renderAirport(file, src);
  }

  private renderAirport(file: AirportFile, src: CustomDataSource) {
    const ents = src.entities;
    ents.suspendEvents();
    ents.removeAll();
    const a = file.airport;
    for (const r of a.runways) {
      if (r.ends.length < 2) continue;
      ents.add({
        name: `${a.id} RWY ${r.id}`,
        polyline: {
          positions: r.ends.map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat)),
          width: 3,
          clampToGround: true,
          material: Color.WHITE.withAlpha(0.85),
        },
      });
    }
    for (const proc of file.procedures) {
      const ts = this.filter(proc);
      if (!ts.length) continue;
      const color = Color.fromCssColorString(this.colorOf(proc));
      for (const t of ts) this.addTransition(src, proc, t, color);
    }
    ents.resumeEvents();
  }

  private halfWidth(s: { rnp?: number; rnpSrc?: string }): number {
    if (s.rnp && (s.rnpSrc === "coded" || this.opts.rnavSpec)) return s.rnp;
    return NOMINAL_HALF_NM;
  }

  private addTransition(src: CustomDataSource, proc: Procedure, t: Transition, color: Color) {
    const ents = src.entities;
    const title = `${proc.airport} ${proc.id}${t.name ? ` · ${t.name}` : ""}${t.kind === "missed" ? " · missed approach" : ""}`;
    const description = describeTransition(proc, t);
    const common = { name: title, description };
    const missed = t.kind === "missed";

    // ground track (shadow)
    for (const path of t.path) {
      ents.add({
        ...common,
        polyline: {
          positions: path.map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat)),
          width: missed ? 1 : 1.5,
          clampToGround: true,
          material: missed
            ? new PolylineDashMaterialProperty({ color: color.withAlpha(0.4), dashLength: 12 })
            : color.withAlpha(0.45),
        },
      });
    }

    if (this.opts.volumes) {
      for (const s of t.segments) this.addSegmentVolume(src, s, color.withAlpha(missed ? 0.6 : 1), common);
    }

    t.points.forEach((p) => {
      if (p.lat == null || p.lon == null) return;
      if (p.alt) this.addGate(src, p, color, common);
      else if (p.fix && this.opts.labels) {
        ents.add({
          ...common,
          position: Cartesian3.fromDegrees(p.lon, p.lat),
          point: { pixelSize: 4, color: color.withAlpha(0.8), disableDepthTestDistance: Number.POSITIVE_INFINITY },
          label: this.fixLabel(p.fix, 40_000),
        });
      }
    });
  }

  /**
   * A leg drawn at its legal altitude band: side walls plus a floor and/or ceiling
   * where a limit is published. A side without a published limit fades out.
   */
  private addSegmentVolume(src: CustomDataSource, s: Segment, color: Color, common: object) {
    const ents = src.entities;
    const half = this.halfWidth(s);

    if (s.glide) {
      // published vertical path: draw the actual sloped path as a flat box section
      const w = half * NM;
      const th = (GLIDE_THICK_FT * FT * this.opts.exaggeration) / 2;
      ents.add({
        ...common,
        polylineVolume: {
          positions: s.glide.map(([lon, lat, ft]) => Cartesian3.fromDegrees(lon, lat, this.h(ft))),
          shape: [new Cartesian2(-w, -th), new Cartesian2(w, -th), new Cartesian2(w, th), new Cartesian2(-w, th)],
          material: color.withAlpha(0.35),
          outline: true,
          outlineColor: color.withAlpha(0.8),
        },
      });
      return;
    }
    if (s.lo == null && s.hi == null) return; // nothing published: track only

    const bottom = s.lo ?? s.hi! - OPEN_FT;
    const top = s.hi ?? s.lo! + OPEN_FT;
    const fade = s.hi == null ? this.fadeUp : s.lo == null ? this.fadeDown : undefined;
    const wallMaterial = fade
      ? new ImageMaterialProperty({ image: fade, transparent: true, color: color.withAlpha(0.3) })
      : color.withAlpha(0.18);
    for (const edge of offsetEdges(s.path, half)) {
      ents.add({
        ...common,
        wall: {
          positions: Cartesian3.fromDegreesArray(edge.flat()),
          minimumHeights: edge.map(() => this.h(bottom)),
          maximumHeights: edge.map(() => this.h(top)),
          material: wallMaterial,
        },
      });
    }
    // published limits as solid planes with outlined edges
    for (const ft of [s.lo, s.hi]) {
      if (ft == null) continue;
      ents.add({
        ...common,
        corridor: {
          positions: s.path.map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat)),
          width: 2 * half * NM,
          height: this.h(ft),
          cornerType: CornerType.MITERED,
          material: color.withAlpha(0.14),
          outline: true,
          outlineColor: color.withAlpha(0.85),
        },
      });
    }
  }

  /** Restriction at a fix: dot(s) at the limit with a label; arrows when volumes are hidden. */
  private addGate(src: CustomDataSource, p: ProcPoint, color: Color, common: object) {
    const ents = src.entities;
    const a = p.alt!;
    const at = (ft: number) => Cartesian3.fromDegrees(p.lon!, p.lat!, this.h(ft));
    const base = a.k === "below" ? a.hi! - OPEN_FT : (a.lo ?? 0);

    ents.add({
      ...common,
      polyline: {
        positions: [Cartesian3.fromDegrees(p.lon!, p.lat!), at(base)],
        width: 1,
        arcType: ArcType.NONE,
        material: new PolylineDashMaterialProperty({ color: color.withAlpha(0.35), dashLength: 8 }),
      },
    });

    if (!this.opts.volumes) {
      if (a.k === "between") {
        ents.add({ ...common, polyline: { positions: [at(a.lo!), at(a.hi!)], width: 5, arcType: ArcType.NONE, material: color } });
      } else if (a.k !== "at") {
        const from = a.k === "above" ? a.lo! : a.hi!;
        const to = a.k === "above" ? from + OPEN_FT : from - OPEN_FT;
        ents.add({
          ...common,
          polyline: {
            positions: [at(from), at(to)],
            width: 10,
            arcType: ArcType.NONE,
            material: new PolylineArrowMaterialProperty(color.withAlpha(0.9)),
          },
        });
      }
    } else if (p.trk != null) {
      this.addWindow(src, p, color, common);
    }

    const marks = a.k === "between" ? [a.lo!, a.hi!] : a.k === "below" ? [a.hi!] : [a.lo!];
    marks.forEach((ft, i) => {
      const top = i === marks.length - 1;
      ents.add({
        ...common,
        position: at(ft),
        point: {
          pixelSize: a.k === "at" ? 9 : 7,
          color,
          outlineColor: Color.BLACK,
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label:
          top && this.opts.labels
            ? this.fixLabel(`${p.fix ?? ""}  ${formatAlt(a)}${p.spd ? `  ${formatSpeed(p.spd)}` : ""}`, 90_000)
            : undefined,
      });
    });
  }

  /** Window across the band at a restricted fix; the open side of at-or-above/below fades. */
  private addWindow(src: CustomDataSource, p: ProcPoint, color: Color, common: object) {
    const a = p.alt!;
    const half = this.halfWidth(p);
    const [l, r] = [-90, 90].map((d) => destination(p.lon!, p.lat!, p.trk! + d, half));
    let span: [number, number];
    let image: HTMLCanvasElement | undefined;
    if (a.k === "between") span = [a.lo!, a.hi!];
    else if (a.k === "above") [span, image] = [[a.lo!, a.lo! + OPEN_FT], this.fadeUp];
    else if (a.k === "below") [span, image] = [[a.hi! - OPEN_FT, a.hi!], this.fadeDown];
    else {
      src.entities.add({
        ...common,
        polyline: {
          positions: Cartesian3.fromDegreesArrayHeights([...l, this.h(a.lo!), ...r, this.h(a.lo!)]),
          width: 4,
          arcType: ArcType.NONE,
          material: color,
        },
      });
      return;
    }
    src.entities.add({
      ...common,
      wall: {
        positions: Cartesian3.fromDegreesArray([...l, ...r]),
        minimumHeights: [this.h(span[0]), this.h(span[0])],
        maximumHeights: [this.h(span[1]), this.h(span[1])],
        material: image
          ? new ImageMaterialProperty({ image, transparent: true, color: color.withAlpha(0.6) })
          : color.withAlpha(0.35),
      },
    });
  }

  private fixLabel(text: string, maxDistance: number) {
    return {
      text,
      font: "12px system-ui, sans-serif",
      fillColor: Color.WHITE,
      outlineColor: Color.BLACK,
      outlineWidth: 3,
      style: LabelStyle.FILL_AND_OUTLINE,
      horizontalOrigin: HorizontalOrigin.LEFT,
      verticalOrigin: VerticalOrigin.CENTER,
      pixelOffset: new Cartesian2(8, 0),
      distanceDisplayCondition: new DistanceDisplayCondition(0, maxDistance),
      scaleByDistance: new NearFarScalar(5_000, 1.0, maxDistance, 0.75),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    };
  }
}
