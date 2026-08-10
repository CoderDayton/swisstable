#!/usr/bin/env bun
/**
 * Throughput comparison against the built-in JavaScript containers.
 *
 * Every contender stores the same u32 -> u32 pairs and is exercised through
 * the same operation sequence, so the numbers differ only by container.
 * Run `bun run build` first; the WASM contenders need dist/wasm.
 *
 * Usage: bun run bench [--scenario=name,...] [--json] [--no-isolate] [--help]
 * `--help` lists the scenarios.
 */

import { InternedSwissMap, SwissU32ToU32, SwissU32ToU64 } from "../src/index.ts";
import type { U64Lanes } from "../src/index.ts";
import { ISOLATED_RESULT, runtime } from "./runtime.ts";

const ENTRY_COUNT = 100_000;
const WARMUP_ROUNDS = 3;

/**
 * Rounds taken per contender, reduced by median. Tripled from 7 to tighten
 * the estimate; unlike a best-of, a median does not drift as this grows.
 */
const MEASURED_ROUNDS = 21;
const NS_PER_SECOND = 1_000_000_000;

/**
 * Read-only rounds repeat the workload until a round covers at least this
 * many operations, so timer and closure overhead stay negligible against
 * the measured work even for small tables.
 */
const MIN_OPS_PER_ROUND = 2_000_000;
const MISS_KEY_OFFSET = 0x4000_0000;

const U32_WASM = "swiss_u32.wasm";
const U64_WASM = "swiss_u64.wasm";

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

/**
 * A copy of `keys` in a scrambled order, for use as the probe sequence.
 *
 * Probing in insertion order is not a neutral choice. `Map` keeps its
 * entries in insertion order, so asking for them back in that same order
 * walks its entry table sequentially and hands it the prefetcher; with
 * dense integer keys its bucket index goes near-sequentially too. Measured,
 * that is worth ~1.6 ns/op to `Map` on dense keys and enough to decide the
 * ranking. A table that hashes its keys has a scattered layout either way
 * and gains ~0.2 ns, so insertion-order probing quietly compares a
 * sequential scan against a random one.
 *
 * Seeded, so the probe sequence is the same from run to run.
 */
function shuffleProbes(keys: Uint32Array, seed: number): Uint32Array {
  const probes = keys.slice();
  let state = seed;

  for (let i = probes.length - 1; i > 0; i--) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;

    const j = state % (i + 1);
    const swap = probes[i]!;
    probes[i] = probes[j]!;
    probes[j] = swap;
  }

  return probes;
}

/** Seeds for {@link shuffleProbes}, one per probe sequence built. */
const PROBE_SEED = 0x6d2b_79f5;
const SWEEP_PROBE_SEED = 0x1f12_3bb5;

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
 * A {@link Contender} that counts how many of `count` probes hit, without
 * allocating per probe.
 *
 * The loop is built per contender rather than shared. One shared counter
 * taking `hit` as a parameter looks tidier and costs a great deal: its
 * `hit(i)` call site sees every contender's callback, goes megamorphic, and
 * stops inlining them. The containers that suffer are the ones whose lookup
 * is a call chain rather than an intrinsic — the WASM path measured 12.0
 * ns/op against 5.4 for the same work on a 2,000-entry table. It hides
 * itself at large `N`, where memory latency covers the un-inlined call, so
 * it reads as a small-table effect rather than as harness overhead.
 */
function lookupContender(
  name: string,
  count: number,
  hit: (index: number) => boolean,
): Contender {
  const run = (): number => {
    let found = 0;
    for (let i = 0; i < count; i++) if (hit(i)) found++;
    return found;
  };

  return { name, prepare: () => run };
}

/**
 * Contender order within a round, shuffled from a fixed seed.
 *
 * Run position is worth real time, which is why it is not left to
 * declaration order. A contender that runs after the others meets a warmer
 * JIT and a matured heap, measured here as 2-3 ns/op on a workload costing
 * ~15 — enough to invert a ranking between two containers that are within
 * noise of each other. Giving every contender a turn in every slot spreads
 * that advantage instead of handing it to whoever was declared last.
 *
 * The seed is fixed, so the sequence of orders is identical from run to run
 * and a bench result stays reproducible.
 */
let shuffleState = 0x2545_f491;

function shuffledIndices(length: number): number[] {
  const order = Array.from({ length }, (_, index) => index);

  for (let i = length - 1; i > 0; i--) {
    shuffleState ^= shuffleState << 13;
    shuffleState ^= shuffleState >>> 17;
    shuffleState ^= shuffleState << 5;
    shuffleState >>>= 0;

    const j = shuffleState % (i + 1);
    const swap = order[i]!;
    order[i] = order[j]!;
    order[j] = swap;
  }

  return order;
}

/** Accumulates every return value, so no timed region can be dead code. */
let checksum = 0;

/** One prepared round of a contender; returns nanoseconds per replay. */
async function runRound(
  contender: Contender,
  replays: number,
): Promise<number> {
  // Prepared outside the timed region: a contender is allowed to rebuild its
  // container per round, and that rebuild is not what is being measured.
  const run = await contender.prepare();

  const start = runtime.now();
  for (let replay = 0; replay < replays; replay++) checksum += run();
  return (runtime.now() - start) / replays;
}

/**
 * Measures a field of contenders inside this process, round-robin rather
 * than one contender to completion, in the order {@link shuffledIndices}
 * gives. Running them concurrently would interleave their work inside each
 * other's timed regions; running them consecutively systematically favours
 * whoever was declared last.
 *
 * Every contender is warmed before any is measured, so the measured rounds
 * all observe the same matured engine state rather than each contender
 * paying to mature it for the next.
 *
 * This is not on its own enough to make two contenders comparable — see
 * {@link measureAll}, which is what scenarios should call. It is the right
 * measurement only for a field that genuinely has to share one process,
 * which in practice means a before/after of the same container.
 *
 * Reports the median round, not the best one.
 *
 * A minimum over N rounds is biased low, and the size of the bias grows with
 * both N and the contender's variance — so the reducer itself decides part
 * of the ranking. It is not a neutral discount either: the noisiest
 * contenders here are noisy because they allocate, and taking their best
 * round quietly writes off the collection they caused. Measured, `Map`'s
 * 100k fill reports 71.2 ns/op as a best-of-7 and 46.2 as a best-of-21,
 * while the tables — which allocate nothing on a hot path — barely move.
 * Garbage a container generates is part of what it costs, so the median
 * keeps it. The median is also stable against N, which a minimum is not.
 *
 * `repeatable` marks a workload that leaves no state behind (lookups), which
 * may be replayed within a round to amortize harness overhead. Workloads
 * that mutate the container must not be replayed: the second pass would
 * overwrite rather than insert, and would no longer be the same workload.
 */
async function measureField(
  contenders: readonly Contender[],
  operations: number,
  repeatable = false,
): Promise<Result[]> {
  const replays = repeatable
    ? Math.max(1, Math.ceil(MIN_OPS_PER_ROUND / operations))
    : 1;

  const rounds: number[][] = contenders.map(() => []);

  for (let round = 0; round < WARMUP_ROUNDS + MEASURED_ROUNDS; round++) {
    const measured = round >= WARMUP_ROUNDS;

    // Building a scenario leaves megabytes of garbage — key sets, discarded
    // containers, the staging a warmup round allocated. Collecting it here
    // rather than letting it fall due mid-measurement is what separates the
    // harness's litter from the contender's own: a pause charged to whoever
    // happens to be timed when it lands is noise, and on a small table one
    // pause is worth more than the work. Measured, it was doubling the
    // 2,000-entry sweep rows. What a contender allocates itself still
    // accrues during the measured rounds and is still counted.
    if (round === WARMUP_ROUNDS) runtime.gc();

    for (const index of shuffledIndices(contenders.length)) {
      const elapsed = await runRound(contenders[index]!, replays);
      if (measured) rounds[index]!.push(elapsed);
    }
  }

  if (checksum === Number.MAX_SAFE_INTEGER) console.log(""); // keep the work live

  return contenders.map((contender, index) => {
    const sorted = [...rounds[index]!].sort((a, b) => a - b);
    const middle = sorted[Math.floor(sorted.length / 2)]!;

    return {
      name: contender.name,
      nsPerOp: middle / operations,
      opsPerSecond: (operations * NS_PER_SECOND) / middle,
    };
  });
}

/**
 * A lone contender, measured in this process.
 *
 * Nothing is being compared, so there is no second contender to be unfair
 * to and no reason to pay for a subprocess.
 */
async function measure(
  contender: Contender,
  operations: number,
  repeatable = false,
): Promise<Result> {
  const [result] = await measureField([contender], operations, repeatable);
  return result!;
}

/**
 * Unwinds an isolate that has done its one job.
 *
 * A child process exits, but a worker cannot — the page decides when it
 * stops — so the scenario is unwound with a sentinel the entry point
 * swallows. Either way nothing after the reported field runs.
 */
const RUN_COMPLETE = Symbol("bench: run complete");

function stopRun(): never {
  runtime.finish();
  throw RUN_COMPLETE;
}

/**
 * `--memory=<index>`, set only in a run spawned to measure one container's
 * footprint. Separate from `--isolate` because a memory measurement has no
 * field of contenders to index into.
 */
let memoryTarget: number | null = null;

/** `--isolate=<field>:<contender>`, set only in an isolated run. */
interface IsolationTarget {
  readonly field: number;
  readonly contender: number;
}

let isolationTarget: IsolationTarget | null = null;

/** Cleared by `--no-isolate`, which trades comparability for wall time. */
let isolateFields = true;

/** The scenario being run, which a child needs to reach the same field. */
let currentScenario: string | null = null;

/**
 * Counts {@link measureAll} calls within the current scenario, so a parent
 * and its children agree on which field a result belongs to. Reset per
 * scenario, and deterministic because scenarios build their fields in a
 * fixed order.
 */
let fieldCounter = 0;

/** Stands in for a field a child was not spawned to measure. */
function skipped(contender: Contender): Result {
  return { name: contender.name, nsPerOp: 0, opsPerSecond: 0 };
}

/**
 * Whether this process will time the next field {@link measureAll} is given.
 *
 * Isolation puts each contender in a fresh process, but a scenario with
 * several fields still runs every earlier field's *setup* in that process
 * before reaching the one being measured — and that setup leaves containers
 * alive. Measured, it inflated the small end of the scale sweep by up to
 * 2.3x: 8,000-entry lookups reported 14 ns/op against 6.2 standalone, and
 * non-monotonically, since the distortion grows with how many sizes were
 * built first.
 *
 * A scenario whose setup is worth skipping asks this first and, when the
 * answer is no, hands {@link measureAll} placeholders of the right length —
 * enough for a parent to know how many children to spawn, while nothing gets
 * built or kept alive. Only the count matters: the parent reports the names
 * its children send back, and a child discards non-target fields entirely.
 */
function willMeasureNextField(): boolean {
  if (!isolateFields) return true;
  if (isolationTarget === null) return false;
  return isolationTarget.field === fieldCounter;
}

/** Placeholders for a field this process builds no state for. */
function unbuilt(length: number): Contender[] {
  return Array.from({ length }, (_, index) => ({
    name: `unbuilt ${index}`,
    prepare: () => () => 0,
  }));
}

/**
 * Measures one contender in an isolate of its own and returns its result.
 *
 * The isolate re-runs this scenario's setup from scratch, which is the cost
 * of the guarantee: it reaches the timed region having executed nothing but
 * its own contender's code path. What an isolate is depends on the host —
 * a child process, or a worker in a browser — and {@link runtime} decides.
 */
async function spawnContender(
  scenario: string,
  field: number,
  index: number,
): Promise<Result> {
  const line = await runtime.isolate([
    `--scenario=${scenario}`,
    `--isolate=${field}:${index}`,
  ]);

  return JSON.parse(line) as Result;
}

/**
 * Measures a field of contenders against each other, each in its own
 * process.
 *
 * Isolation is the point, and it is not paranoia about GC or the scheduler
 * — those {@link measureField} already handles. Contenders in one process
 * share the library's call sites, so the first one through a shared method
 * leaves it specialized for its own callback and the next arrives to a
 * polluted inline cache. That is invisible, unrelated to the code being
 * benchmarked, and large: two iteration contenders differing only in which
 * ran first measured 3.7 and 10.1 ns/op, and swapped places when their
 * declaration order was swapped. Interleaving rounds does not fix it,
 * because the pollution is not about warm-up — only a fresh process is.
 *
 * The cost is one process per contender, each repeating this scenario's
 * setup. `--no-isolate` skips it for a quick relative check, and is not
 * what a reported number should come from.
 */
async function measureAll(
  contenders: readonly Contender[],
  operations: number,
  repeatable = false,
): Promise<Result[]> {
  const field = fieldCounter++;

  if (isolationTarget !== null) {
    if (field !== isolationTarget.field) return contenders.map(skipped);

    const contender = contenders[isolationTarget.contender];
    if (contender === undefined) {
      throw new Error(`bench: no contender ${isolationTarget.contender}`);
    }

    const [result] = await measureField([contender], operations, repeatable);
    runtime.emit(ISOLATED_RESULT + JSON.stringify(result));

    // The parent wants exactly this one field; whatever the scenario would
    // go on to measure belongs to another isolate.
    stopRun();
  }

  if (!isolateFields || currentScenario === null) {
    return measureField(contenders, operations, repeatable);
  }

  const results: Result[] = [];
  for (let index = 0; index < contenders.length; index++) {
    results.push(await spawnContender(currentScenario, field, index));
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

interface MemoryRow {
  readonly name: string;
  /**
   * Bytes of JavaScript heap per entry, or null for a container that does
   * not live on it — a WASM table's entries are in linear memory, which the
   * collector never sees.
   */
  readonly heapBytesPerEntry: number | null;
  /** Resident bytes per entry: what the process actually pays. */
  readonly residentBytesPerEntry: number;
  readonly residentTotalBytes: number;
}

interface MemoryReport {
  readonly kind: "memory";
  readonly entries: number;
  /** Linear memory each slot occupies, both banks counted. */
  readonly slotBytes: { readonly u32: number; readonly u64: number };
  /** Linear memory an instance reserves, whatever it holds. */
  readonly reservedBytes: { readonly u32: number; readonly u64: number };
  /** Slots the u32 table holds `entries` in. */
  readonly slots: number;
  readonly rows: readonly MemoryRow[];
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

type ReportEntry =
  | ContenderReport
  | ScaleSweepReport
  | ShrinkReport
  | MemoryReport;

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

const u32Bytes = await runtime.readWasm(U32_WASM);
const u64Bytes = await runtime.readWasm(U64_WASM);

/**
 * Hash seed every table here is built with.
 *
 * A random seed permutes the slots, which moves entries between cache lines
 * and shifts probe lengths a little in either direction. That is noise
 * against a change being measured, and it does not average out within a run
 * — one seed serves the whole process. Fixing it makes two runs comparable
 * and a suspicious column reproducible. Nothing about a benchmark is
 * untrusted input.
 */
const BENCH_SEED = 0x5175_7ab1;

/** A `u32` table on the fixed seed, sized for `expectedEntries`. */
function loadU32(expectedEntries = 0) {
  return SwissU32ToU32.loadWithSeed(u32Bytes, expectedEntries, BENCH_SEED);
}

/** A `u64` table on the fixed seed, sized for `expectedEntries`. */
function loadU64(expectedEntries = 0) {
  return SwissU32ToU64.loadWithSeed(u64Bytes, expectedEntries, BENCH_SEED);
}

const swiss = await loadU32(ENTRY_COUNT);
const swiss64 = await loadU64(ENTRY_COUNT);

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
        const table = await loadU32();
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
  const dense = label.startsWith("dense");

  // Four lookup fields share this process; building the other three's
  // containers first would leave them resident during this one's timing.
  if (!willMeasureNextField()) {
    report(
      `lookup ${hit ? "hit" : "miss"} — ${label}`,
      await measureAll(unbuilt(dense ? 4 : 3), count, true),
    );
    return;
  }

  const probes = shuffleProbes(
    hit ? keys : Uint32Array.from(keys, (key) => (key ^ MISS_KEY_OFFSET) >>> 0),
    PROBE_SEED,
  );

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
        const table = await loadU64();
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

/**
 * The u32 table's bulk API, measured the same way as the u64 one above so
 * the two are comparable. The value lane is half as wide, so the staging
 * copy is smaller and the crossing is amortized over the same batch.
 */
async function bulkU32Scenario(keys: Uint32Array): Promise<void> {
  const count = keys.length;
  const values = Uint32Array.from({ length: count }, (_, i) => i);

  const contenders: Contender[] = [
    {
      // No grown counterpart: set_many reserves for the whole batch in one
      // shot before inserting, so it sizes itself regardless of where it
      // starts. Pre-sizing is not a factor here the way it is for set().
      name: "SwissU32ToU32.setMany (wasm)",
      prepare: () => {
        swiss.clear();
        return () => {
          swiss.setMany(keys, values);
          return swiss.size;
        };
      },
    },
    {
      name: "SwissU32ToU32.set (per key, pre-sized)",
      prepare: () => {
        swiss.clear();
        return () => {
          for (let i = 0; i < count; i++) swiss.set(keys[i]!, values[i]!);
          return swiss.size;
        };
      },
    },
    {
      name: "SwissU32ToU32.set (per key, grown)",
      prepare: async () => {
        const table = await loadU32();
        return () => {
          for (let i = 0; i < count; i++) table.set(keys[i]!, values[i]!);
          return table.size;
        };
      },
    },
    {
      name: "Map",
      prepare: () => {
        const map = new Map<number, number>();
        return () => {
          for (let i = 0; i < count; i++) map.set(keys[i]!, values[i]!);
          return map.size;
        };
      },
    },
  ];

  report(
    `u32 values: fill ${count.toLocaleString()} entries — sparse keys`,
    await measureAll(contenders, count),
  );

  swiss.clear();
  swiss.setMany(keys, values);

  const map = new Map<number, number>();
  for (let i = 0; i < count; i++) map.set(keys[i]!, values[i]!);

  // Allocated once, outside the timed region, so the reused-buffer contender
  // measures the steady state a caller reaches by passing its last result
  // back rather than the first call that has to allocate.
  const out = swiss.getMany(keys);

  report(
    `u32 values: lookup ${count.toLocaleString()} keys — sparse keys`,
    await measureAll(
      [
        {
          name: "SwissU32ToU32.getMany (wasm, reused out)",
          prepare: () => () => swiss.getMany(keys, out).found.length,
        },
        {
          name: "SwissU32ToU32.getMany (wasm, allocating)",
          prepare: () => () => swiss.getMany(keys).found.length,
        },
        lookupContender(
          "SwissU32ToU32.get (per key)",
          count,
          (i) => swiss.get(keys[i]!) !== undefined,
        ),
        lookupContender("Map", count, (i) => map.get(keys[i]!) !== undefined),
      ],
      count,
      true,
    ),
  );
}

/** Distinct keys the counter workload spreads its increments over. */
const COUNTER_KEYS = 1_000;

/**
 * Counting, which is what getOrInsert and increment exist for.
 *
 * A read-modify-write spelled as get-then-set crosses the boundary twice and
 * probes twice for one logical operation. The saving is the crossing, so it
 * shows up largest on the operations that do the least work per key — which
 * is why it is measured here rather than inferred from the lookup rows.
 */
async function upsertScenario(keys: Uint32Array): Promise<void> {
  const probes = Uint32Array.from(
    { length: keys.length },
    (_, i) => keys[i % COUNTER_KEYS]!,
  );

  await counterScenario(probes);
  await getOrInsertScenario(keys, probes);
}

/** Increment against the two-crossing spelling and the JavaScript containers. */
async function counterScenario(probes: Uint32Array): Promise<void> {
  const count = probes.length;

  const contenders: Contender[] = [
    {
      name: "SwissU32ToU32.increment (wasm)",
      prepare: () => {
        swiss.clear();
        return () => {
          for (let i = 0; i < count; i++) swiss.increment(probes[i]!);
          return swiss.size;
        };
      },
    },
    {
      name: "SwissU32ToU32.get + set (wasm)",
      prepare: () => {
        swiss.clear();
        return () => {
          for (let i = 0; i < count; i++) {
            const key = probes[i]!;
            swiss.set(key, (swiss.get(key) ?? 0) + 1);
          }
          return swiss.size;
        };
      },
    },
    {
      name: "Map",
      prepare: () => {
        const map = new Map<number, number>();
        return () => {
          for (let i = 0; i < count; i++) {
            const key = probes[i]!;
            map.set(key, (map.get(key) ?? 0) + 1);
          }
          return map.size;
        };
      },
    },
    {
      name: "Object (numeric keys)",
      prepare: () => {
        const object: Record<number, number> = Object.create(null);
        return () => {
          for (let i = 0; i < count; i++) {
            const key = probes[i]!;
            object[key] = (object[key] ?? 0) + 1;
          }
          // Cheap, and enough to keep the writes live; counting the keys
          // here would time a walk rather than the increments.
          return object[probes[0]!]!;
        };
      },
    },
  ];

  report(
    `count ${count.toLocaleString()} increments over ` +
      `${COUNTER_KEYS.toLocaleString()} keys`,
    await measureAll(contenders, count),
  );
}

/**
 * getOrInsert against get-then-set, measured on both sides of the branch
 * that separates them.
 *
 * get-then-set crosses twice only when the key is absent — on a hit it
 * returns after the first call and never issues the second. So the two are
 * expected to tie on an all-hit workload and to diverge in proportion to the
 * miss rate, and both ends are reported rather than one being generalized.
 */
async function getOrInsertScenario(
  keys: Uint32Array,
  probes: Uint32Array,
): Promise<void> {
  const count = keys.length;

  report(
    `getOrInsert ${count.toLocaleString()} keys, none present`,
    await measureAll(
      [
        {
          name: "SwissU32ToU32.getOrInsert (wasm)",
          prepare: () => {
            swiss.clear();
            return () => {
              for (let i = 0; i < count; i++) swiss.getOrInsert(keys[i]!, i);
              return swiss.size;
            };
          },
        },
        {
          name: "SwissU32ToU32.get, then set if absent (wasm)",
          prepare: () => {
            swiss.clear();
            return () => {
              for (let i = 0; i < count; i++) {
                const key = keys[i]!;
                if (swiss.get(key) === undefined) swiss.set(key, i);
              }
              return swiss.size;
            };
          },
        },
        {
          name: "Map.get, then set if absent",
          prepare: () => {
            const fresh = new Map<number, number>();
            return () => {
              for (let i = 0; i < count; i++) {
                const key = keys[i]!;
                if (fresh.get(key) === undefined) fresh.set(key, i);
              }
              return fresh.size;
            };
          },
        },
      ],
      count,
    ),
  );

  swiss.clear();
  const map = new Map<number, number>();
  for (let i = 0; i < COUNTER_KEYS; i++) {
    swiss.set(keys[i]!, i);
    map.set(keys[i]!, i);
  }

  // Every probe hits, so nothing is inserted and the workload is read-only —
  // which is what makes it replayable, and what isolates the crossing from
  // the growth an insert would also pay for.
  report(
    `getOrInsert ${count.toLocaleString()} keys already present`,
    await measureAll(
      [
        {
          name: "SwissU32ToU32.getOrInsert (wasm)",
          prepare: () => () => {
            let sum = 0;
            for (let i = 0; i < count; i++) sum += swiss.getOrInsert(probes[i]!, 0);
            return sum;
          },
        },
        {
          name: "SwissU32ToU32.get, then set if absent (wasm)",
          prepare: () => () => {
            let sum = 0;
            for (let i = 0; i < count; i++) {
              const key = probes[i]!;
              const value = swiss.get(key);
              if (value === undefined) swiss.set(key, 0);
              else sum += value;
            }
            return sum;
          },
        },
        {
          name: "Map.get, then set if absent",
          prepare: () => () => {
            let sum = 0;
            for (let i = 0; i < count; i++) {
              const key = probes[i]!;
              const value = map.get(key);
              if (value === undefined) map.set(key, 0);
              else sum += value;
            }
            return sum;
          },
        },
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
/** Builds one sweep row from the `[swiss, map]` pair measured for a size. */
function sweepRow(entries: number, pair: readonly Result[]): ScaleSweepRow {
  const swissNsPerOp = pair[0]!.nsPerOp;
  const mapNsPerOp = pair[1]!.nsPerOp;
  const ratio = swissNsPerOp / mapNsPerOp;

  return {
    entries,
    swissNsPerOp,
    mapNsPerOp,
    ratio,
    winner: ratio < 1 ? "SwissTable" : "Map",
  };
}

async function scaleSweep(sizes: readonly number[]): Promise<void> {
  const rows: ScaleSweepRow[] = [];

  for (const count of sizes) {
    // Every size is a field of this one scenario, so without this a child
    // measuring 512,000 would first build all five smaller pairs and hold
    // them. That is what made the small end read high and non-monotonic.
    if (!willMeasureNextField()) {
      // A parent still lands here — it spawns the children and gets their
      // real results back, so the row is built exactly as below.
      rows.push(sweepRow(count, await measureAll(unbuilt(2), count, true)));
      continue;
    }

    const keys = makeSparseKeys(count);
    const probes = shuffleProbes(keys, SWEEP_PROBE_SEED);
    const map = new Map<number, number>();

    // A fresh instance per size: clear() retains the capacity of the
    // previous, larger run, which would inflate the smaller sizes.
    const table = await loadU32(count);

    for (let i = 0; i < count; i++) {
      table.set(keys[i]!, i);
      map.set(keys[i]!, i);
    }

    // One field rather than two lone measurements: this row reports a
    // winner, so the pair has to be interleaved or the ratio is partly just
    // whichever of the two was timed second.
    const pair = await measureAll(
      [
        lookupContender(
          "swiss",
          count,
          (i) => table.get(probes[i]!) !== undefined,
        ),
        lookupContender("map", count, (i) => map.get(probes[i]!) !== undefined),
      ],
      count,
      true,
    );

    rows.push(sweepRow(count, pair));
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
  const table = await loadU32(count);
  const table64 = await loadU64(count);

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
  const table = await loadU32(peak);

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

/**
 * Bytes of linear memory each slot costs.
 *
 * Each module addresses two banks so a rehash has somewhere to move entries
 * to, and the address extent a table holds covers both — so a slot costs its
 * per-bank layout twice. Kept in step with `bankBytesPerSlot` in
 * scripts/build-wasm.ts, which is the per-bank half of the same number.
 */
const U32_BYTES_PER_SLOT = 2 * (1 + 8);
const U64_BYTES_PER_SLOT = 2 * (1 + 12);

/**
 * Entries the footprint scenario builds, which is larger than the rest of
 * the suite uses.
 *
 * A process costs a few megabytes to reach the measurement — compiled code,
 * the collector's own structures, the module — and that is charged to
 * whichever container is being built. At 100,000 entries it is most of the
 * reading and the runtimes disagree by 4x; at 500,000 the containers are
 * several times larger than it and they agree. Still inside the compiled
 * ceiling of 917,504 entries.
 */
const MEMORY_ENTRY_COUNT = 500_000;

/** Holds a measured container past its readings, so it cannot be freed. */
let retained: unknown = null;

interface Footprint {
  readonly heapBytes: number | null;
  readonly residentBytes: number;
}

/**
 * What one container costs, built exactly once in a process of its own.
 *
 * Once rather than repeatedly, because neither figure survives repetition.
 * Resident bytes do not come back down when a container is dropped — the
 * allocator keeps the pages — so only the first build in a process measures
 * anything. The heap figure drifts for its own reasons: JavaScriptCore
 * reports the same `Map` at 84 B/entry for the first few build-and-collect
 * cycles and 126 from the fifth on, which is its accounting moving rather
 * than the container.
 *
 * The keys are built before the first reading and shared by every container,
 * so what the deltas contain is the container and its entries, not the
 * inputs.
 */
async function footprintOf(
  build: () => unknown | Promise<unknown>,
  count: number,
): Promise<Footprint> {
  runtime.gc();
  const heapBefore = runtime.heapUsed();
  const residentBefore = runtime.residentBytes()!;

  // Stored before the collection rather than after it. A container held only
  // in a local is dead as far as the engine is concerned by the time the
  // collection runs, and JavaScriptCore duly collects it — which reports
  // every container as costing nothing.
  retained = await build();

  runtime.gc();
  const heapAfter = runtime.heapUsed();
  const residentAfter = runtime.residentBytes()!;

  retained = null;

  return {
    heapBytes:
      heapBefore === null || heapAfter === null
        ? null
        : (heapAfter - heapBefore) / count,
    residentBytes: (residentAfter - residentBefore) / count,
  };
}

/** The fixed linear memory an instance of `bytes` reserves. */
async function linearMemoryBytes(bytes: ArrayBuffer): Promise<number> {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const memory = instance.exports.memory as WebAssembly.Memory;
  return memory.buffer.byteLength;
}

/**
 * What the containers cost to hold, rather than to use.
 *
 * Every row is measured the same way — one container, built once, in a
 * process of its own — because that is the only comparison that means
 * anything across a heap and a WASM arena. A table's entries live in linear
 * memory, which the collector never sees and a heap reading never counts,
 * so a heap-against-heap table would report a SwissTable as free.
 *
 * Linear memory is reserved at the compiled ceiling but committed page by
 * page as it is touched, so what a table costs the process is set by how
 * much of the arena the entries reach, not by the size of the reservation.
 * The reservation is reported alongside, because it is what a caller's
 * address space and a memory-capped container see.
 */
async function memoryScenario(keys: Uint32Array): Promise<void> {
  const count = keys.length;

  if (runtime.heapUsed() === null) {
    // Nothing partial is worth publishing here: the tables' figures would be
    // derived and the containers' measured, and only one of the two would be
    // missing — which reads as a comparison and is not one.
    return;
  }

  const valsLo = Uint32Array.from({ length: count }, (_, i) => i);
  const valsHi = Uint32Array.from({ length: count }, (_, i) => i * 2);

  const containers: readonly (readonly [
    string,
    () => unknown | Promise<unknown>,
  ])[] = [
    [
      "SwissU32ToU32",
      async () => {
        const table = await loadU32(count);
        for (let i = 0; i < count; i++) table.set(keys[i]!, i);
        return table;
      },
    ],
    [
      "SwissU32ToU64",
      async () => {
        const table = await loadU64(count);
        for (let i = 0; i < count; i++) {
          table.set(keys[i]!, valsLo[i]!, valsHi[i]!);
        }
        return table;
      },
    ],
    [
      "Map<number, number>",
      () => {
        const map = new Map<number, number>();
        for (let i = 0; i < count; i++) map.set(keys[i]!, i);
        return map;
      },
    ],
    [
      "Object (numeric keys)",
      () => {
        const object: Record<number, number> = {};
        for (let i = 0; i < count; i++) object[keys[i]!] = i;
        return object;
      },
    ],
    [
      "Map<number, {lo,hi}>",
      () => {
        const map = new Map<number, { lo: number; hi: number }>();
        for (let i = 0; i < count; i++) {
          map.set(keys[i]!, { lo: valsLo[i]!, hi: valsHi[i]! });
        }
        return map;
      },
    ],
    [
      "Map<number, bigint>",
      () => {
        const map = new Map<number, bigint>();
        for (let i = 0; i < count; i++) {
          map.set(keys[i]!, (BigInt(valsHi[i]!) << 32n) | BigInt(valsLo[i]!));
        }
        return map;
      },
    ],
  ];

  // One container per process: a reading is only as good as the process it
  // is taken in, and one that has already built three containers is not a
  // fresh one.
  if (memoryTarget !== null) {
    const container = containers[memoryTarget];
    if (container === undefined) {
      throw new Error(`bench: no memory container ${memoryTarget}`);
    }

    const footprint = await footprintOf(container[1], count);
    runtime.emit(ISOLATED_RESULT + JSON.stringify(footprint));
    stopRun();
  }

  const rows: MemoryRow[] = [];

  for (let index = 0; index < containers.length; index++) {
    const [name, build] = containers[index]!;

    const footprint = isolateFields
      ? ((JSON.parse(
          await runtime.isolate(["--scenario=memory", `--memory=${index}`]),
        ) as Footprint))
      : await footprintOf(build, count);

    rows.push({
      name,
      // A table's entries are in linear memory, so its heap delta is the
      // binding object and nothing else — reporting it as the container's
      // cost would be reporting the wrong number, not a small one.
      heapBytesPerEntry: name.startsWith("Swiss")
        ? null
        : footprint.heapBytes,
      residentBytesPerEntry: footprint.residentBytes,
      residentTotalBytes: footprint.residentBytes * count,
    });
  }

  const reserved = {
    u32: await linearMemoryBytes(u32Bytes),
    u64: await linearMemoryBytes(u64Bytes),
  };

  // Exact rather than measured: the slot count is a power of two the table
  // reports, and the per-slot layout is what the modules are linked with.
  // This is the figure that scales, and the one a reader should compare
  // against a container's measured bytes per entry.
  const sized = await loadU32(count);
  const slots = sized.capacity;
  const ceilingEntries = (slots * 7) / 8;

  reports.push({
    kind: "memory",
    entries: count,
    slotBytes: { u32: U32_BYTES_PER_SLOT, u64: U64_BYTES_PER_SLOT },
    reservedBytes: reserved,
    slots,
    rows,
  });
  if (jsonMode) return;

  console.log(`\nmemory at ${count.toLocaleString()} entries`);
  console.log("-".repeat(58));

  const width = Math.max(...rows.map((row) => row.name.length));
  for (const row of rows) {
    const resident = row.residentBytesPerEntry.toFixed(1).padStart(6);
    const total = (row.residentTotalBytes / (1024 * 1024)).toFixed(2).padStart(6);
    const heap =
      row.heapBytesPerEntry === null
        ? "       —"
        : `${row.heapBytesPerEntry.toFixed(1).padStart(6)} B`;

    console.log(
      `  ${row.name.padEnd(width)}  ${resident} B/entry resident` +
        `  ${total} MiB  heap ${heap}`,
    );
  }

  console.log(
    `  u32 structure: ${U32_BYTES_PER_SLOT} B/slot over ` +
      `${slots.toLocaleString()} slots — ` +
      `${((slots * U32_BYTES_PER_SLOT) / ceilingEntries).toFixed(1)} B/entry at ` +
      `the 7/8 ceiling, ` +
      `${((slots * (U32_BYTES_PER_SLOT / 2)) / ceilingEntries).toFixed(1)} ` +
      `in the live bank alone`,
  );
  console.log(
    `  linear memory an instance starts at: ` +
      `${(reserved.u32 / (1024 * 1024)).toFixed(2)} MiB (u32), ` +
      `${(reserved.u64 / (1024 * 1024)).toFixed(2)} MiB (u64)`,
  );
}

/**
 * Removal, which nothing else here covers.
 *
 * Not repeatable: the second pass would delete keys that are already gone
 * and measure the miss path instead. Every round refills in `prepare`.
 */
async function deleteScenario(keys: Uint32Array): Promise<void> {
  const count = keys.length;
  const probes = shuffleProbes(keys, PROBE_SEED);

  const contenders: Contender[] = [
    {
      name: "SwissU32ToU32.delete (wasm)",
      prepare: () => {
        swiss.clear();
        for (let i = 0; i < count; i++) swiss.set(keys[i]!, i);
        return () => {
          let removed = 0;
          for (let i = 0; i < count; i++) if (swiss.delete(probes[i]!)) removed++;
          return removed;
        };
      },
    },
    {
      name: "Map.delete",
      prepare: () => {
        const map = new Map<number, number>();
        for (let i = 0; i < count; i++) map.set(keys[i]!, i);
        return () => {
          let removed = 0;
          for (let i = 0; i < count; i++) if (map.delete(probes[i]!)) removed++;
          return removed;
        };
      },
    },
    {
      name: "Object (delete operator)",
      prepare: () => {
        const object: Record<number, number> = {};
        for (let i = 0; i < count; i++) object[keys[i]!] = i;
        return () => {
          let removed = 0;
          for (let i = 0; i < count; i++) {
            if (delete object[probes[i]!]) removed++;
          }
          return removed;
        };
      },
    },
  ];

  report(
    `delete ${count.toLocaleString()} entries — sparse keys`,
    await measureAll(contenders, count),
  );
}

/**
 * `has` against `get`. The tables latch a found value into linear memory
 * whether or not the caller wants it, so `has` should be the cheaper call
 * only by the result read it skips.
 */
async function hasScenario(keys: Uint32Array): Promise<void> {
  const count = keys.length;
  const probes = shuffleProbes(keys, PROBE_SEED);

  swiss.clear();
  const map = new Map<number, number>();
  const object: Record<number, number> = {};

  for (let i = 0; i < count; i++) {
    swiss.set(keys[i]!, i);
    map.set(keys[i]!, i);
    object[keys[i]!] = i;
  }

  report(
    `has ${count.toLocaleString()} keys — sparse keys`,
    await measureAll(
      [
        lookupContender("SwissU32ToU32.has (wasm)", count, (i) =>
          swiss.has(probes[i]!),
        ),
        lookupContender("SwissU32ToU32.get (wasm)", count, (i) =>
          swiss.get(probes[i]!) !== undefined,
        ),
        lookupContender("Map.has", count, (i) => map.has(probes[i]!)),
        lookupContender(
          "Object (in operator)",
          count,
          (i) => probes[i]! in object,
        ),
      ],
      count,
      true,
    ),
  );
}

/**
 * Overwriting keys that are already present. Distinct from a fill: no slot
 * is claimed, nothing grows, and the table never rehashes — but `set` still
 * pays the probe that confirms the key is there.
 *
 * Replaying is safe because an overwrite leaves the table exactly as it was.
 */
async function overwriteScenario(keys: Uint32Array): Promise<void> {
  const count = keys.length;

  swiss.clear();
  const map = new Map<number, number>();

  for (let i = 0; i < count; i++) {
    swiss.set(keys[i]!, i);
    map.set(keys[i]!, i);
  }

  report(
    `overwrite ${count.toLocaleString()} existing keys — sparse keys`,
    await measureAll(
      [
        {
          name: "SwissU32ToU32.set (wasm)",
          prepare: () => () => {
            for (let i = 0; i < count; i++) swiss.set(keys[i]!, i + 1);
            return swiss.size;
          },
        },
        {
          name: "Map.set",
          prepare: () => () => {
            for (let i = 0; i < count; i++) map.set(keys[i]!, i + 1);
            return map.size;
          },
        },
      ],
      count,
      true,
    ),
  );
}

/**
 * Steady-state churn: delete a key, insert it straight back.
 *
 * This is what the tombstone design exists for. A removal writes `DELETED`
 * rather than `EMPTY` so it cannot truncate another key's probe sequence,
 * and the re-insert reclaims that tombstone without consuming growth — so a
 * table under pure churn should hold its capacity and never rehash. Counted
 * as two operations per key.
 */
async function churnScenario(keys: Uint32Array): Promise<void> {
  const count = keys.length;
  const probes = shuffleProbes(keys, PROBE_SEED);

  const contenders: Contender[] = [
    {
      name: "SwissU32ToU32 delete + set (wasm)",
      prepare: () => {
        swiss.clear();
        for (let i = 0; i < count; i++) swiss.set(keys[i]!, i);
        return () => {
          for (let i = 0; i < count; i++) {
            swiss.delete(probes[i]!);
            swiss.set(probes[i]!, i);
          }
          return swiss.size;
        };
      },
    },
    {
      name: "Map delete + set",
      prepare: () => {
        const map = new Map<number, number>();
        for (let i = 0; i < count; i++) map.set(keys[i]!, i);
        return () => {
          for (let i = 0; i < count; i++) {
            map.delete(probes[i]!);
            map.set(probes[i]!, i);
          }
          return map.size;
        };
      },
    },
  ];

  report(
    `churn ${count.toLocaleString()} keys (delete + reinsert)`,
    await measureAll(contenders, count * 2),
  );
}

/**
 * Lookup cost against how full the table is.
 *
 * Entry count is held fixed and capacity is varied, so the probe sequence
 * lengthens without the entry working set changing. The control array grows
 * as load falls, which pulls the other way — these are not separable, and
 * the point is the net effect a caller sees, not an isolated probe count.
 */
async function loadFactorScenario(entries: number): Promise<void> {
  const keys = makeSparseKeys(entries);
  const probes = shuffleProbes(keys, PROBE_SEED);
  const contenders: Contender[] = [];

  for (const reserved of [entries, entries * 2, entries * 4, entries * 8]) {
    const table = await loadU32(reserved);
    for (let i = 0; i < entries; i++) table.set(keys[i]!, i);

    const load = ((entries / table.capacity) * 100).toFixed(0);
    contenders.push(
      lookupContender(
        `${load}% full (${table.capacity.toLocaleString()} slots)`,
        entries,
        (i) => table.get(probes[i]!) !== undefined,
      ),
    );
  }

  report(
    `lookup ${entries.toLocaleString()} keys vs load factor`,
    await measureAll(contenders, entries, true),
  );
}

/**
 * How quickly a bulk call amortizes its crossing.
 *
 * Every contender moves the same 100k keys; only the batch handed to one
 * call changes. A batch of 1 is the per-key path plus staging overhead, and
 * the curve from there shows where the crossing stops mattering.
 */
async function batchSweepScenario(keys: Uint32Array): Promise<void> {
  const count = keys.length;
  const valsLo = Uint32Array.from({ length: count }, (_, i) => i);
  const valsHi = Uint32Array.from({ length: count }, (_, i) => i * 2);
  const sizes = [1, 8, 64, 512, 4096, count];

  swiss64.clear();
  swiss64.setMany(keys, valsLo, valsHi);

  const getters: Contender[] = sizes.map((batch) => ({
    name: `getMany batch ${batch.toLocaleString()}`,
    prepare: () => {
      const out = {
        valsLo: new Uint32Array(batch),
        valsHi: new Uint32Array(batch),
        found: new Uint8Array(batch),
      };
      return () => {
        let seen = 0;
        for (let offset = 0; offset < count; offset += batch) {
          const chunk = keys.subarray(offset, Math.min(offset + batch, count));
          seen += swiss64.getMany(chunk, out).found.length;
        }
        return seen;
      };
    },
  }));

  report(
    `u64 getMany ${count.toLocaleString()} keys vs batch size`,
    await measureAll(getters, count, true),
  );

  const setters: Contender[] = sizes.map((batch) => ({
    name: `setMany batch ${batch.toLocaleString()}`,
    prepare: () => {
      swiss64.clear();
      swiss64.reserve(count);
      return () => {
        for (let offset = 0; offset < count; offset += batch) {
          const end = Math.min(offset + batch, count);
          swiss64.setMany(
            keys.subarray(offset, end),
            valsLo.subarray(offset, end),
            valsHi.subarray(offset, end),
          );
        }
        return swiss64.size;
      };
    },
  }));

  report(
    `u64 setMany ${count.toLocaleString()} entries vs batch size`,
    await measureAll(setters, count),
  );
}

/** Bulk removal against the per-key path and against `Map`. */
async function deleteManyScenario(keys: Uint32Array): Promise<void> {
  const count = keys.length;
  const valsLo = Uint32Array.from({ length: count }, (_, i) => i);
  const valsHi = Uint32Array.from({ length: count }, (_, i) => i * 2);

  const refill = (): void => {
    swiss64.clear();
    swiss64.setMany(keys, valsLo, valsHi);
  };

  const contenders: Contender[] = [
    {
      name: "SwissU32ToU64.deleteMany (wasm)",
      prepare: () => {
        refill();
        return () => swiss64.deleteMany(keys).removedCount;
      },
    },
    {
      name: "SwissU32ToU64.delete (per key)",
      prepare: () => {
        refill();
        return () => {
          let removed = 0;
          for (let i = 0; i < count; i++) if (swiss64.delete(keys[i]!)) removed++;
          return removed;
        };
      },
    },
    {
      name: "Map<number, bigint>.delete",
      prepare: () => {
        const map = new Map<number, bigint>();
        for (let i = 0; i < count; i++) map.set(keys[i]!, BigInt(i));
        return () => {
          let removed = 0;
          for (let i = 0; i < count; i++) if (map.delete(keys[i]!)) removed++;
          return removed;
        };
      },
    },
  ];

  report(
    `u64 delete ${count.toLocaleString()} entries — sparse keys`,
    await measureAll(contenders, count),
  );
}

/**
 * The int32 tagging cliff, at the public API rather than in a micro-test.
 *
 * A JavaScript number at or above 2^31 cannot be tagged as a machine int32,
 * so it reaches a WASM `i32` parameter as a boxed double and is converted at
 * the boundary. Every key here is a valid `u32` and every contender does the
 * same lookups; only how the caller stores them differs. See
 * docs/performance.md.
 */
async function taggingScenario(count: number): Promise<void> {
  const low = makeSparseKeys(count, 0x1234_5678);
  for (let i = 0; i < count; i++) low[i] = low[i]! >>> 1; // now all < 2^31

  const high = Uint32Array.from(low, (key) => (key | 0x8000_0000) >>> 0);
  const boxed = Array.from(high);

  const lowTable = await loadU32(count);
  const highTable = await loadU32(count);

  for (let i = 0; i < count; i++) {
    lowTable.set(low[i]!, i);
    highTable.set(high[i]!, i);
  }

  report(
    `has ${count.toLocaleString()} keys vs argument tagging`,
    await measureAll(
      [
        lookupContender("keys < 2^31 (int32-tagged)", count, (i) =>
          lowTable.has(low[i]!),
        ),
        lookupContender("keys >= 2^31 (boxed double)", count, (i) =>
          highTable.has(high[i]!),
        ),
        lookupContender("plain Array source (always double)", count, (i) =>
          highTable.has(boxed[i]!),
        ),
      ],
      count,
      true,
    ),
  );
}

/**
 * The whole-table operations, each measured as one call.
 *
 * Not repeatable and rebuilt every round: `clear` and `shrinkToFit` are only
 * expensive the first time, and a second `reserve` to the same size is a
 * no-op by design.
 */
async function maintenanceScenario(count: number): Promise<void> {
  const keys = makeSparseKeys(count);

  const filled = async (reserved: number): Promise<SwissU32ToU32> => {
    const table = await loadU32(reserved);
    for (let i = 0; i < count; i++) table.set(keys[i]!, i);
    return table;
  };

  const contenders: Contender[] = [
    {
      name: "clear() a full table",
      prepare: async () => {
        const table = await filled(count);
        return () => {
          table.clear();
          return table.size;
        };
      },
    },
    {
      name: "reserve() forcing one rehash",
      prepare: async () => {
        const table = await filled(count);
        return () => {
          table.reserve(count * 4);
          return table.capacity;
        };
      },
    },
    {
      name: "shrinkToFit() after emptying",
      prepare: async () => {
        const table = await filled(count);
        for (let i = 8; i < count; i++) table.delete(keys[i]!);
        return () => {
          table.shrinkToFit();
          return table.capacity;
        };
      },
    },
  ];

  report(
    `whole-table operations at ${count.toLocaleString()} entries`,
    await measureAll(contenders, 1),
  );
}

/**
 * Interning strings, which the string-key scenario only ever measures the
 * lookup side of. Interning is the half that has to copy and hash bytes.
 */
async function internScenario(count: number): Promise<void> {
  const strings = Array.from({ length: count }, (_, i) => `token:${i}:${i * 7}`);

  const contenders: Contender[] = [
    {
      name: "InternedSwissMap.set (per key)",
      prepare: async () => {
        const table = await loadU32(count);
        const interned = new InternedSwissMap<number>(table);
        return () => {
          for (let i = 0; i < count; i++) interned.set(strings[i]!, i);
          return interned.size;
        };
      },
    },
    {
      name: "Map<string, number>.set",
      prepare: () => {
        const map = new Map<string, number>();
        return () => {
          for (let i = 0; i < count; i++) map.set(strings[i]!, i);
          return map.size;
        };
      },
    },
    {
      name: "Object (string keys)",
      prepare: () => {
        const object: Record<string, number> = Object.create(null);
        return () => {
          for (let i = 0; i < count; i++) object[strings[i]!] = i;
          return count;
        };
      },
    },
  ];

  report(
    `string keys: insert ${count.toLocaleString()} keys`,
    await measureAll(contenders, count),
  );
}

const SCENARIO_NAMES = [
  "fill",
  "lookup",
  "has",
  "overwrite",
  "delete",
  "churn",
  "upsert",
  "bulk",
  "bulk-u32",
  "batch-sweep",
  "delete-many",
  "load-factor",
  "tagging",
  "string-keys",
  "iteration",
  "maintenance",
  "shrink",
  "memory",
  "scale-sweep",
] as const;
type ScenarioName = (typeof SCENARIO_NAMES)[number];

interface CliOptions {
  readonly json: boolean;
  readonly scenarios: ReadonlySet<ScenarioName> | null;
  readonly isolate: boolean;
  readonly target: IsolationTarget | null;
  readonly memory: number | null;
}

/** Parses `--isolate=<field>:<contender>`, which only a child is given. */
function parseIsolate(value: string): IsolationTarget {
  const [field, contender] = value.split(":");
  const parsed = { field: Number(field), contender: Number(contender) };

  if (!Number.isInteger(parsed.field) || !Number.isInteger(parsed.contender)) {
    throw new Error(`bench: --isolate expects <field>:<contender>, got "${value}"`);
  }

  return parsed;
}

function printUsage(): void {
  console.log(
    [
      "Usage: bun run bench [options]   (also runs under node, deno, and a browser)",
      "",
      "Options:",
      "  --scenario=<name,...>  Run only the named scenarios (repeatable, comma-separated).",
      `                         One of: ${SCENARIO_NAMES.join(", ")}`,
      "  --json                 Emit machine-readable results instead of the text tables.",
      "  --no-isolate           Measure a scenario's contenders in one process. Faster,",
      "                         but contenders pollute each other's inline caches — use",
      "                         for a quick check, not for a number worth reporting.",
      "  --help                 Show this message.",
    ].join("\n"),
  );
}

function parseArgs(argv: readonly string[]): CliOptions {
  let json = false;
  let scenarios: Set<ScenarioName> | null = null;
  let isolate = true;
  let target: IsolationTarget | null = null;
  let memory: number | null = null;

  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "--no-isolate") {
      isolate = false;
    } else if (arg.startsWith("--isolate=")) {
      target = parseIsolate(arg.slice("--isolate=".length));
    } else if (arg.startsWith("--memory=")) {
      memory = Number(arg.slice("--memory=".length));
      if (!Number.isInteger(memory)) {
        throw new Error(`bench: --memory expects an index, got "${arg}"`);
      }
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      stopRun();
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

  return { json, scenarios, isolate, target, memory };
}

const options = parseArgs(runtime.argv());
jsonMode = options.json;
isolateFields = options.isolate;
isolationTarget = options.target;
memoryTarget = options.memory;

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
    await lookupScenario("dense keys", denseKeys, false);
  },
  has: () => hasScenario(sparseKeys),
  overwrite: () => overwriteScenario(sparseKeys),
  delete: () => deleteScenario(sparseKeys),
  churn: () => churnScenario(sparseKeys),
  upsert: () => upsertScenario(sparseKeys),
  bulk: () => bulkScenario(sparseKeys),
  "bulk-u32": () => bulkU32Scenario(sparseKeys),
  "batch-sweep": () => batchSweepScenario(sparseKeys),
  "delete-many": () => deleteManyScenario(sparseKeys),
  "load-factor": () => loadFactorScenario(50_000),
  tagging: () => taggingScenario(ENTRY_COUNT),
  "string-keys": async () => {
    await internScenario(ENTRY_COUNT);
    await stringKeyScenario(ENTRY_COUNT);
  },
  iteration: () => iterationScenario(sparseKeys),
  maintenance: () => maintenanceScenario(ENTRY_COUNT),
  shrink: () => shrinkScenario(ENTRY_COUNT, 8),
  memory: () => memoryScenario(makeSparseKeys(MEMORY_ENTRY_COUNT)),
  "scale-sweep": () => scaleSweep([2_000, 8_000, 16_000, 32_000, 128_000, 512_000]),
};

const selected = options.scenarios ?? new Set<ScenarioName>(SCENARIO_NAMES);

if (!jsonMode && isolationTarget === null) {
  console.log(
    `${ENTRY_COUNT.toLocaleString()} entries, median of ${MEASURED_ROUNDS} rounds` +
      ` after ${WARMUP_ROUNDS} warmups — ${runtime.host.label}` +
      (isolateFields ? ", one isolate per contender" : ", shared isolate"),
  );
}

try {
  for (const name of SCENARIO_NAMES) {
    if (!selected.has(name)) continue;

    // Both counters are per scenario, so an isolate given --scenario reaches
    // the same field number the parent asked for.
    currentScenario = name;
    fieldCounter = 0;

    await scenarios[name]();
  }
} catch (error) {
  // An isolate that has reported its one field unwinds through here.
  if (error !== RUN_COMPLETE) throw error;
}

/**
 * A finished run, as data.
 *
 * The host block is not decoration: a ns/op figure means nothing without
 * the engine, the CPU, and whether the run could collect on demand, and
 * comparing two runtimes means comparing two of these.
 */
const payload = {
  schema: 1,
  host: runtime.host,
  entryCount: ENTRY_COUNT,
  warmupRounds: WARMUP_ROUNDS,
  measuredRounds: MEASURED_ROUNDS,
  isolated: isolateFields,
  scenarios: [...selected],
  reports,
};

// A browser has no stdout, so a page always hands its results back; on the
// server that is what --json asks for. An isolate reaches here only after
// unwinding, and has already reported the one field it was spawned for.
if (isolationTarget === null && (jsonMode || runtime.host.runtime === "browser")) {
  await runtime.publish(JSON.stringify(payload, null, 2));
}
