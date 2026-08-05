#!/usr/bin/env bun
/**
 * Throughput comparison against the built-in JavaScript containers.
 *
 * Every contender stores the same u32 -> u32 pairs and is exercised through
 * the same operation sequence, so the numbers differ only by container.
 * Run `bun run build` first; the WASM contenders need dist/wasm.
 *
 * Usage: bun run bench [--scenario=name,...] [--json] [--help]
 * Scenarios: fill, lookup, bulk, string-keys, iteration, shrink, scale-sweep
 */

import { InternedSwissMap, SwissU32ToU32, SwissU32ToU64 } from "../src/index.ts";
import type { U64Lanes } from "../src/index.ts";

const ENTRY_COUNT = 100_000;
const WARMUP_ROUNDS = 3;
const MEASURED_ROUNDS = 7;
const NS_PER_SECOND = 1_000_000_000;

/**
 * Read-only rounds repeat the workload until a round covers at least this
 * many operations, so timer and closure overhead stay negligible against
 * the measured work even for small tables.
 */
const MIN_OPS_PER_ROUND = 2_000_000;
const MISS_KEY_OFFSET = 0x4000_0000;

const U32_WASM = new URL("../dist/wasm/swiss_u32.wasm", import.meta.url);
const U64_WASM = new URL("../dist/wasm/swiss_u64.wasm", import.meta.url);

/** xorshift32, so every run sees the same keys. */
function makeSparseKeys(count: number, seed = 0x9e3779b9): Uint32Array {
  const keys = new Uint32Array(count);
  const seen = new Set<number>();
  let state = seed;

  for (let i = 0; i < count; ) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;

    if (state === 0 || seen.has(state)) continue;

    seen.add(state);
    keys[i++] = state;
  }

  return keys;
}

function makeDenseKeys(count: number): Uint32Array {
  return Uint32Array.from({ length: count }, (_, i) => i);
}

interface Contender {
  readonly name: string;
  /**
   * Prepares state and returns the operation to time. May be async, so a
   * contender can instantiate a fresh WASM module per round; the await
   * happens outside the timed region.
   */
  readonly prepare: () => (() => number) | Promise<() => number>;
}

interface Result {
  readonly name: string;
  readonly nsPerOp: number;
  readonly opsPerSecond: number;
}

/**
 * Counts how many of `count` probes hit, without allocating per probe.
 * Every lookup contender below is "iterate probes, count hits" with a
 * different `hit` test — factoring the loop out is what keeps that shape
 * from being retyped for Map, Object, Int32Array, and every table variant.
 */
function countMatches(count: number, hit: (index: number) => boolean): number {
  let found = 0;
  for (let i = 0; i < count; i++) if (hit(i)) found++;
  return found;
}

/** A {@link Contender} whose timed region is {@link countMatches}. */
function lookupContender(
  name: string,
  count: number,
  hit: (index: number) => boolean,
): Contender {
  return { name, prepare: () => () => countMatches(count, hit) };
}

/**
 * Reports the best round rather than the mean: the fastest round is the one
 * least polluted by GC pauses and scheduler noise.
 *
 * `repeatable` marks a workload that leaves no state behind (lookups), which
 * may be replayed within a round to amortize harness overhead. Workloads
 * that mutate the container must not be replayed: the second pass would
 * overwrite rather than insert, and would no longer be the same workload.
 */
async function measure(
  contender: Contender,
  operations: number,
  repeatable = false,
): Promise<Result> {
  const replays = repeatable
    ? Math.max(1, Math.ceil(MIN_OPS_PER_ROUND / operations))
    : 1;

  let checksum = 0;

  for (let round = 0; round < WARMUP_ROUNDS; round++) {
    const run = await contender.prepare();
    for (let replay = 0; replay < replays; replay++) checksum += run();
  }

  let bestNs = Number.POSITIVE_INFINITY;

  for (let round = 0; round < MEASURED_ROUNDS; round++) {
    const run = await contender.prepare();

    const start = Bun.nanoseconds();
    for (let replay = 0; replay < replays; replay++) checksum += run();
    const elapsed = (Bun.nanoseconds() - start) / replays;

    if (elapsed < bestNs) bestNs = elapsed;
  }

  if (checksum === Number.MAX_SAFE_INTEGER) console.log(""); // keep the work live

  return {
    name: contender.name,
    nsPerOp: bestNs / operations,
    opsPerSecond: (operations * NS_PER_SECOND) / bestNs,
  };
}

/**
 * Measures contenders strictly one at a time. Running them concurrently
 * would interleave their work inside each other's timed regions.
 */
async function measureAll(
  contenders: readonly Contender[],
  operations: number,
  repeatable = false,
): Promise<Result[]> {
  const results: Result[] = [];
  for (const contender of contenders) {
    results.push(await measure(contender, operations, repeatable));
  }
  return results;
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
  readonly winner: "SwissTable" | "Map";
}

interface ScaleSweepReport {
  readonly kind: "scale-sweep";
  readonly rows: readonly ScaleSweepRow[];
}

interface ShrinkReport {
  readonly kind: "shrink";
  readonly peak: number;
  readonly remaining: number;
  readonly beforeNsPerOp: number;
  readonly afterNsPerOp: number;
  readonly grownCapacitySlots: number;
  readonly shrunkCapacitySlots: number;
}

type ReportEntry = ContenderReport | ScaleSweepReport | ShrinkReport;

/** Every scenario's results, in run order — dumped whole under `--json`. */
const reports: ReportEntry[] = [];

/** Set once from argv, before any scenario runs; read by every report sink. */
let jsonMode = false;

function report(scenario: string, results: readonly Result[]): void {
  reports.push({ kind: "contenders", scenario, results });
  if (jsonMode) return;

  const fastest = Math.min(...results.map((result) => result.nsPerOp));
  const width = Math.max(...results.map((result) => result.name.length));

  console.log(`\n${scenario}`);
  console.log("-".repeat(scenario.length));

  for (const result of [...results].sort((a, b) => a.nsPerOp - b.nsPerOp)) {
    const name = result.name.padEnd(width);
    const nsPerOp = result.nsPerOp.toFixed(1).padStart(7);
    const millionsPerSecond = (result.opsPerSecond / 1e6).toFixed(1).padStart(7);
    const relative = (result.nsPerOp / fastest).toFixed(2).padStart(5);

    console.log(`  ${name}  ${nsPerOp} ns/op  ${millionsPerSecond} M ops/s  ${relative}x`);
  }
}

const u32Bytes = await Bun.file(U32_WASM).arrayBuffer();
const u64Bytes = await Bun.file(U64_WASM).arrayBuffer();

const swiss = await SwissU32ToU32.load(u32Bytes, ENTRY_COUNT);
const swiss64 = await SwissU32ToU64.load(u64Bytes, ENTRY_COUNT);

/**
 * The SwissTable appears twice on purpose.
 *
 * `Map` and `Object` cannot be pre-sized in JavaScript, so they always grow
 * from empty and pay for every internal rehash inside the timed region.
 * Timing only a pre-sized table would quietly compare against a container
 * that was handed its final capacity for free. The grown-from-empty row is
 * the like-for-like comparison; the pre-sized row is what a caller actually
 * gets by passing `expectedEntries`, which is the documented usage.
 *
 * Only fill is affected. A grown table converges on exactly the capacity a
 * pre-sized one starts with (both reach 131,072 slots at 100k entries), so
 * the lookup scenarios measure an identical working set either way.
 */
async function fillScenario(label: string, keys: Uint32Array): Promise<void> {
  const count = keys.length;

  const contenders: Contender[] = [
    {
      name: "SwissU32ToU32 (wasm, pre-sized)",
      prepare: () => {
        swiss.clear();
        return () => {
          for (let i = 0; i < count; i++) swiss.set(keys[i]!, i);
          return swiss.size;
        };
      },
    },
    {
      name: "SwissU32ToU32 (wasm, grown)",
      prepare: async () => {
        const table = await SwissU32ToU32.load(u32Bytes);
        return () => {
          for (let i = 0; i < count; i++) table.set(keys[i]!, i);
          return table.size;
        };
      },
    },
    {
      name: "Map",
      prepare: () => {
        const map = new Map<number, number>();
        return () => {
          for (let i = 0; i < count; i++) map.set(keys[i]!, i);
          return map.size;
        };
      },
    },
    {
      name: "Object (numeric keys)",
      prepare: () => {
        const object: Record<number, number> = {};
        return () => {
          for (let i = 0; i < count; i++) object[keys[i]!] = i;
          // A cheap read rather than Object.keys().length: that call
          // materializes a `count`-element string array inside the timed
          // region, while the Map and SwissTable contenders return an O(1)
          // size — it would charge this contender for work it never does.
          return object[keys[0]!]!;
        };
      },
    },
  ];

  if (label.startsWith("dense")) {
    contenders.push({
      name: "Int32Array (direct index)",
      prepare: () => {
        const array = new Int32Array(count);
        return () => {
          for (let i = 0; i < count; i++) array[keys[i]!] = i;
          return array.length;
        };
      },
    });
  }

  report(
    `fill ${count.toLocaleString()} entries — ${label}`,
    await measureAll(contenders, count),
  );
}

async function lookupScenario(
  label: string,
  keys: Uint32Array,
  hit: boolean,
): Promise<void> {
  const count = keys.length;
  const probes = hit
    ? keys
    : Uint32Array.from(keys, (key) => (key ^ MISS_KEY_OFFSET) >>> 0);

  const map = new Map<number, number>();
  const object: Record<number, number> = {};
  const array = new Int32Array(count);

  swiss.clear();

  for (let i = 0; i < count; i++) {
    swiss.set(keys[i]!, i);
    map.set(keys[i]!, i);
    object[keys[i]!] = i;
    if (keys[i]! < count) array[keys[i]!] = i;
  }

  const contenders: Contender[] = [
    lookupContender("SwissU32ToU32 (wasm)", count, (i) => swiss.get(probes[i]!) !== undefined),
    lookupContender("Map", count, (i) => map.get(probes[i]!) !== undefined),
    lookupContender(
      "Object (numeric keys)",
      count,
      (i) => object[probes[i]!] !== undefined,
    ),
  ];

  if (label.startsWith("dense")) {
    contenders.push(
      lookupContender("Int32Array (direct index)", count, (i) => {
        const key = probes[i]!;
        return key < count && array[key] !== undefined;
      }),
    );
  }

  report(
    `lookup ${hit ? "hit" : "miss"} — ${label}`,
    await measureAll(contenders, count, true),
  );
}

async function bulkScenario(keys: Uint32Array): Promise<void> {
  const count = keys.length;
  const valsLo = Uint32Array.from({ length: count }, (_, i) => i);
  const valsHi = Uint32Array.from({ length: count }, (_, i) => i * 2);

  const contenders: Contender[] = [
    {
      // No grown counterpart: set_many reserves for the whole batch in one
      // shot before inserting, so it sizes itself regardless of where it
      // starts. Pre-sizing is not a factor here the way it is for set().
      name: "SwissU32ToU64.setMany (wasm)",
      prepare: () => {
        swiss64.clear();
        return () => {
          swiss64.setMany(keys, valsLo, valsHi);
          return swiss64.size;
        };
      },
    },
    {
      name: "SwissU32ToU64.set (per key, pre-sized)",
      prepare: () => {
        swiss64.clear();
        return () => {
          for (let i = 0; i < count; i++) {
            swiss64.set(keys[i]!, valsLo[i]!, valsHi[i]!);
          }
          return swiss64.size;
        };
      },
    },
    {
      name: "SwissU32ToU64.set (per key, grown)",
      prepare: async () => {
        const table = await SwissU32ToU64.load(u64Bytes);
        return () => {
          for (let i = 0; i < count; i++) {
            table.set(keys[i]!, valsLo[i]!, valsHi[i]!);
          }
          return table.size;
        };
      },
    },
    {
      name: "Map<number, bigint>",
      prepare: () => {
        const map = new Map<number, bigint>();
        return () => {
          for (let i = 0; i < count; i++) {
            map.set(keys[i]!, (BigInt(valsHi[i]!) << 32n) | BigInt(valsLo[i]!));
          }
          return map.size;
        };
      },
    },
    {
      name: "Map<number, {lo,hi}>",
      prepare: () => {
        const map = new Map<number, { lo: number; hi: number }>();
        return () => {
          for (let i = 0; i < count; i++) {
            map.set(keys[i]!, { lo: valsLo[i]!, hi: valsHi[i]! });
          }
          return map.size;
        };
      },
    },
  ];

  report(
    `u64 values: fill ${count.toLocaleString()} entries — sparse keys`,
    await measureAll(contenders, count),
  );

  swiss64.clear();
  swiss64.setMany(keys, valsLo, valsHi);

  const bigintMap = new Map<number, bigint>();
  for (let i = 0; i < count; i++) {
    bigintMap.set(keys[i]!, (BigInt(valsHi[i]!) << 32n) | BigInt(valsLo[i]!));
  }

  report(
    `u64 values: lookup ${count.toLocaleString()} keys — sparse keys`,
    await measureAll(
      [
        {
          name: "SwissU32ToU64.getMany (wasm)",
          prepare: () => () => swiss64.getMany(keys).found.length,
        },
        lookupContender(
          "SwissU32ToU64.get (per key)",
          count,
          (i) => swiss64.get(keys[i]!) !== undefined,
        ),
        lookupContender(
          "Map<number, bigint>",
          count,
          (i) => bigintMap.get(keys[i]!) !== undefined,
        ),
      ],
      count,
      true,
    ),
  );
}

async function stringKeyScenario(count: number): Promise<void> {
  const strings = Array.from({ length: count }, (_, i) => `token:${i}:${i * 7}`);

  const interned = new InternedSwissMap<number>(swiss);
  swiss.clear();

  const map = new Map<string, number>();
  const object: Record<string, number> = Object.create(null);

  for (let i = 0; i < count; i++) {
    interned.set(strings[i]!, i);
    map.set(strings[i]!, i);
    object[strings[i]!] = i;
  }

  report(
    `string keys: lookup ${count.toLocaleString()} keys`,
    await measureAll(
      [
        lookupContender(
          "InternedSwissMap (wasm + Map)",
          count,
          (i) => interned.get(strings[i]!) !== undefined,
        ),
        lookupContender(
          "Map<string, number>",
          count,
          (i) => map.get(strings[i]!) !== undefined,
        ),
        lookupContender(
          "Object (string keys)",
          count,
          (i) => object[strings[i]!] !== undefined,
        ),
      ],
      count,
      true,
    ),
  );
}

/**
 * Lookup cost is dominated by serialized random memory accesses, so it is a
 * function of working-set size. The tables store ~10 B/entry against Map's
 * ~24-32 B/entry, which only pays off once Map spills a cache level and the
 * tables do not — a crossover in N, not a constant factor. Sweep to find it.
 */
async function scaleSweep(sizes: readonly number[]): Promise<void> {
  const rows: ScaleSweepRow[] = [];

  for (const count of sizes) {
    const keys = makeSparseKeys(count);
    const map = new Map<number, number>();

    // A fresh instance per size: clear() retains the capacity of the
    // previous, larger run, which would inflate the smaller sizes.
    const table = await SwissU32ToU32.load(u32Bytes, count);

    for (let i = 0; i < count; i++) {
      table.set(keys[i]!, i);
      map.set(keys[i]!, i);
    }

    const swissResult = await measure(
      lookupContender("swiss", count, (i) => table.get(keys[i]!) !== undefined),
      count,
      true,
    );

    const mapResult = await measure(
      lookupContender("map", count, (i) => map.get(keys[i]!) !== undefined),
      count,
      true,
    );

    const ratio = swissResult.nsPerOp / mapResult.nsPerOp;

    rows.push({
      entries: count,
      swissNsPerOp: swissResult.nsPerOp,
      mapNsPerOp: mapResult.nsPerOp,
      ratio,
      winner: ratio < 1 ? "SwissTable" : "Map",
    });
  }

  reports.push({ kind: "scale-sweep", rows });
  if (jsonMode) return;

  console.log("\nsingle-key lookup vs entry count — sparse keys");
  console.log("---------------------------------------------");
  console.log("      entries    Swiss      Map  ratio  winner");
  for (const row of rows) {
    console.log(
      `  ${row.entries.toLocaleString().padStart(10)}  ` +
        `${row.swissNsPerOp.toFixed(1).padStart(7)} ns  ` +
        `${row.mapNsPerOp.toFixed(1).padStart(7)} ns  ` +
        `${row.ratio.toFixed(2).padStart(5)}x  ${row.winner}`,
    );
  }
}

/**
 * Whole-table walks, which are a different shape of work from the lookup
 * scenarios: one WASM crossing per window of slots rather than one per key,
 * and a per-entry cost that is mostly whatever the walk has to allocate.
 *
 * Every contender visits the same entries and reads both halves of each, so
 * a contender cannot win by skipping a column it was not asked for. The
 * callback sums rather than discards for the same reason — an empty body is
 * optimisable in a way a real caller's is not.
 *
 * This is what the design notes in abi.ts and the two bindings are asserting
 * about: that forEach beats the iterator protocol, and that the u64 walk
 * paying an object per entry is worth avoiding. Without it, those comments
 * cite measurements nobody can reproduce.
 *
 * The two u64 walks come in a discarding and a retaining pair on purpose.
 * When the callback drops the lanes, escape analysis scalar-replaces the
 * object forEach built and the two run level — so a benchmark that only
 * discarded would read as though the allocation were free. It is free only
 * while the JIT can prove it does not outlive the call, which a caller that
 * keeps the lanes does not let it prove. The retaining pair is where the
 * difference is real, and it is the reason forEachLanes exists: it never
 * depends on that proof holding.
 */
async function iterationScenario(keys: Uint32Array): Promise<void> {
  const count = keys.length;

  const map = new Map<number, number>();
  const table = await SwissU32ToU32.load(u32Bytes, count);
  const table64 = await SwissU32ToU64.load(u64Bytes, count);

  for (let i = 0; i < count; i++) {
    map.set(keys[i]!, i);
    table.set(keys[i]!, i);
    table64.set(keys[i]!, i, i);
  }

  const contenders: Contender[] = [
    {
      name: "SwissU32ToU32 forEach",
      prepare: () => () => {
        let sum = 0;
        table.forEach((value, key) => {
          sum = (sum + value + key) >>> 0;
        });
        return sum;
      },
    },
    {
      name: "SwissU32ToU32 for..of entries()",
      prepare: () => () => {
        let sum = 0;
        for (const [key, value] of table) sum = (sum + value + key) >>> 0;
        return sum;
      },
    },
    {
      name: "SwissU32ToU32 keys()",
      prepare: () => () => {
        let sum = 0;
        for (const key of table.keys()) sum = (sum + key) >>> 0;
        return sum;
      },
    },
    {
      name: "SwissU32ToU64 forEachLanes",
      prepare: () => () => {
        let sum = 0;
        table64.forEachLanes((lo, hi, key) => {
          sum = (sum + lo + hi + key) >>> 0;
        });
        return sum;
      },
    },
    {
      name: "SwissU32ToU64 forEach (boxes lanes)",
      prepare: () => () => {
        let sum = 0;
        table64.forEach((value, key) => {
          sum = (sum + value.lo + value.hi + key) >>> 0;
        });
        return sum;
      },
    },
    {
      name: "SwissU32ToU64 forEachLanes, lanes kept",
      prepare: () => {
        const lo = new Uint32Array(count);
        const hi = new Uint32Array(count);
        return () => {
          let at = 0;
          table64.forEachLanes((entryLo, entryHi) => {
            lo[at] = entryLo;
            hi[at] = entryHi;
            at++;
          });
          return at;
        };
      },
    },
    {
      name: "SwissU32ToU64 forEach, lanes kept",
      prepare: () => {
        const kept = new Array<U64Lanes>(count);
        return () => {
          let at = 0;
          table64.forEach((value) => {
            kept[at++] = value;
          });
          return at;
        };
      },
    },
    {
      name: "Map forEach",
      prepare: () => () => {
        let sum = 0;
        map.forEach((value, key) => {
          sum = (sum + value + key) >>> 0;
        });
        return sum;
      },
    },
    {
      name: "Map for..of entries()",
      prepare: () => () => {
        let sum = 0;
        for (const [key, value] of map) sum = (sum + value + key) >>> 0;
        return sum;
      },
    },
  ];

  report(
    `iterate ${count.toLocaleString()} entries — sparse keys`,
    await measureAll(contenders, count, true),
  );
}

/**
 * What a walk costs after the table has shrunk but its capacity has not.
 *
 * A scan visits every slot, so the cost of a walk tracks capacity, not size
 * — and capacity only ever rises on its own. A table that peaked large and
 * was then emptied keeps paying peak walk cost on every subsequent walk
 * until shrinkToFit() hands the slots back. Reported per walk rather than
 * per entry: there are almost no entries left, which is the point.
 *
 * The walks are measured as one operation each and explicitly not marked
 * repeatable. A repeatable one-operation workload would be replayed until
 * the round covered MIN_OPS_PER_ROUND, which here means two million walks.
 */
async function shrinkScenario(peak: number, remaining: number): Promise<void> {
  const keys = makeSparseKeys(peak);
  const table = await SwissU32ToU32.load(u32Bytes, peak);

  for (let i = 0; i < peak; i++) table.set(keys[i]!, i);
  for (let i = remaining; i < peak; i++) table.delete(keys[i]!);

  const walk = (): number => {
    let seen = 0;
    table.forEach(() => {
      seen++;
    });
    return seen;
  };

  const before = await measure({ name: "before", prepare: () => walk }, 1);
  const grownCapacitySlots = table.capacity;

  table.shrinkToFit();

  const after = await measure({ name: "after", prepare: () => walk }, 1);
  const shrunkCapacitySlots = table.capacity;

  reports.push({
    kind: "shrink",
    peak,
    remaining,
    beforeNsPerOp: before.nsPerOp,
    afterNsPerOp: after.nsPerOp,
    grownCapacitySlots,
    shrunkCapacitySlots,
  });
  if (jsonMode) return;

  console.log(
    `\nwalk ${remaining} entries left from a peak of ${peak.toLocaleString()}`,
  );
  console.log("-".repeat(52));
  console.log(
    `  before shrinkToFit  ${(before.nsPerOp / 1000).toFixed(1).padStart(8)} us` +
      `  ${grownCapacitySlots.toLocaleString().padStart(9)} slots`,
  );
  console.log(
    `  after  shrinkToFit  ${(after.nsPerOp / 1000).toFixed(1).padStart(8)} us` +
      `  ${shrunkCapacitySlots.toLocaleString().padStart(9)} slots` +
      `  ${(before.nsPerOp / after.nsPerOp).toFixed(1)}x faster`,
  );
}

const SCENARIO_NAMES = [
  "fill",
  "lookup",
  "bulk",
  "string-keys",
  "iteration",
  "shrink",
  "scale-sweep",
] as const;
type ScenarioName = (typeof SCENARIO_NAMES)[number];

interface CliOptions {
  readonly json: boolean;
  readonly scenarios: ReadonlySet<ScenarioName> | null;
}

function printUsage(): void {
  console.log(
    [
      "Usage: bun run bench [options]",
      "",
      "Options:",
      "  --scenario=<name,...>  Run only the named scenarios (repeatable, comma-separated).",
      `                         One of: ${SCENARIO_NAMES.join(", ")}`,
      "  --json                 Emit machine-readable results instead of the text tables.",
      "  --help                 Show this message.",
    ].join("\n"),
  );
}

function parseArgs(argv: readonly string[]): CliOptions {
  let json = false;
  let scenarios: Set<ScenarioName> | null = null;

  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg.startsWith("--scenario=")) {
      scenarios ??= new Set();
      for (const raw of arg.slice("--scenario=".length).split(",")) {
        const name = raw.trim();
        if (!(SCENARIO_NAMES as readonly string[]).includes(name)) {
          throw new Error(
            `bench: unknown scenario "${name}" (one of: ${SCENARIO_NAMES.join(", ")})`,
          );
        }
        scenarios.add(name as ScenarioName);
      }
    } else {
      throw new Error(`bench: unrecognized argument "${arg}" (--help for usage)`);
    }
  }

  return { json, scenarios };
}

const options = parseArgs(Bun.argv.slice(2));
jsonMode = options.json;

const sparseKeys = makeSparseKeys(ENTRY_COUNT);
const denseKeys = makeDenseKeys(ENTRY_COUNT);

const scenarios: Record<ScenarioName, () => Promise<void>> = {
  fill: async () => {
    await fillScenario("sparse keys", sparseKeys);
    await fillScenario("dense keys", denseKeys);
  },
  lookup: async () => {
    await lookupScenario("sparse keys", sparseKeys, true);
    await lookupScenario("sparse keys", sparseKeys, false);
    await lookupScenario("dense keys", denseKeys, true);
  },
  bulk: () => bulkScenario(sparseKeys),
  "string-keys": () => stringKeyScenario(ENTRY_COUNT),
  iteration: () => iterationScenario(sparseKeys),
  shrink: () => shrinkScenario(ENTRY_COUNT, 8),
  "scale-sweep": () => scaleSweep([2_000, 8_000, 16_000, 32_000, 128_000, 512_000]),
};

const selected = options.scenarios ?? new Set<ScenarioName>(SCENARIO_NAMES);

if (!jsonMode) {
  console.log(
    `${ENTRY_COUNT.toLocaleString()} entries, best of ${MEASURED_ROUNDS} rounds` +
      ` after ${WARMUP_ROUNDS} warmups — Bun ${Bun.version}`,
  );
}

for (const name of SCENARIO_NAMES) {
  if (selected.has(name)) await scenarios[name]();
}

if (jsonMode) console.log(JSON.stringify(reports, null, 2));
