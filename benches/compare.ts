#!/usr/bin/env bun
/**
 * Turns the per-runtime result files into the tables the docs publish.
 *
 * `run-all.ts` leaves one file per runtime per pass in `benches/results/`;
 * this groups them by runtime, reduces the passes by median, and lines the
 * same workloads up side by side — so a claim about `Map` can be checked
 * against every engine rather than one.
 *
 * Usage: bun run benches/compare.ts [--results=dir] [--section=all|readme|docs]
 */

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

interface Result {
  readonly name: string;
  readonly nsPerOp: number;
  readonly opsPerSecond: number;
}

interface ContenderReport {
  readonly kind: "contenders";
  readonly scenario: string;
  readonly results: readonly Result[];
}

interface ScaleSweepRow {
  readonly entries: number;
  readonly swissNsPerOp: number;
  readonly mapNsPerOp: number;
  readonly ratio: number;
  readonly winner: string;
}

interface ScaleSweepReport {
  readonly kind: "scale-sweep";
  readonly rows: readonly ScaleSweepRow[];
}

interface ShrinkReport {
  readonly kind: "shrink";
}

interface MemoryRow {
  readonly name: string;
  readonly heapBytesPerEntry: number | null;
  readonly residentBytesPerEntry: number;
}

interface MemoryReport {
  readonly kind: "memory";
  readonly entries: number;
  readonly slotBytes: { readonly u32: number; readonly u64: number };
  readonly reservedBytes: { readonly u32: number; readonly u64: number };
  readonly slots: number;
  readonly rows: readonly MemoryRow[];
}

type ReportEntry =
  | ContenderReport
  | ScaleSweepReport
  | ShrinkReport
  | MemoryReport;

interface HostInfo {
  readonly runtime: string;
  readonly label: string;
  readonly engine: string;
  readonly os: string;
  readonly arch: string;
  readonly cpu: string;
  readonly gcAvailable: boolean;
  readonly timerResolutionNs: number;
}

interface Payload {
  readonly schema: number;
  readonly host: HostInfo;
  readonly entryCount: number;
  readonly measuredRounds: number;
  readonly isolated: boolean;
  readonly reports: readonly ReportEntry[];
}

/** Column order, which is engine order: JSC, then V8, then SpiderMonkey. */
const RUNTIME_ORDER = ["bun", "node", "deno", "chrome", "firefox"];

/** One runtime's passes, which the tables reduce to a single column. */
interface Column {
  readonly key: string;
  readonly label: string;
  readonly passes: readonly Payload[];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

interface Workload {
  readonly row: string;
  /** Every token must appear in the scenario title. */
  readonly tokens: readonly string[];
  /**
   * Tokens that must not appear, separating scenarios whose titles are
   * otherwise subsets of each other — `fill … sparse keys` is a substring
   * match for the u64 and u32 bulk fills as well as for the plain one.
   */
  readonly excludes?: readonly string[];
  readonly swiss: string;
  readonly baseline: string;
  /** Whether the README's short table carries this row. */
  readonly headline?: boolean;
}

const WORKLOADS: readonly Workload[] = [
  {
    row: "fill, sparse (pre-sized)",
    tokens: ["fill", "sparse"],
    excludes: ["u64", "u32 values"],
    swiss: "SwissU32ToU32 (wasm, pre-sized)",
    baseline: "Map",
    headline: true,
  },
  {
    row: "fill, sparse (grown from empty)",
    tokens: ["fill", "sparse"],
    excludes: ["u64", "u32 values"],
    swiss: "SwissU32ToU32 (wasm, grown)",
    baseline: "Map",
  },
  {
    row: "fill, dense (pre-sized)",
    tokens: ["fill", "dense"],
    swiss: "SwissU32ToU32 (wasm, pre-sized)",
    baseline: "Map",
  },
  {
    row: "lookup hit, sparse",
    tokens: ["lookup hit", "sparse"],
    swiss: "SwissU32ToU32 (wasm)",
    baseline: "Map",
    headline: true,
  },
  {
    row: "lookup miss, sparse",
    tokens: ["lookup miss", "sparse"],
    swiss: "SwissU32ToU32 (wasm)",
    baseline: "Map",
    headline: true,
  },
  {
    row: "lookup hit, dense",
    tokens: ["lookup hit", "dense"],
    swiss: "SwissU32ToU32 (wasm)",
    baseline: "Map",
  },
  {
    row: "lookup miss, dense",
    tokens: ["lookup miss", "dense"],
    swiss: "SwissU32ToU32 (wasm)",
    baseline: "Map",
  },
  {
    row: "`has`, sparse",
    tokens: ["has", "sparse keys"],
    swiss: "SwissU32ToU32.has (wasm)",
    baseline: "Map.has",
    headline: true,
  },
  {
    row: "overwrite an existing key",
    tokens: ["overwrite"],
    swiss: "SwissU32ToU32.set (wasm)",
    baseline: "Map.set",
    headline: true,
  },
  {
    row: "delete",
    tokens: ["delete"],
    excludes: ["u64"],
    swiss: "SwissU32ToU32.delete (wasm)",
    baseline: "Map.delete",
    headline: true,
  },
  {
    row: "churn (delete + reinsert)",
    tokens: ["churn"],
    swiss: "SwissU32ToU32 delete + set (wasm)",
    baseline: "Map delete + set",
    headline: true,
  },
  {
    row: "count (`increment`)",
    tokens: ["increments over"],
    swiss: "SwissU32ToU32.increment (wasm)",
    baseline: "Map",
    headline: true,
  },
  {
    row: "`getOrInsert`, key absent",
    tokens: ["none present"],
    swiss: "SwissU32ToU32.getOrInsert (wasm)",
    baseline: "Map.get, then set if absent",
  },
  {
    row: "u32 bulk fill (`setMany`)",
    tokens: ["u32 values: fill"],
    swiss: "SwissU32ToU32.setMany (wasm)",
    baseline: "Map",
    headline: true,
  },
  {
    row: "u32 bulk lookup (`getMany`)",
    tokens: ["u32 values: lookup"],
    swiss: "SwissU32ToU32.getMany (wasm, reused out)",
    baseline: "Map",
    headline: true,
  },
  {
    row: "u64 bulk fill (`setMany`)",
    tokens: ["u64 values: fill"],
    swiss: "SwissU32ToU64.setMany (wasm)",
    baseline: "Map<number, {lo,hi}>",
    headline: true,
  },
  {
    row: "u64 bulk lookup (`getMany`)",
    tokens: ["u64 values: lookup"],
    swiss: "SwissU32ToU64.getMany (wasm)",
    baseline: "Map<number, bigint>",
    headline: true,
  },
  {
    row: "u64 bulk delete (`deleteMany`)",
    tokens: ["u64 delete"],
    swiss: "SwissU32ToU64.deleteMany (wasm)",
    baseline: "Map<number, bigint>.delete",
  },
  {
    row: "iterate (`forEach`)",
    tokens: ["iterate"],
    swiss: "SwissU32ToU32 forEach",
    baseline: "Map forEach",
  },
  {
    row: "string keys, repeated lookup",
    tokens: ["string keys: lookup"],
    swiss: "InternedSwissMap (wasm + Map)",
    baseline: "Map<string, number>",
  },
];

interface Cell {
  readonly swiss: number;
  readonly baseline: number;
}

function findScenario(
  payload: Payload,
  workload: Workload,
): ContenderReport | null {
  for (const report of payload.reports) {
    if (report.kind !== "contenders") continue;

    const title = report.scenario.toLowerCase();
    const matches = workload.tokens.every((token) =>
      title.includes(token.toLowerCase()),
    );

    if (!matches) continue;
    if (workload.excludes?.some((token) => title.includes(token))) continue;

    return report;
  }

  return null;
}

function cellForPass(payload: Payload, workload: Workload): Cell | null {
  const report = findScenario(payload, workload);
  if (report === null) return null;

  const swiss = report.results.find((entry) => entry.name === workload.swiss);
  const baseline = report.results.find(
    (entry) => entry.name === workload.baseline,
  );

  if (swiss === undefined || baseline === undefined) return null;
  return { swiss: swiss.nsPerOp, baseline: baseline.nsPerOp };
}

/**
 * One cell, as the median across passes.
 *
 * Each side is reduced on its own and the ratio is taken afterwards, which
 * is what "median of n runs" has to mean when the two contenders are timed
 * independently.
 */
function cellFor(column: Column, workload: Workload): Cell | null {
  const cells = column.passes
    .map((pass) => cellForPass(pass, workload))
    .filter((cell): cell is Cell => cell !== null);

  if (cells.length === 0) return null;

  return {
    swiss: median(cells.map((cell) => cell.swiss)),
    baseline: median(cells.map((cell) => cell.baseline)),
  };
}

/** `9.0x`, or `0.91x` when `Map` is the faster of the two. */
function speedup(cell: Cell): string {
  const ratio = cell.baseline / cell.swiss;
  return ratio >= 10 ? `${ratio.toFixed(0)}x` : `${ratio.toFixed(ratio < 2 ? 2 : 1)}x`;
}

function absolute(cell: Cell): string {
  return `${cell.swiss.toFixed(1)} / ${cell.baseline.toFixed(1)}`;
}

function markdownTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];

  return lines.join("\n");
}

interface Options {
  readonly results: string;
  readonly section: "all" | "readme" | "docs";
}

function parseArgs(argv: readonly string[]): Options {
  // fileURLToPath, not `.pathname`: on Windows the latter keeps the URL's
  // leading slash, and `/D:/...` is not a path any process can open.
  let results = fileURLToPath(new URL("./results/", import.meta.url));
  let section: Options["section"] = "all";

  for (const arg of argv) {
    if (arg.startsWith("--results=")) {
      results = arg.slice("--results=".length);
    } else if (arg.startsWith("--section=")) {
      const value = arg.slice("--section=".length);
      if (value !== "all" && value !== "readme" && value !== "docs") {
        throw new Error(`bench: unknown section "${value}"`);
      }
      section = value;
    } else {
      throw new Error(`bench: unrecognized argument "${arg}"`);
    }
  }

  return { results, section };
}

const options = parseArgs(Bun.argv.slice(2));

const files = (await readdir(options.results)).filter((name) =>
  name.endsWith(".json"),
);

const payloads: Payload[] = [];
for (const file of files) {
  const text = await readFile(`${options.results}/${file}`, "utf8");
  payloads.push(JSON.parse(text) as Payload);
}

if (payloads.length === 0) {
  throw new Error(`bench: no result files in ${options.results}`);
}

/** `chrome` or `firefox`, so both browsers get their own column. */
function browserKey(payload: Payload): string {
  return payload.host.label.split(" ")[0]!.toLowerCase();
}

function columnKey(payload: Payload): string {
  return payload.host.runtime === "browser"
    ? browserKey(payload)
    : payload.host.runtime;
}

const grouped = new Map<string, Payload[]>();
for (const payload of payloads) {
  const key = columnKey(payload);
  grouped.set(key, [...(grouped.get(key) ?? []), payload]);
}

const columnList: Column[] = [...grouped.entries()]
  .map(([key, passes]) => ({ key, label: passes[0]!.host.label, passes }))
  .sort(
    (a, b) => RUNTIME_ORDER.indexOf(a.key) - RUNTIME_ORDER.indexOf(b.key),
  );

const columns = columnList.map((column) => column.label);

// A page cannot see the CPU it is running on, so the machine is described
// from a server runtime — the same machine either way.
const hardware =
  payloads.find((payload) => payload.host.runtime !== "browser") ?? payloads[0]!;

function speedupRows(headlineOnly: boolean): string[][] {
  const rows: string[][] = [];

  for (const workload of WORKLOADS) {
    if (headlineOnly && workload.headline !== true) continue;

    const cells = columnList.map((column) => {
      const cell = cellFor(column, workload);
      return cell === null ? "—" : speedup(cell);
    });

    if (cells.every((cell) => cell === "—")) continue;
    rows.push([workload.row, ...cells]);
  }

  return rows;
}

function absoluteRows(): string[][] {
  const rows: string[][] = [];

  for (const workload of WORKLOADS) {
    const cells = columnList.map((column) => {
      const cell = cellFor(column, workload);
      return cell === null ? "—" : absolute(cell);
    });

    if (cells.every((cell) => cell === "—")) continue;
    rows.push([workload.row, ...cells]);
  }

  return rows;
}

function crossoverRows(): string[][] {
  const sizes = new Set<number>();

  // Per column, per size, the passes that measured it — reduced by median
  // the same way every other cell is.
  const perRuntime = columnList.map((column) => {
    const byEntries = new Map<number, ScaleSweepRow[]>();

    for (const pass of column.passes) {
      const sweep = pass.reports.find(
        (report): report is ScaleSweepReport => report.kind === "scale-sweep",
      );

      for (const row of sweep?.rows ?? []) {
        byEntries.set(row.entries, [...(byEntries.get(row.entries) ?? []), row]);
        sizes.add(row.entries);
      }
    }

    return byEntries;
  });

  return [...sizes]
    .sort((a, b) => a - b)
    .map((entries) => [
      entries.toLocaleString("en-US"),
      ...perRuntime.map((byEntries) => {
        const rows = byEntries.get(entries);
        if (rows === undefined || rows.length === 0) return "—";

        // How much faster the SwissTable is, so a value below 1.0 is a loss
        // to `Map` and the crossover is where a column passes 1.00x.
        const swiss = median(rows.map((row) => row.swissNsPerOp));
        const map = median(rows.map((row) => row.mapNsPerOp));
        return `${(map / swiss).toFixed(2)}x`;
      }),
    ]);
}

/**
 * Bytes per entry, per container, per runtime.
 *
 * The heap figure is the comparable one and the only one reported here: a
 * resident-set delta counts a WASM arena in full while a `Map` disappears
 * into heap pages the engine had already committed, which makes the two
 * incomparable in opposite directions.
 */
function memoryRows(): string[][] {
  const names: string[] = [];
  const byName = new Map<string, Map<string, number[]>>();

  for (const column of columnList) {
    for (const pass of column.passes) {
      const report = pass.reports.find(
        (entry): entry is MemoryReport => entry.kind === "memory",
      );

      for (const row of report?.rows ?? []) {
        if (row.heapBytesPerEntry === null) continue;
        if (!byName.has(row.name)) {
          byName.set(row.name, new Map());
          names.push(row.name);
        }

        const perRuntime = byName.get(row.name)!;
        perRuntime.set(column.key, [
          ...(perRuntime.get(column.key) ?? []),
          row.heapBytesPerEntry,
        ]);
      }
    }
  }

  return names.map((name) => [
    name,
    ...columnList.map((column) => {
      const samples = byName.get(name)?.get(column.key);
      return samples === undefined ? "—" : `${median(samples).toFixed(1)} B`;
    }),
  ]);
}

/** The tables' own cost, which is layout rather than measurement. */
function memorySummary(): string | null {
  for (const column of columnList) {
    for (const pass of column.passes) {
      const report = pass.reports.find(
        (entry): entry is MemoryReport => entry.kind === "memory",
      );

      if (report === undefined) continue;

      const ceiling = (report.slots * 7) / 8;
      const perEntry = (bytes: number): string =>
        ((report.slots * bytes) / ceiling).toFixed(1);

      return (
        `Measured at ${report.entries.toLocaleString("en-US")} entries, each ` +
        `container built once in a process of its own.\n\n` +
        `The tables are not on the heap and are not measured the same way. A ` +
        `slot costs ${report.slotBytes.u32} B (u32) or ` +
        `${report.slotBytes.u64} B (u64) of linear memory, both banks ` +
        `counted — at the 7/8 load ceiling that is ` +
        `${perEntry(report.slotBytes.u32)} B/entry and ` +
        `${perEntry(report.slotBytes.u64)} B/entry, of which ` +
        `${perEntry(report.slotBytes.u32 / 2)} B and ` +
        `${perEntry(report.slotBytes.u64 / 2)} B are the live bank the ` +
        `entries are actually in. An instance reserves ` +
        `${(report.reservedBytes.u32 / (1024 * 1024)).toFixed(0)} MiB (u32) or ` +
        `${(report.reservedBytes.u64 / (1024 * 1024)).toFixed(0)} MiB (u64) of ` +
        `address space up front, committed page by page as it is touched.`
      );
    }
  }

  return null;
}

const sections: string[] = [];

if (options.section !== "readme") {
  sections.push(
    "### Runtimes measured\n\n" +
      markdownTable(
        ["runtime", "engine", "collector on demand", "clock resolution"],
        columnList.map((column) => {
          const host = column.passes[0]!.host;
          return [
            host.label,
            host.engine,
            host.gcAvailable ? "yes" : "no",
            `${(host.timerResolutionNs / 1000).toFixed(host.timerResolutionNs < 1000 ? 2 : 0)} us`,
          ];
        }),
      ) +
      `\n\n${hardware.host.cpu}, ${hardware.host.os} ${hardware.host.arch}. ` +
      `${payloads[0]!.entryCount.toLocaleString("en-US")} entries, median of ` +
      `${payloads[0]!.measuredRounds} rounds, median of ` +
      `${columnList[0]!.passes.length} passes, one isolate per contender.`,
  );

  sections.push(
    "### Speedup against `Map`, by runtime\n\n" +
      markdownTable(["workload", ...columns], speedupRows(false)),
  );

  sections.push(
    "### ns per operation — SwissTable / `Map`\n\n" +
      markdownTable(["workload", ...columns], absoluteRows()),
  );

  sections.push(
    "### Crossover: lookup speedup against `Map` by entry count\n\n" +
      markdownTable(["entries", ...columns], crossoverRows()),
  );

  const summary = memorySummary();
  if (summary !== null) {
    sections.push(
      "### Bytes per entry on the JavaScript heap\n\n" +
        markdownTable(["container", ...columns], memoryRows()) +
        `\n\n${summary}`,
    );
  }
}

if (options.section !== "docs") {
  sections.push(
    "### README highlights\n\n" +
      markdownTable(["Workload", ...columns], speedupRows(true)),
  );
}

console.log(sections.join("\n\n"));
