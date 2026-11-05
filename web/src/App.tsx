import { useEffect, useMemo, useRef, useState } from "react";
import {
  AppShell,
  Badge,
  Button,
  Checkbox,
  Chip,
  Collapse,
  ColorSwatch,
  Divider,
  Group,
  Loader,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  Slider,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
  Tree,
  useTree,
  type RenderTreeNodePayload,
} from "@mantine/core";
import { IconChevronDown, IconPlaneDeparture, IconSearch } from "@tabler/icons-react";
import { AIRSPACE_COLORS, AirspaceScene, type DisplayOptions, type ViewInfo } from "./scene";
import { buildTree, procLeaves, TYPE_LABEL } from "./procTree";
import { hasHardRestriction } from "./simplify";
import { AIRSPACE_MAX_HEIGHT, loadAirport, loadAirspace, pickAirports, PROC_MAX_HEIGHT } from "./loader";
import type { AirportFile, DataIndex, ProcType, Procedure, SurfaceClass } from "./types";
import { procKey, transKey } from "./types";

const TYPE_COLORS: Record<ProcType, string> = { SID: "#59a14f", STAR: "#f28e2b", IAP: "#edc948" };
const TYPES: ProcType[] = ["SID", "STAR", "IAP"];
/** Range slider: values above RANGE_MAX mean "no limit". */
const RANGE_MAX = 150;
const CLASSES: SurfaceClass[] = ["B", "C", "D", "E/G"];

/** "hard" = has an at / between altitude at some fix (runway thresholds excluded). */
type HardFilter = "any" | "hard" | "soft";
const passesHard = (p: Procedure, f: HardFilter) =>
  f === "any" || hasHardRestriction(p.transitions) === (f === "hard");

/** Airport palette: warm and green hues only, so procedures never read as airspace (blue/purple/teal/red). */
const AIRPORT_PALETTE = ["#f28e2b", "#8cd17d", "#edc948", "#ff9da7", "#d37295", "#9c755f", "#f1ce63", "#59a14f"];

/** Stable per-airport color. */
function airportColor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AIRPORT_PALETTE[h % AIRPORT_PALETTE.length];
}

export default function App() {
  const [index, setIndex] = useState<DataIndex>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    fetch("data/index.json")
      .then((r) => r.json())
      .then(setIndex)
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <Text c="red" p="md">Failed to load data: {error}</Text>;
  if (!index)
    return (
      <Group justify="center" h="100vh">
        <Loader />
      </Group>
    );
  return <Explorer index={index} />;
}

function Explorer({ index }: { index: DataIndex }) {
  const [opts, setOpts] = useState<DisplayOptions>({
    exaggeration: 3,
    labels: true,
    volumes: false,
    rnavSpec: false,
    rangeNm: 40,
    classB: true,
    classC: true,
    classD: false,
    sua: false,
  });
  const [types, setTypes] = useState<Record<ProcType, boolean>>({ SID: true, STAR: true, IAP: false });
  const [showDisplay, setShowDisplay] = useState(false);
  /** enroute transitions are the long spokes out to distant fixes; off by default */
  const [enroute, setEnroute] = useState(false);
  const [colorBy, setColorBy] = useState<"airport" | "type">("type");
  const [query, setQuery] = useState("");
  const [hardFilter, setHardFilter] = useState<HardFilter>("any");
  /** airports are loaded only if the airspace at their surface is one of these */
  const [classes, setClasses] = useState<SurfaceClass[]>(["B", "C"]);
  /** an airport the user picked; always loaded */
  const [pinned, setPinned] = useState<string>();
  /** leaf keys the user has unchecked; everything else in view is shown */
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [view, setView] = useState<ViewInfo>();
  const [active, setActive] = useState<AirportFile[]>([]);
  const [loading, setLoading] = useState(false);
  /** procedure key drawn in full; others become faint context */
  const [focus, setFocus] = useState<string>();

  // --- Cesium scene lifecycle ---
  const container = useRef<HTMLDivElement>(null);
  const scene = useRef<AirspaceScene>(null);
  useEffect(() => {
    const s = new AirspaceScene(container.current!, opts);
    s.setIndex(index.airports);
    s.onView = setView;
    s.onAirportClick = (id) => {
      const a = index.airports.find((x) => x[0] === id);
      if (a) {
        setPinned(id);
        s.flyTo(a[2], a[3]);
      }
    };
    s.onProcedureClick = setFocus;
    scene.current = s;
    if (import.meta.env.DEV) (window as unknown as { __scene: AirspaceScene }).__scene = s;
    setView(s.getView());
    return () => {
      s.destroy();
      scene.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  useEffect(() => scene.current?.setOptions(opts), [opts]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFocus(undefined);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // drop the focus once its airport is no longer loaded
  useEffect(() => {
    if (focus && !active.some((f) => focus.startsWith(`${f.airport.id}/`))) setFocus(undefined);
  }, [active, focus]);

  // load procedures for airports in view
  useEffect(() => {
    if (!view) return;
    let cancelled = false;
    const ids = pickAirports(index, view, types, new Set(classes), pinned);
    setLoading(true);
    Promise.allSettled(ids.map(loadAirport)).then((rs) => {
      if (cancelled) return;
      const files = rs.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      setActive(files);
      scene.current?.setActiveAirports(files);
      setLoading(false);
    });
    loadAirspace(index, view).then((features) => {
      if (!cancelled) scene.current?.setAirspace(features);
    });
    return () => {
      cancelled = true;
    };
  }, [index, view, types, classes, pinned]);

  useEffect(() => {
    const on = new Set(classes);
    scene.current?.setAirportFilter((a) => on.has(a[8]) || a[0] === pinned);
  }, [classes, pinned]);

  // what to draw and in which color
  useEffect(() => {
    scene.current?.setStyle(
      (p: Procedure) => {
        if (!types[p.type] || !passesHard(p, hardFilter)) return [];
        const shown = p.transitions.length === 1
          ? (hidden.has(procKey(p)) ? [] : p.transitions)
          : p.transitions.filter((_, i) => !hidden.has(transKey(p, i)));
        const all = enroute || procKey(p) === focus;
        return all ? shown : shown.filter((t) => t.kind !== "enroute");
      },
      (p) => (colorBy === "airport" ? airportColor(p.airport) : TYPE_COLORS[p.type]),
      focus,
    );
  }, [types, hidden, colorBy, hardFilter, enroute, focus]);

  // tree: checked = every leaf in view that is not hidden
  const allLeaves = useMemo(
    () =>
      active.flatMap((f) => f.procedures.filter((p) => types[p.type] && passesHard(p, hardFilter)).flatMap(procLeaves)),
    [active, types, hardFilter],
  );
  const checkedState = useMemo(() => allLeaves.filter((l) => !hidden.has(l)), [allLeaves, hidden]);
  const tree = useTree({
    checkedState,
    onCheckedStateChange: (checked) => {
      const on = new Set(checked);
      setHidden((prev) => {
        const next = new Set(prev);
        for (const l of allLeaves) (on.has(l) ? next.delete(l) : next.add(l));
        return next;
      });
    },
  });
  const treeData = useMemo(
    () => buildTree(active, types, query, (p) => passesHard(p, hardFilter)),
    [active, types, query, hardFilter],
  );

  const airportOptions = useMemo(
    () => index.airports.map(([id, name]) => ({ value: id, label: `${id} · ${name}` })),
    [index],
  );

  const set = <K extends keyof DisplayOptions>(k: K, v: DisplayOptions[K]) => setOpts((o) => ({ ...o, [k]: v }));

  const renderNode = ({ node, expanded, hasChildren, elementProps, tree, level }: RenderTreeNodePayload) => {
    const checked = tree.isNodeChecked(node.value);
    const indeterminate = tree.isNodeIndeterminate(node.value);
    return (
      <Group gap={6} wrap="nowrap" {...elementProps}>
        <Checkbox.Indicator
          size="xs"
          checked={checked}
          indeterminate={indeterminate}
          onClick={() => (checked ? tree.uncheckNode(node.value) : tree.checkNode(node.value))}
        />
        <Group
          gap={6}
          wrap="nowrap"
          style={{ flex: 1, cursor: "pointer", minWidth: 0, borderRadius: 4, background: node.value === focus ? "var(--mantine-color-dark-5)" : undefined }}
          onClick={() => {
            if (level === 3) setFocus((f) => (f === node.value ? undefined : node.value));
            if (hasChildren) tree.toggleExpanded(node.value);
          }}
        >
          {level === 1 && colorBy === "airport" && <ColorSwatch size={10} color={airportColor(node.value)} />}
          {level === 2 && colorBy === "type" && (
            <ColorSwatch size={10} color={TYPE_COLORS[node.value.split("/")[1] as ProcType]} />
          )}
          <Text size="sm" fw={level === 1 ? 600 : 400} truncate>
            {node.label}
          </Text>
          {level === 1 && (
            <Text size="xs" c="dimmed" truncate>
              {(node.nodeProps as { name?: string })?.name}
            </Text>
          )}
          {hasChildren && (
            <IconChevronDown
              size={14}
              style={{ marginLeft: "auto", flexShrink: 0, transform: expanded ? "rotate(180deg)" : "none" }}
            />
          )}
        </Group>
      </Group>
    );
  };

  const tooHigh = view && view.height > PROC_MAX_HEIGHT;

  return (
    <AppShell navbar={{ width: 360, breakpoint: "sm" }} padding={0}>
      <AppShell.Navbar>
        <AppShell.Section p="md" pb="xs">
          <Group justify="space-between">
            <Title order={4}>Airspace 3D</Title>
            <Badge variant="light" size="sm">
              AIRAC {index.cycle}
            </Badge>
          </Group>
          <Select
            mt="sm"
            size="xs"
            searchable
            clearable
            placeholder={`Go to airport (${index.airports.length.toLocaleString()} with procedures)`}
            leftSection={<IconPlaneDeparture size={14} />}
            data={airportOptions}
            limit={30}
            value={null}
            onChange={(id) => {
              const a = index.airports.find((x) => x[0] === id);
              if (a) {
                setPinned(a[0]);
                scene.current?.flyTo(a[2], a[3]);
              }
            }}
          />
        </AppShell.Section>
        <Divider />

        <AppShell.Section p="md" pb="sm">
          <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb="xs">
            Airspace
          </Text>
          <Group gap={6}>
            {(["B", "C", "D", "SUA"] as const).map((c) => {
              const key = c === "SUA" ? "sua" : (`class${c}` as const);
              return (
                <Chip
                  key={c}
                  size="xs"
                  variant="outline"
                  checked={opts[key]}
                  onChange={(v) => set(key, v)}
                  icon={<ColorSwatch size={8} color={AIRSPACE_COLORS[c]} />}
                  styles={{ label: opts[key] ? { borderColor: AIRSPACE_COLORS[c] } : undefined }}
                >
                  {c === "SUA" ? "Special use" : `Class ${c}`}
                </Chip>
              );
            })}
          </Group>
          <Group justify="space-between" mt="sm">
            <Switch size="xs" label="Labels" checked={opts.labels} onChange={(e) => set("labels", e.currentTarget.checked)} />
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              rightSection={<IconChevronDown size={12} style={{ transform: showDisplay ? "rotate(180deg)" : "none" }} />}
              onClick={() => setShowDisplay((v) => !v)}
            >
              Display options
            </Button>
          </Group>
          <Switch
            size="xs"
            mt="sm"
            label="Enroute transitions"
            description="The spokes out to distant fixes; a focused procedure always shows them"
            checked={enroute}
            onChange={(e) => setEnroute(e.currentTarget.checked)}
          />
          <Text size="xs" mt="sm" mb={2}>
            Show procedures within{" "}
            <b>{opts.rangeNm == null ? "any distance" : `${opts.rangeNm} NM`}</b> of the airport
          </Text>
          <Slider
            size="sm"
            min={10}
            max={RANGE_MAX + 10}
            step={5}
            defaultValue={opts.rangeNm ?? RANGE_MAX + 10}
            label={(v) => (v > RANGE_MAX ? "No limit" : `${v} NM`)}
            onChangeEnd={(v) => set("rangeNm", v > RANGE_MAX ? null : v)}
            marks={[
              { value: 20, label: "20" },
              { value: 40, label: "40" },
              { value: 80, label: "80" },
              { value: RANGE_MAX + 10, label: "All" },
            ]}
            mb="lg"
          />
          <Collapse expanded={showDisplay}>
            <Stack gap={8} mt="sm">
              <Switch
                size="xs"
                label="Volumes for every procedure"
                description="Legal altitude band from published restrictions; open sides fade. Off: only the focused procedure"
                checked={opts.volumes}
                onChange={(e) => set("volumes", e.currentTarget.checked)}
              />
              <Switch
                size="xs"
                label="RNAV 1 width on RNAV SIDs/STARs"
                description="Charted nav spec, not coded per leg (else nominal width)"
                checked={opts.rnavSpec}
                onChange={(e) => set("rnavSpec", e.currentTarget.checked)}
              />
              <Text size="xs">Vertical exaggeration · {opts.exaggeration}×</Text>
              <Slider
                size="sm"
                min={1}
                max={10}
                step={0.5}
                value={opts.exaggeration}
                onChangeEnd={(v) => set("exaggeration", v)}
                marks={[1, 3, 5, 10].map((v) => ({ value: v, label: `${v}×` }))}
                mb="md"
              />
              <Text size="xs">Color procedures by</Text>
              <SegmentedControl
                fullWidth
                size="xs"
                value={colorBy}
                onChange={(v) => setColorBy(v as "airport" | "type")}
                data={[
                  { value: "type", label: "Procedure type" },
                  { value: "airport", label: "Airport" },
                ]}
              />
            </Stack>
          </Collapse>
        </AppShell.Section>
        <Divider />

        <AppShell.Section p="md" pb="xs">
          <Group justify="space-between" mb="xs">
            <Text size="xs" fw={700} c="dimmed" tt="uppercase">
              Procedures in view
            </Text>
            {loading ? <Loader size={12} /> : (
              <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setHidden(new Set())}>
                Show all
              </Button>
            )}
          </Group>
          <Chip.Group
            multiple
            value={TYPES.filter((t) => types[t])}
            onChange={(v) => setTypes({ SID: v.includes("SID"), STAR: v.includes("STAR"), IAP: v.includes("IAP") })}
          >
            <Group gap={6} mb="xs">
              {TYPES.map((t) => (
                <Chip key={t} value={t} size="xs" color={colorBy === "type" ? undefined : "blue"} styles={colorBy === "type" ? { label: { borderColor: TYPE_COLORS[t] } } : undefined}>
                  {TYPE_LABEL[t]}
                </Chip>
              ))}
            </Group>
          </Chip.Group>
          <Group gap={6} mb="xs" wrap="nowrap">
            <Text size="xs" c="dimmed" w={52}>
              Airports
            </Text>
            <Chip.Group multiple value={classes} onChange={(v) => setClasses(v as SurfaceClass[])}>
              <Group gap={4}>
                {CLASSES.map((c) => (
                  <Chip key={c} value={c} size="xs" variant="outline">
                    {c}
                  </Chip>
                ))}
              </Group>
            </Chip.Group>
          </Group>
          <SegmentedControl
            fullWidth
            size="xs"
            mb="xs"
            value={hardFilter}
            onChange={(v) => setHardFilter(v as HardFilter)}
            data={[
              { value: "any", label: "All" },
              { value: "hard", label: "Hard restrictions" },
              { value: "soft", label: "No hard restrictions" },
            ]}
          />
          <TextInput
            size="xs"
            placeholder="Filter by procedure, transition or fix"
            leftSection={<IconSearch size={14} />}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
          <Text size="xs" c="dimmed" mt={6}>
            {tooHigh
              ? "Zoom in to load procedures."
              : `${active.length} nearest airport${active.length === 1 ? "" : "s"} loaded; pan or zoom to load others. Click a procedure to focus it.`}
            {view && view.height > AIRSPACE_MAX_HEIGHT ? " Airspace hidden at this altitude." : ""}
          </Text>
        </AppShell.Section>
        {focus && (
          <AppShell.Section px="md" pb="xs">
            <Paper withBorder p={6} px="xs">
              <Group justify="space-between" wrap="nowrap">
                <Text size="xs" truncate>
                  Focused: <b>{focus.split("/").filter((_, i) => i !== 1).join(" ")}</b>
                </Text>
                <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setFocus(undefined)}>
                  Show all (Esc)
                </Button>
              </Group>
            </Paper>
          </AppShell.Section>
        )}
        <AppShell.Section grow component={ScrollArea} px="md" pb="md">
          <Tree tree={tree} data={treeData} levelOffset={18} expandOnClick={false} renderNode={renderNode} />
        </AppShell.Section>
        <Divider />
        <AppShell.Section p="xs" px="md">
          <Text size="xs" c="dimmed">
            FAA CIFP · effective {index.effective}. Not for navigation.
          </Text>
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main h="100vh">
        <div style={{ position: "relative", height: "100%" }}>
          <div ref={container} style={{ position: "absolute", inset: 0 }} />
          <Legend colorBy={colorBy} types={types} />
        </div>
      </AppShell.Main>
    </AppShell>
  );
}

function Legend({ colorBy, types }: { colorBy: "airport" | "type"; types: Record<ProcType, boolean> }) {
  const [open, setOpen] = useState(true);
  return (
    <Paper withBorder shadow="sm" p="xs" pos="absolute" bottom={36} left={12} style={{ zIndex: 1, opacity: 0.92, maxWidth: 270 }}>
      <Group justify="space-between" gap="xs" wrap="nowrap" style={{ cursor: "pointer" }} onClick={() => setOpen((o) => !o)}>
        <Text size="xs" fw={700}>
          Legend
        </Text>
        <IconChevronDown size={14} style={{ transform: open ? "rotate(180deg)" : "none" }} />
      </Group>
      {open && (
        <Stack gap={2} mt={4}>
          {colorBy === "type" &&
            TYPES.filter((t) => types[t]).map((t) => (
              <Group key={t} gap={6} wrap="nowrap">
                <ColorSwatch size={10} color={TYPE_COLORS[t]} />
                <Text size="xs">{TYPE_LABEL[t]}</Text>
              </Group>
            ))}
          {(["B", "C", "D"] as const).map((c) => (
            <Group key={c} gap={6} wrap="nowrap">
              <ColorSwatch size={10} color={AIRSPACE_COLORS[c]} />
              <Text size="xs">Class {c} airspace</Text>
            </Group>
          ))}
          <Text size="xs" mt={4}>● altitude restriction at a fix (focused procedure)</Text>
          <Text size="xs">━ line in the air: lowest published altitude</Text>
          <Text size="xs">╱ sloped line: glidepath</Text>
          <Text size="xs">─ faint line on the ground: no published altitude</Text>
          <Text size="xs">┄ dashed: missed approach</Text>
          <Text size="xs" c="dimmed" mt={4}>
            Click a procedure to see its legal altitude band: solid edges are published limits, fading edges have none
            (arrivals only descend, departures only climb).
          </Text>
        </Stack>
      )}
    </Paper>
  );
}
