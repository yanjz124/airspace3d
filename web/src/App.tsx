import { useEffect, useMemo, useRef, useState } from "react";
import {
  AppShell,
  Badge,
  Button,
  Checkbox,
  ColorSwatch,
  Divider,
  Group,
  Loader,
  Paper,
  ScrollArea,
  SegmentedControl,
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
import { IconChevronDown, IconSearch } from "@tabler/icons-react";
import { schemeTableau10 } from "d3-scale-chromatic";
import { AIRSPACE_COLORS, AirspaceScene, type DisplayOptions } from "./scene";
import { buildTree, leavesUnder, selectedTransitions, TYPE_LABEL } from "./procTree";
import type { AirspaceBundle, ProcType, ProcedureBundle } from "./types";

const METRO = "n90";
const TYPE_COLORS: Record<ProcType, string> = { SID: "#59a14f", STAR: "#f28e2b", IAP: "#edc948" };
const DEFAULT_AIRPORTS = ["KJFK", "KLGA", "KEWR"];

export default function App() {
  const [bundle, setBundle] = useState<ProcedureBundle>();
  const [airspace, setAirspace] = useState<AirspaceBundle>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    Promise.all([
      fetch(`data/${METRO}/procedures.json`).then((r) => r.json()),
      fetch(`data/${METRO}/airspace.json`).then((r) => r.json()),
    ])
      .then(([p, a]) => {
        setBundle(p);
        setAirspace(a);
      })
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <Text c="red" p="md">Failed to load data: {error}</Text>;
  if (!bundle || !airspace)
    return (
      <Group justify="center" h="100vh">
        <Loader />
      </Group>
    );
  return <Explorer bundle={bundle} airspace={airspace} />;
}

function Explorer({ bundle, airspace }: { bundle: ProcedureBundle; airspace: AirspaceBundle }) {
  const [opts, setOpts] = useState<DisplayOptions>({
    exaggeration: 3,
    labels: true,
    corridors: true,
    rnavSpec: false,
    classB: true,
    classC: false,
    classD: false,
    sua: false,
  });
  const [colorBy, setColorBy] = useState<"airport" | "type">("airport");
  const [query, setQuery] = useState("");

  const airportColor = useMemo(
    () => Object.fromEntries(bundle.metro.airports.map((id, i) => [id, schemeTableau10[i % 10]])),
    [bundle],
  );

  const tree = useTree({
    initialCheckedState: leavesUnder(
      bundle,
      DEFAULT_AIRPORTS.flatMap((a) => [`${a}/SID`, `${a}/STAR`]),
    ),
  });
  const treeData = useMemo(() => buildTree(bundle, query), [bundle, query]);

  // --- Cesium scene lifecycle ---
  const container = useRef<HTMLDivElement>(null);
  const scene = useRef<AirspaceScene>(null);
  useEffect(() => {
    const s = new AirspaceScene(container.current!, bundle.metro, opts);
    s.setAirports(bundle.airports);
    s.setAirspace(airspace);
    scene.current = s;
    return () => {
      s.destroy();
      scene.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle, airspace]);

  useEffect(() => scene.current?.setOptions(opts), [opts]);

  useEffect(() => {
    const sel = selectedTransitions(bundle, tree.checkedState);
    scene.current?.setProcedures(
      [...sel].map(([proc, transitions]) => ({
        proc,
        transitions,
        color: colorBy === "airport" ? airportColor[proc.airport] : TYPE_COLORS[proc.type],
      })),
    );
  }, [bundle, tree.checkedState, colorBy, airportColor]);

  const set = <K extends keyof DisplayOptions>(k: K, v: DisplayOptions[K]) => setOpts((o) => ({ ...o, [k]: v }));

  const toggleType = (type: ProcType) => {
    const leaves = leavesUnder(bundle, bundle.airports.map((a) => `${a.id}/${type}`));
    const checked = new Set(tree.checkedState);
    const all = leaves.every((l) => checked.has(l));
    leaves.forEach((l) => (all ? checked.delete(l) : checked.add(l)));
    tree.setCheckedState([...checked]);
  };

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
        <Group gap={6} wrap="nowrap" style={{ flex: 1, cursor: "pointer" }} onClick={() => tree.toggleExpanded(node.value)}>
          {level === 1 && <ColorSwatch size={10} color={airportColor[node.value]} />}
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

  return (
    <AppShell navbar={{ width: 360, breakpoint: "sm" }} padding={0}>
      <AppShell.Navbar>
        <AppShell.Section p="md" pb="xs">
          <Title order={4}>Airspace 3D</Title>
          <Group gap="xs" mt={4}>
            <Text size="sm" c="dimmed">
              {bundle.metro.name}
            </Text>
            <Badge variant="light" size="sm">
              AIRAC {bundle.meta.cycle}
            </Badge>
          </Group>
        </AppShell.Section>
        <Divider />

        <AppShell.Section p="md">
          <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb="xs">
            Layers
          </Text>
          <Stack gap={8}>
            <Switch size="sm" label="Class B" checked={opts.classB} onChange={(e) => set("classB", e.currentTarget.checked)} thumbIcon={<ColorSwatch size={8} color={AIRSPACE_COLORS.B} />} />
            <Switch size="sm" label="Class C" checked={opts.classC} onChange={(e) => set("classC", e.currentTarget.checked)} thumbIcon={<ColorSwatch size={8} color={AIRSPACE_COLORS.C} />} />
            <Switch size="sm" label="Class D" checked={opts.classD} onChange={(e) => set("classD", e.currentTarget.checked)} thumbIcon={<ColorSwatch size={8} color={AIRSPACE_COLORS.D} />} />
            <Switch size="sm" label="Special use airspace" checked={opts.sua} onChange={(e) => set("sua", e.currentTarget.checked)} thumbIcon={<ColorSwatch size={8} color={AIRSPACE_COLORS.SUA} />} />
            <Switch size="sm" label="Labels" checked={opts.labels} onChange={(e) => set("labels", e.currentTarget.checked)} />
            <Switch size="sm" label="RNP corridors" description="±RNP where coded in CIFP (approaches)" checked={opts.corridors} onChange={(e) => set("corridors", e.currentTarget.checked)} />
            <Switch
              size="sm"
              ml="xl"
              disabled={!opts.corridors}
              label="RNAV 1 on RNAV SIDs/STARs"
              description="From the charted nav spec; not coded per leg"
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
              Procedures
            </Text>
            <Button size="compact-xs" variant="subtle" color="gray" onClick={() => tree.uncheckAllNodes()}>
              Clear
            </Button>
          </Group>
          <Group gap={6} grow mb="xs">
            {(["SID", "STAR", "IAP"] as ProcType[]).map((t) => (
              <Button key={t} size="compact-xs" variant="default" onClick={() => toggleType(t)}
                leftSection={colorBy === "type" ? <ColorSwatch size={8} color={TYPE_COLORS[t]} /> : undefined}>
                {TYPE_LABEL[t]}
              </Button>
            ))}
          </Group>
          <TextInput
            size="xs"
            placeholder="Filter by procedure, transition or fix"
            leftSection={<IconSearch size={14} />}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
        </AppShell.Section>
        <AppShell.Section grow component={ScrollArea} px="md" pb="md">
          <Tree tree={tree} data={treeData} levelOffset={18} expandOnClick={false} renderNode={renderNode} />
        </AppShell.Section>
        <Divider />
        <AppShell.Section p="xs" px="md">
          <Text size="xs" c="dimmed">
            FAA CIFP · effective {bundle.meta.effective}. Not for navigation.
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
    <Paper withBorder shadow="sm" p="xs" pos="absolute" bottom={36} left={12} style={{ zIndex: 1, opacity: 0.92 }}>
      <Text size="xs" fw={700} mb={4}>
        Published restrictions
      </Text>
      <Stack gap={2}>
        <Text size="xs">● at altitude</Text>
        <Text size="xs">● ↑ at or above</Text>
        <Text size="xs">● ↓ at or below</Text>
        <Text size="xs">┃ between</Text>
        <Text size="xs">▭ window: limits across ±RNP</Text>
        <Text size="xs" c="dimmed">
          Ground track: legs with a defined path only
        </Text>
      </Stack>
    </Paper>
  );
}
