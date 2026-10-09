import {
  ArcType,
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Color,
  ColorMaterialProperty,
  CustomDataSource,
  DistanceDisplayCondition,
  Entity,
  HeadingPitchRange,
  HorizontalOrigin,
  ImageryLayer,
  LabelStyle,
  Math as CesiumMath,
  NearFarScalar,
  PolygonHierarchy,
  PolylineArrowMaterialProperty,
  PolylineDashMaterialProperty,
  UrlTemplateImageryProvider,
  VerticalOrigin,
  Viewer,
} from "cesium";
import type {
  AirspaceBundle,
  AirspaceProps,
  Airport,
  MetroConfig,
  ProcPoint,
  Procedure,
  Transition,
} from "./types";
import { describeAirspace, describeTransition, formatAlt, formatSpeed } from "./describe";

const FT = 0.3048;

const esriTiles = (service: string, maximumLevel: number) =>
  new UrlTemplateImageryProvider({
    url: `https://services.arcgisonline.com/arcgis/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`,
    credit: "Esri, HERE, Garmin, © OpenStreetMap contributors",
    maximumLevel,
  });
/** Length of the open-ended arrow drawn for "at or above" / "at or below" gates, in feet. */
const ARROW_FT = 1500;

export const AIRSPACE_COLORS: Record<string, string> = {
  B: "#4e79a7",
  C: "#b07aa1",
  D: "#76b7b2",
  SUA: "#e15759",
};

export interface DisplayOptions {
  exaggeration: number;
  labels: boolean;
  classB: boolean;
  classC: boolean;
  classD: boolean;
  sua: boolean;
}

export interface VisibleProcedure {
  proc: Procedure;
  /** subset of proc.transitions to draw */
  transitions: Transition[];
  color: string;
}

export class AirspaceScene {
  readonly viewer: Viewer;
  private metro: MetroConfig;
  private airspaceSrc = new CustomDataSource("airspace");
  private procSrc = new CustomDataSource("procedures");
  private airportSrc = new CustomDataSource("airports");

  private airspace?: AirspaceBundle;
  private airports: Airport[] = [];
  private procedures: VisibleProcedure[] = [];
  private opts: DisplayOptions;

  constructor(container: HTMLElement, metro: MetroConfig, opts: DisplayOptions) {
    this.metro = metro;
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
    const scene = this.viewer.scene;
    scene.globe.baseColor = Color.fromCssColorString("#1b1d22");
    scene.globe.depthTestAgainstTerrain = false;
    scene.backgroundColor = Color.fromCssColorString("#101113");
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    scene.fog.enabled = false;
    // Allow viewing the volumes from underneath
    scene.screenSpaceCameraController.enableCollisionDetection = false;

    this.viewer.imageryLayers.addImageryProvider(esriTiles("Canvas/World_Dark_Gray_Reference", 16));

    this.viewer.dataSources.add(this.airspaceSrc);
    this.viewer.dataSources.add(this.airportSrc);
    this.viewer.dataSources.add(this.procSrc);

    this.viewer.homeButton.viewModel.command.beforeExecute.addEventListener((e) => {
      e.cancel = true;
      this.flyHome();
    });
    const cam = new URLSearchParams(location.hash.slice(1)).get("cam");
    if (!cam || !this.setCameraString(cam)) this.flyHome(0);
    this.viewer.camera.moveEnd.addEventListener(() => {
      const params = new URLSearchParams(location.hash.slice(1));
      params.set("cam", this.getCameraString());
      history.replaceState(null, "", `#${params.toString().replaceAll("%2C", ",")}`);
    });
  }

  destroy() {
    this.viewer.destroy();
  }

  /** Camera as "lon,lat,height_m,heading,pitch" for the URL hash. */
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

  flyHome(duration = 1.5) {
    const v = this.metro.view;
    this.viewer.camera.flyToBoundingSphere(new BoundingSphere(Cartesian3.fromDegrees(v.lon, v.lat), 1), {
      offset: new HeadingPitchRange(CesiumMath.toRadians(v.heading), CesiumMath.toRadians(v.pitch), v.range_m),
      duration,
    });
  }

  /** Feet MSL -> ellipsoid height in metres, with vertical exaggeration. */
  private h(ft: number) {
    return ft * FT * this.opts.exaggeration + this.metro.geoid_m;
  }

  setOptions(opts: DisplayOptions) {
    const prev = this.opts;
    this.opts = opts;
    if (prev.exaggeration !== opts.exaggeration) {
      this.renderAll();
      return;
    }
    if (prev.classB !== opts.classB || prev.classC !== opts.classC || prev.classD !== opts.classD || prev.sua !== opts.sua) {
      this.renderAirspace();
    }
    if (prev.labels !== opts.labels) {
      this.renderProcedures();
      this.renderAirports();
    }
  }

  setAirspace(a: AirspaceBundle) {
    this.airspace = a;
    this.renderAirspace();
  }

  setAirports(a: Airport[]) {
    this.airports = a;
    this.renderAirports();
  }

  setProcedures(p: VisibleProcedure[]) {
    this.procedures = p;
    this.renderProcedures();
  }

  private renderAll() {
    this.renderAirspace();
    this.renderAirports();
    this.renderProcedures();
  }

  // --- airspace ------------------------------------------------------------

  private renderAirspace() {
    const ents = this.airspaceSrc.entities;
    ents.suspendEvents();
    ents.removeAll();
    if (this.airspace) {
      const shown: Record<string, boolean> = { B: this.opts.classB, C: this.opts.classC, D: this.opts.classD };
      const sua = this.opts.sua;
      for (const f of this.airspace.class.features) {
        const cls = f.properties.CLASS ?? "";
        if (shown[cls]) {
          this.addVolume(f, AIRSPACE_COLORS[cls] ?? "#999");
        }
      }
      if (sua) for (const f of this.airspace.sua.features) this.addVolume(f, AIRSPACE_COLORS.SUA);
    }
    ents.resumeEvents();
  }

  private addVolume(f: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon, AirspaceProps>, css: string) {
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
      ents.add(
        new Entity({
          name,
          description,
          polygon: {
            hierarchy: new PolygonHierarchy(outer, holes.map((h) => new PolygonHierarchy(h))),
            height: this.h(floor),
            extrudedHeight: this.h(p.ceil_ft!),
            material: new ColorMaterialProperty(color.withAlpha(0.06)),
          },
        }),
      );
      // Edges at floor and ceiling only; polygon outlines would add a vertical line per vertex.
      for (const ring of rings) {
        for (const ft of [floor, p.ceil_ft!]) {
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

  // --- airports ------------------------------------------------------------

  private renderAirports() {
    const ents = this.airportSrc.entities;
    ents.suspendEvents();
    ents.removeAll();
    for (const a of this.airports) {
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
      ents.add({
        name: `${a.id} — ${a.name}`,
        position: Cartesian3.fromDegrees(a.lon, a.lat, this.h(a.elev ?? 0)),
        description: `<p>Elevation ${a.elev ?? "?"} ft · Magnetic variation ${a.magvar ?? "?"}°</p>`,
        label: this.opts.labels
          ? {
              text: a.id,
              font: "600 13px system-ui, sans-serif",
              fillColor: Color.WHITE,
              outlineColor: Color.BLACK,
              outlineWidth: 3,
              style: LabelStyle.FILL_AND_OUTLINE,
              verticalOrigin: VerticalOrigin.TOP,
              pixelOffset: new Cartesian2(0, 8),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            }
          : undefined,
      });
    }
    ents.resumeEvents();
  }

  // --- procedures ----------------------------------------------------------

  private renderProcedures() {
    const ents = this.procSrc.entities;
    ents.suspendEvents();
    ents.removeAll();
    for (const { proc, transitions, color } of this.procedures) {
      const c = Color.fromCssColorString(color);
      for (const t of transitions) this.addTransition(proc, t, c);
    }
    ents.resumeEvents();
  }

  private addTransition(proc: Procedure, t: Transition, color: Color) {
    const ents = this.procSrc.entities;
    const title = `${proc.airport} ${proc.id}${t.name ? ` · ${t.name}` : ""}${t.kind === "missed" ? " · missed approach" : ""}`;
    const description = describeTransition(proc, t);
    const missed = t.kind === "missed";

    for (const path of t.path) {
      ents.add({
        name: title,
        description,
        polyline: {
          positions: path.map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat)),
          width: missed ? 1.5 : 2.5,
          clampToGround: true,
          material: missed
            ? new PolylineDashMaterialProperty({ color: color.withAlpha(0.6), dashLength: 12 })
            : color.withAlpha(0.75),
        },
      });
    }

    for (const p of t.points) {
      if (p.lat == null || p.lon == null) continue;
      if (p.alt) this.addGate(p, color, title, description);
      else if (p.fix && this.opts.labels) {
        ents.add({
          name: title,
          description,
          position: Cartesian3.fromDegrees(p.lon, p.lat, this.metro.geoid_m),
          point: { pixelSize: 4, color: color.withAlpha(0.8), disableDepthTestDistance: Number.POSITIVE_INFINITY },
          label: this.fixLabel(p.fix, 40_000),
        });
      }
    }
  }

  /** Draw a published altitude restriction as a vertical gate above its fix. */
  private addGate(p: ProcPoint, color: Color, title: string, description: string) {
    const ents = this.procSrc.entities;
    const a = p.alt!;
    const at = (ft: number) => Cartesian3.fromDegrees(p.lon!, p.lat!, this.h(Math.max(0, ft)));
    const base = a.k === "below" ? Math.max(0, a.hi! - ARROW_FT) : (a.lo ?? 0);
    const common = { name: title, description };

    // drop line to the ground track
    ents.add({
      ...common,
      polyline: {
        positions: [Cartesian3.fromDegrees(p.lon!, p.lat!, this.metro.geoid_m), at(base)],
        width: 1,
        arcType: ArcType.NONE,
        material: new PolylineDashMaterialProperty({ color: color.withAlpha(0.35), dashLength: 8 }),
      },
    });

    if (a.k === "between") {
      ents.add({
        ...common,
        polyline: { positions: [at(a.lo!), at(a.hi!)], width: 5, arcType: ArcType.NONE, material: color },
      });
    } else if (a.k === "above") {
      ents.add({
        ...common,
        polyline: {
          positions: [at(a.lo!), at(a.lo! + ARROW_FT)],
          width: 10,
          arcType: ArcType.NONE,
          material: new PolylineArrowMaterialProperty(color.withAlpha(0.9)),
        },
      });
    } else if (a.k === "below") {
      ents.add({
        ...common,
        polyline: {
          positions: [at(a.hi!), at(a.hi! - ARROW_FT)],
          width: 10,
          arcType: ArcType.NONE,
          material: new PolylineArrowMaterialProperty(color.withAlpha(0.9)),
        },
      });
    }

    // the restricted altitude(s) themselves
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
