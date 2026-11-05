import {
  ArcType,
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  CameraEventType,
  Cartographic,
  Color,
  ColorMaterialProperty,
  CornerType,
  CustomDataSource,
  DistanceDisplayCondition,
  Entity,
  HeadingPitchRange,
  HorizontalOrigin,
  ImageMaterialProperty,
  ImageryLayer,
  KeyboardEventModifier,
  LabelCollection,
  LabelStyle,
  Matrix4,
  Math as CesiumMath,
  NearFarScalar,
  PolygonHierarchy,
  PolylineDashMaterialProperty,
  Rectangle,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Transforms,
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
import { procKey } from "./types";
import { describeAirspace, describeTransition, formatAlt, formatSpeed } from "./describe";
import { newDrawn, simplify, type Drawn } from "./simplify";

const FT = 0.3048;
const NM = 1852;
/** How far an open-ended band (no published limit on one side) is drawn before it has faded out, in feet. */
const OPEN_FT = 1500;
/** Half-width used when a leg has no RNP value: purely a display width. */
const NOMINAL_HALF_NM = 0.3;
/** Thickness of the glidepath volume, in feet (before exaggeration). */
const GLIDE_THICK_FT = 100;
/** Unrestricted fixes are shown only within this camera distance (m). */
const FIX_DISTANCE_M = 40_000;
/** Camera distance (m) up to which airport labels are shown, by surface airspace class. */
const AIRPORT_LABEL_M: Record<string, number> = { B: 3_000_000, C: 500_000, D: 150_000, "E/G": 60_000 };

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
  /** NM from the airport beyond which procedure legs are cut off; null = no limit */
  rangeNm: number | null;
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

/** Scale a color's existing alpha, so a faded color stays faded through every material. */
const fa = (c: Color, a: number) => c.withAlpha(c.alpha * a);

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
  /** entities drawn for each airspace feature, so view changes only add/remove the difference */
  private airspaceEnts = new Map<string, Entity[]>();
  private dotIndex: IndexAirport[] = [];
  private dotFilter: (a: IndexAirport) => boolean = () => true;
  private dotLabels: LabelCollection;
  private opts: DisplayOptions;
  private filter: ProcFilter = (p) => p.transitions;
  private colorOf: ColorFn = () => "#ffffff";
  private fadeUp = gradient("fadeUp");
  private fadeDown = gradient("fadeDown");
  onView?: (v: ViewInfo) => void;
  onAirportClick?: (id: string) => void;
  /** a procedure was clicked in the scene (undefined = empty space) */
  onProcedureClick?: (key: string | undefined) => void;
  /** procedure drawn in full while all others are reduced to faint ground tracks */
  private focus?: string;

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
    // keep the camera above the surface
    scene.screenSpaceCameraController.enableCollisionDetection = true;
    scene.screenSpaceCameraController.minimumZoomDistance = 200;
    // middle-drag orbits around the point under the cursor (see orbitAtCursor); Ctrl+drag keeps Cesium's tilt
    scene.screenSpaceCameraController.tiltEventTypes = [
      { eventType: CameraEventType.LEFT_DRAG, modifier: KeyboardEventModifier.CTRL },
      { eventType: CameraEventType.RIGHT_DRAG, modifier: KeyboardEventModifier.CTRL },
    ];
    this.orbitAtCursor();
    // keep the horizon level whatever the controls do
    this.viewer.camera.percentageChanged = 0.001;
    this.viewer.camera.changed.addEventListener(() => this.levelHorizon());
    this.viewer.camera.moveEnd.addEventListener(() => this.levelHorizon());

    this.viewer.dataSources.add(this.airspaceSrc);
    this.dotLabels = scene.primitives.add(new LabelCollection());

    this.viewer.homeButton.viewModel.command.beforeExecute.addEventListener((e) => {
      e.cancel = true;
      this.viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(OVERVIEW.lon, OVERVIEW.lat, OVERVIEW.height_m) });
    });

    // clicking an airport dot flies there
    new ScreenSpaceEventHandler(scene.canvas).setInputAction((e: { position: Cartesian2 }) => {
      // an airport code can sit inside its airspace volume, so look under the top hit too
      const apt = scene
        .drillPick(e.position, 4)
        .map((x) => x?.id ?? x?.primitive?.id)
        .find((x) => typeof x === "string" && x.startsWith("apt:"));
      if (apt) {
        this.onAirportClick?.(apt.slice(4));
        return;
      }
      const picked = scene.pick(e.position);
      const id = picked?.id ?? picked?.primitive?.id;
      if (id instanceof Entity) {
        const key = id.properties?.proc?.getValue();
        if (typeof key === "string") this.onProcedureClick?.(key);
      } else if (!picked) this.onProcedureClick?.(undefined);
    }, ScreenSpaceEventType.LEFT_CLICK);

    const cam = new URLSearchParams(location.hash.slice(1)).get("cam");
    if (!cam || !this.setCameraString(cam)) this.flyTo(HOME.lon, HOME.lat, HOME.range_m, 0);
    // Cesium fires moveStart/moveEnd for sub-metre jitter while idle; only react to real moves
    let lastCam = "";
    this.viewer.camera.moveEnd.addEventListener(() => {
      const cam = this.getCameraString();
      if (cam === lastCam) return;
      lastCam = cam;
      const params = new URLSearchParams(location.hash.slice(1));
      params.set("cam", cam);
      history.replaceState(null, "", `#${params.toString().replaceAll("%2C", ",")}`);
      this.onView?.(this.getView());
    });
  }

  destroy() {
    this.viewer.destroy();
  }

  private levelHorizon() {
    const camera = this.viewer.camera;
    if (Math.abs(camera.roll) > 1e-4 && Math.abs(camera.roll - 2 * Math.PI) > 1e-4) {
      camera.setView({ orientation: { heading: camera.heading, pitch: camera.pitch, roll: 0 } });
    }
  }

  /** Middle-drag: rotate (left/right) and tilt (up/down) around the ground point under the cursor. */
  private orbitAtCursor() {
    const scene = this.viewer.scene;
    const camera = this.viewer.camera;
    const handler = new ScreenSpaceEventHandler(scene.canvas);
    let pivot: Cartesian3 | undefined;
    let last: Cartesian2 | undefined;
    const RAD_PER_PX = 0.005;

    handler.setInputAction((e: { position: Cartesian2 }) => {
      // pivot on the ground under the cursor, or under the screen center when the cursor is on the sky
      const center = new Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2);
      pivot = camera.pickEllipsoid(e.position) ?? camera.pickEllipsoid(center) ?? undefined;
      last = e.position.clone();
    }, ScreenSpaceEventType.MIDDLE_DOWN);
    handler.setInputAction(() => {
      if (pivot) camera.moveEnd.raiseEvent();
      pivot = last = undefined;
    }, ScreenSpaceEventType.MIDDLE_UP);
    handler.setInputAction((e: { endPosition: Cartesian2 }) => {
      if (!pivot || !last) return;
      const dx = e.endPosition.x - last.x;
      const dy = e.endPosition.y - last.y;
      last = e.endPosition.clone();

      const before = { position: camera.position.clone(), direction: camera.direction.clone(), up: camera.up.clone() };
      // rotate in a local east-north-up frame centred on the pivot
      const axis = camera.constrainedAxis;
      camera.lookAtTransform(Transforms.eastNorthUpToFixedFrame(pivot));
      camera.constrainedAxis = Cartesian3.UNIT_Z; // local up: tilting never changes heading
      camera.rotateLeft(dx * RAD_PER_PX);
      camera.rotateUp(-dy * RAD_PER_PX); // drag up = tilt toward the horizon
      camera.lookAtTransform(Matrix4.IDENTITY);
      camera.constrainedAxis = axis;
      this.levelHorizon();

      // never look above the horizon or end up below the surface
      if (camera.pitch > CesiumMath.toRadians(-2) || camera.positionCartographic.height < 100) {
        camera.setView({ destination: before.position, orientation: { direction: before.direction, up: before.up } });
      }
    }, ScreenSpaceEventType.MOUSE_MOVE);
  }

  // --- camera ---------------------------------------------------------------

  getView(): ViewInfo {
    const scene = this.viewer.scene;
    const camera = this.viewer.camera;
    const w = scene.canvas.clientWidth;
    const hgt = scene.canvas.clientHeight;
    // ground at the screen center; near the horizon fall back to lower on screen, then to below the camera
    const hit = camera.pickEllipsoid(new Cartesian2(w / 2, hgt / 2)) ?? camera.pickEllipsoid(new Cartesian2(w / 2, hgt * 0.85));
    const c = hit ? Cartographic.fromCartesian(hit) : camera.positionCartographic;
    const center = { lon: CesiumMath.toDegrees(c.longitude), lat: CesiumMath.toDegrees(c.latitude) };
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
      prev.rnavSpec !== opts.rnavSpec ||
      prev.rangeNm !== opts.rangeNm
    ) {
      this.renderAllAirports();
    }
  }

  /** What to draw, in which color, and which procedure (if any) is focused; redraws once. */
  setStyle(filter: ProcFilter, colorOf: ColorFn, focus?: string) {
    this.filter = filter;
    this.colorOf = colorOf;
    this.focus = focus;
    const sel = this.viewer.selectedEntity;
    const selName = sel?.name;
    const selProc = sel?.properties?.proc?.getValue();
    this.renderAllAirports();
    // re-rendering replaces the entities; keep the info panel on the same item
    if (sel && selProc) {
      const ents = [...this.airports.values()].flatMap((a) => a.src.entities.values);
      const same = ents.filter((e) => e.properties?.proc?.getValue() === selProc);
      this.viewer.selectedEntity = same.find((e) => e.name === selName) ?? same.find((e) => e.description);
    }
  }


  /** Nationwide airport codes (cheap primitives); procedures are only drawn for active airports. */
  setIndex(airports: IndexAirport[]) {
    this.dotIndex = airports;
    this.renderDots();
  }

  /** Show only airports passing the filter (rebuilt rather than hidden, so hidden ones cost nothing). */
  setAirportFilter(include: (a: IndexAirport) => boolean) {
    this.dotFilter = include;
    this.renderDots();
  }

  private renderDots() {
    this.dotLabels.removeAll();
    for (const a of this.dotIndex) {
      if (!this.dotFilter(a)) continue;
      const [id, , lon, lat, , , , , cls] = a;
      const big = cls === "B" || cls === "C";
      const position = Cartesian3.fromDegrees(lon, lat);
      // no dot: the code itself is the marker and the click target
      this.dotLabels.add({
        id: `apt:${id}`,
        position,
        text: id,
        font: big ? "600 12px system-ui, sans-serif" : "11px system-ui, sans-serif",
        fillColor: Color.fromCssColorString(big ? "#e8e8e8" : "#a8a8a8"),
        outlineColor: Color.BLACK,
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.CENTER,
        horizontalOrigin: HorizontalOrigin.CENTER,
        distanceDisplayCondition: new DistanceDisplayCondition(0, AIRPORT_LABEL_M[cls]),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
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
    const ents = this.airspaceSrc.entities;
    ents.suspendEvents();
    for (const [id, list] of this.airspaceEnts) {
      if (this.airspace.has(id)) continue;
      for (const e of list) ents.remove(e);
      this.airspaceEnts.delete(id);
    }
    for (const f of this.airspace.values()) if (!this.airspaceEnts.has(f.id)) this.addAirspaceFeature(f);
    ents.resumeEvents();
  }

  // --- airspace ---------------------------------------------------------------

  private renderAirspace() {
    const ents = this.airspaceSrc.entities;
    ents.suspendEvents();
    ents.removeAll();
    this.airspaceEnts.clear();
    for (const f of this.airspace.values()) this.addAirspaceFeature(f);
    ents.resumeEvents();
  }

  private addAirspaceFeature(f: AirspaceFeature) {
    const out: Entity[] = [];
    this.airspaceEnts.set(f.id, out);
    if (f.id.startsWith("sua")) {
      if (this.opts.sua) this.addVolume(f, AIRSPACE_COLORS.SUA, out);
    } else {
      const cls = f.properties.CLASS ?? "";
      const shown: Record<string, boolean> = { B: this.opts.classB, C: this.opts.classC, D: this.opts.classD };
      if (shown[cls]) this.addVolume(f, AIRSPACE_COLORS[cls] ?? "#999", out);
    }
  }

  private addVolume(f: AirspaceFeature, css: string, out: Entity[]) {
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
      out.push(ents.add({
        name,
        description,
        polygon: {
          hierarchy: new PolygonHierarchy(outer, holes.map((x) => new PolygonHierarchy(x))),
          height: this.h(floor),
          extrudedHeight: this.h(p.ceil_ft),
          material: new ColorMaterialProperty(color.withAlpha(0.06)),
        },
      }));
      // Edges at floor and ceiling only; polygon outlines would add a vertical line per vertex.
      for (const ring of rings) {
        for (const [ft, alpha] of [[floor, 0.18], [p.ceil_ft, 0.55]] as const) {
          out.push(ents.add({
            name,
            description,
            polyline: {
              positions: Cartesian3.fromDegreesArrayHeights(ring.flatMap(([lon, lat]) => [lon, lat, this.h(ft)])),
              width: 1.5,
              arcType: ArcType.NONE,
              material: color.withAlpha(alpha),
            },
          }));
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
          material: Color.WHITE.withAlpha(0.85),
        },
      });
    }
    // shared across this airport's procedures so common legs and labels are drawn once
    const drawn = newDrawn();
    const lines = newDrawn(true);
    const ghosts = newDrawn();
    this.origin = [a.lon, a.lat];
    for (const proc of file.procedures) {
      const ts = this.filter(proc);
      if (!ts.length) continue;
      const color = Color.fromCssColorString(this.colorOf(proc));
      if (this.focus && procKey(proc) !== this.focus) this.addGhost(src, proc, ts, color, ghosts);
      else this.addProcedure(src, proc, ts, color, drawn, lines);
    }
    ents.resumeEvents();
  }

  private halfWidth(s: { rnp?: number; rnpSrc?: string }): number {
    if (s.rnp && (s.rnpSrc === "coded" || this.opts.rnavSpec)) return s.rnp;
    return NOMINAL_HALF_NM;
  }

  /** Context for a focused procedure: every other procedure as a faint ground track only. */
  /** airport whose procedures are being drawn, for the fade-out range */
  private origin: [number, number] = [0, 0];

  /** Distance from the airport being drawn, NM (flat-earth approximation, fine at terminal scale). */
  private distNm(lon: number, lat: number): number {
    const [lon0, lat0] = this.origin;
    const k = Math.cos(CesiumMath.toRadians(lat0));
    return Math.hypot((lon - lon0) * k, lat - lat0) * 60;
  }

  private inRange(lon: number, lat: number): boolean {
    return this.opts.rangeNm == null || this.distNm(lon, lat) <= this.opts.rangeNm;
  }

  /**
   * Parts of a leg within the range of the airport, cut where the path crosses it.
   * `pt` reads [lon, lat] from a vertex; `lerp` interpolates between two vertices.
   */
  private clip<T>(path: T[], pt: (v: T) => [number, number], lerp: (a: T, b: T, t: number) => T): T[][] {
    const r = this.opts.rangeNm;
    if (r == null) return [path];
    const d = path.map((v) => this.distNm(...pt(v)));
    const runs: T[][] = [];
    let run: T[] = [];
    for (let i = 0; i < path.length; i++) {
      const inside = d[i] <= r;
      if (i > 0 && inside !== d[i - 1] <= r) {
        // crossing the range circle between i-1 and i
        const cut = lerp(path[i - 1], path[i], (r - d[i - 1]) / (d[i] - d[i - 1]));
        run.push(cut);
        if (!inside) {
          runs.push(run);
          run = [];
        } else run = [cut];
      }
      if (inside) run.push(path[i]);
    }
    if (run.length) runs.push(run);
    return runs.filter((x) => x.length > 1);
  }

  /** A segment split into the parts within range. */
  private clipSegment(s: Segment): Segment[] {
    if (this.opts.rangeNm == null) return [s];
    const ll = (a: [number, number], b: [number, number], t: number): [number, number] => [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
    ];
    if (s.glide) {
      const g3 = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [
        ...ll([a[0], a[1]], [b[0], b[1]], t),
        a[2] + (b[2] - a[2]) * t,
      ];
      return this.clip(s.glide, (v) => [v[0], v[1]], g3).map((glide) => ({
        ...s,
        glide,
        path: glide.map(([lon, lat]) => [lon, lat] as [number, number]),
      }));
    }
    return this.clip(s.path, (v) => v, ll).map((path) => ({ ...s, path }));
  }

  private addGhost(src: CustomDataSource, proc: Procedure, ts: Transition[], color: Color, drawn: Drawn) {
    const simple = simplify(proc, ts, drawn);
    const properties = { proc: procKey(proc) };
    for (const s of [...simple.tracks, ...simple.volumes].flatMap(({ item }) => this.clipSegment(item))) {
      src.entities.add({
        name: `${proc.airport} ${proc.id}`,
        properties,
        polyline: {
          positions: s.path.map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat)),
          width: 1,
          arcType: ArcType.GEODESIC,
          material: fa(color, 0.15),
        },
      });
    }
  }

  private addProcedure(
    src: CustomDataSource,
    proc: Procedure,
    ts: Transition[],
    color: Color,
    drawn: Drawn,
    lines: Drawn,
  ) {
    const ents = src.entities;
    const focused = procKey(proc) === this.focus;
    /** full volumes for the focused procedure (or for all, if asked); one line per ground path otherwise */
    const full = this.opts.volumes || focused;
    const simple = simplify(proc, ts, full ? drawn : lines);
    const properties = { proc: procKey(proc) };
    const info = new Map<Transition, { name: string; description: string; properties: object }>();
    const common = (t: Transition) => {
      let c = info.get(t);
      if (!c) {
        c = {
          name: `${proc.airport} ${proc.id}${t.name ? ` · ${t.name}` : ""}${t.kind === "missed" ? " · missed approach" : ""}`,
          description: describeTransition(proc, t),
          properties,
        };
        info.set(t, c);
      }
      return c;
    };
    /** parts within range of the airport; the focused procedure is always shown whole */
    const clip = (s: Segment) => (focused ? [s] : this.clipSegment(s));
    const near = (p: ProcPoint) => focused || this.inRange(p.lon!, p.lat!);
    const tint = (t: Transition) => (t.kind === "missed" ? fa(color, 0.55) : color);

    // legs without any published altitude: ground track
    for (const { item, t } of simple.tracks) for (const s of clip(item)) {
      ents.add({
        ...common(t),
        polyline: {
          positions: s.path.map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat)),
          width: 1.5,
          arcType: ArcType.GEODESIC,
          material:
            t.kind === "missed"
              ? new PolylineDashMaterialProperty({ color: fa(color, 0.3), dashLength: 12 })
              : fa(color, 0.35),
        },
      });
    }
    for (const { item, t } of simple.volumes) for (const s of clip(item)) {
      if (full) this.addSegmentVolume(src, s, tint(t), common(t));
      else this.addSegmentLines(src, s, tint(t), common(t), t.kind === "missed");
    }
    for (const { item: p, t } of simple.gates) if (near(p)) this.addGate(src, p, tint(t), common(t), full);
    if (this.opts.labels) {
      for (const { item: p, t } of simple.fixes) {
        if (!near(p)) continue;
        ents.add({
          ...common(t),
          position: Cartesian3.fromDegrees(p.lon!, p.lat!),
          point: full
            ? {
                pixelSize: 3,
                color: fa(color, 0.7),
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                distanceDisplayCondition: new DistanceDisplayCondition(0, FIX_DISTANCE_M),
              }
            : undefined,
          label: this.fixLabel(p.fix!, FIX_DISTANCE_M),
        });
      }
    }
  }

  /**
   * Overview form of a leg: one line, along the published vertical path if there is one,
   * else at the lowest published limit (the highest when only a ceiling is published).
   */
  private addSegmentLines(src: CustomDataSource, s: Segment, color: Color, common: object, missed: boolean) {
    const positions = s.glide
      ? s.glide.map(([lon, lat, ft]) => Cartesian3.fromDegrees(lon, lat, this.h(ft)))
      : s.path.map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat, this.h((s.lo ?? s.hi)!)));
    src.entities.add({
      ...common,
      polyline: {
        positions,
        width: s.glide ? 2.5 : 2,
        arcType: ArcType.GEODESIC,
        material: missed ? new PolylineDashMaterialProperty({ color, dashLength: 12 }) : fa(color, 0.85),
      },
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
          material: fa(color, 0.35),
          outline: true,
          outlineColor: fa(color, 0.8),
        },
      });
      return;
    }
    if (s.lo == null && s.hi == null) return; // nothing published: track only

    const bottom = s.lo ?? s.hi! - OPEN_FT;
    const top = s.hi ?? s.lo! + OPEN_FT;
    const fade = s.hi == null ? this.fadeUp : s.lo == null ? this.fadeDown : undefined;
    const wallMaterial = fade
      ? new ImageMaterialProperty({ image: fade, transparent: true, color: fa(color, 0.3) })
      : fa(color, 0.18);
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
          material: fa(color, 0.2),
        },
      });
    }
  }

  /** Restriction at a fix: a label at the limit; dots too when drawn in full (focused). */
  private addGate(src: CustomDataSource, p: ProcPoint, color: Color, common: object, full: boolean) {
    const ents = src.entities;
    const a = p.alt!;
    const at = (ft: number) => Cartesian3.fromDegrees(p.lon!, p.lat!, this.h(ft));

    const marks = a.k === "between" ? [a.lo!, a.hi!] : a.k === "below" ? [a.hi!] : [a.lo!];
    marks.forEach((ft, i) => {
      const top = i === marks.length - 1;
      // overview: label only, no dots; the focused procedure gets a dot per limit
      if (!full && (!top || !this.opts.labels)) return;
      ents.add({
        ...common,
        position: at(ft),
        point: full
          ? {
              pixelSize: a.k === "at" ? 8 : 6,
              color,
              outlineColor: Color.BLACK,
              outlineWidth: 1,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            }
          : undefined,
        label:
          top && this.opts.labels
            ? this.fixLabel(`${p.fix ?? ""}  ${formatAlt(a)}${p.spd ? `  ${formatSpeed(p.spd)}` : ""}`, full ? 80_000 : 40_000)
            : undefined,
      });
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
