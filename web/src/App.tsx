import { useEffect, useMemo, useRef, useState } from "react";
import {
  AppShell,
  Badge,
  Button,
  Checkbox,
  Chip,
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
import { schemeTableau10 } from "d3-scale-chromatic";
import { AIRSPACE_COLORS, AirspaceScene, type DisplayOptions, type ViewInfo } from "./scene";
import { buildTree, procLeaves, TYPE_LABEL } from "./procTree";
import { hasHardRestriction } from "./simplify";
import { AIRSPACE_MAX_HEIGHT, loadAirport, loadAirspace, pickAirports, PROC_MAX_HEIGHT } from "./loader";
import type { AirportFile, DataIndex, ProcType, Procedure } from "./types";
import { procKey, transKey } from "./types";

const TYPE_COLORS: Record<ProcType, string> = { SID: "#59a14f", STAR: "#f28e2b", IAP: "#edc948" };
const TYPES: ProcType[] = ["SID", "STAR", "IAP"];

/** "hard" = has an at / between altitude at some fix (runway thresholds excluded). */
type HardFilter = "any" | "hard" | "soft";
const passesHard = (p: Procedure, f: HardFilter) =>
  f === "any" || hasHardRestriction(p.transitions) === (f === "hard");

/** Stable per-airport color. */
function airportColor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return schemeTableau10[h % 10];
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
    volumes: true,
    rnavSpec: false,
    classB: true,
    classC: true,
    classD: false,
    sua: false,
  });
  const [types, setTypes] = useState<Record<ProcType, boolean>>({ SID: true, STAR: true, IAP: false });
  const [colorBy, setColorBy] = useState<"airport" | "type">("airport");
  const [query, setQuery] = useState("");
  const [hardFilter, setHardFilter] = useState<HardFilter>("any");
  /** leaf keys the user has unchecked; everything else in view is shown */
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [view, setView] = useState<ViewInfo>();
  const [active, setActive] = useState<AirportFile[]>([]);
  const [loading, setLoading] = useState(false);

  // --- Cesium scene lifecycle ---
  const container = useRef<HTMLDivElement>(null);
  const scene = useRef<AirspaceScene>(null);
  useEffect(() => {
    const s = new AirspaceScene(container.current!, opts);
    s.setIndex(index.airports);
    s.onView = setView;
    s.onAirportClick = (id) => {
      const a = index.airports.find((x) => x[0] === id);
      if (a) s.flyTo(a[2], a[3]);
    };
    scene.current = s;
    setView(s.getView());
    return () => {
      s.destroy();
      scene.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  useEffect(() => scene.current?.setOptions(opts), [opts]);

  // load procedures for airports in view
  useEffect(() => {
    if (!view) return;
    let cancelled = false;
    const ids = pickAirports(index, view, types);
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
  }, [index, view, types]);

  // what to draw and in which color
  useEffect(() => {
    scene.current?.setStyle(
      (p: Procedure) => {
        if (!types[p.type] || !passesHard(p, hardFilter)) return [];
        if (p.transitions.length === 1) return hidden.has(procKey(p)) ? [] : p.transitions;
        return p.transitions.filter((_, i) => !hidden.has(transKey(p, i)));
      },
      (p) => (colorBy === "airport" ? airportColor(p.airport) : TYPE_COLORS[p.type]),
    );
  }, [types, hidden, colorBy, hardFilter]);

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
        <Group gap={6} wrap="nowrap" style={{ flex: 1, cursor: "pointer", minWidth: 0 }} onClick={() => tree.toggleExpanded(node.value)}>
          {level === 1 && <ColorSwatch size={10} color={airportColor(node.value)} />}
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
              if (a) scene.current?.flyTo(a[2], a[3]);
            }}
          />
        </AppShell.Section>
        <Divider />

        <AppShell.Section p="md">
          <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb="xs">
            Layers
          </Text>
          <Stack gap={8}>
            <Group gap="lg">
              {(["B", "C", "D"] as const).map((c) => (
                <Switch
                  key={c}
                  size="sm"
                  label={`Class ${c}`}
                  checked={opts[`class${c}`]}
                  onChange={(e) => set(`class${c}`, e.currentTarget.checked)}
                  thumbIcon={<ColorSwatch size={8} color={AIRSPACE_COLORS[c]} />}
                />
              ))}
            </Group>
            <Switch size="sm" label="Special use airspace" checked={opts.sua} onChange={(e) => set("sua", e.currentTarget.checked)} thumbIcon={<ColorSwatch size={8} color={AIRSPACE_COLORS.SUA} />} />
            <Switch size="sm" label="Labels" checked={opts.labels} onChange={(e) => set("labels", e.currentTarget.checked)} />
            <Switch
              size="sm"
              label="Procedure volumes"
              description="Legal altitude band from published restrictions; open sides fade"
              checked={opts.volumes}
              onChange={(e) => set("volumes", e.currentTarget.checked)}
            />
            <Switch
              size="sm"
              label="RNAV 1 width on RNAV SIDs/STARs"
              description="Charted nav spec, not coded per leg (else nominal width)"
              checked={opts.rnavSpec}
              onChange={(e) => set("rnavSpec", e.currentTarget.checked)}
            />
          </Stack>
          <Text size="sm" mt="md" mb={4}>
            Vertical exaggeration · {opts.exaggeration}×
          </Text>
          <Slider
            min={1}
            max={10}
            step={0.5}
            value={opts.exaggeration}
            onChangeEnd={(v) => set("exaggeration", v)}
            marks={[1, 3, 5, 10].map((v) => ({ value: v, label: `${v}×` }))}
            mb="lg"
          />
          <Text size="sm" mt="md" mb={4}>
            Color procedures by
          </Text>
          <SegmentedControl
            fullWidth
            size="xs"
            value={colorBy}
            onChange={(v) => setColorBy(v as "airport" | "type")}
            data={[
              { value: "airport", label: "Airport" },
              { value: "type", label: "Procedure type" },
            ]}
          />
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
              : `${active.length} nearest airport${active.length === 1 ? "" : "s"} loaded; pan or zoom to load others.`}
            {view && view.height > AIRSPACE_MAX_HEIGHT ? " Airspace hidden at this altitude." : ""}
          </Text>
        </AppShell.Section>
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
          <Legend />
        </div>
      </AppShell.Main>
    </AppShell>
  );
}

function Legend() {
  return (
    <Paper withBorder shadow="sm" p="xs" pos="absolute" bottom={36} left={12} style={{ zIndex: 1, opacity: 0.92, maxWidth: 260 }}>
      <Text size="xs" fw={700} mb={4}>
        Published restrictions
      </Text>
      <Stack gap={2}>
        <Text size="xs">● dot: restricted altitude at a fix</Text>
        <Text size="xs">▬ solid plane: published floor / ceiling</Text>
        <Text size="xs">░ fading side: no published limit</Text>
        <Text size="xs">▰ sloped: glideslope / vertical path</Text>
        <Text size="xs" c="dimmed">
          Band = altitudes allowed between fixes, assuming only descent on arrivals/approaches and only climb on departures.
        </Text>
      </Stack>
    </Paper>
  );
}
