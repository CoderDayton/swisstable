#!/usr/bin/env bun
/**
 * Throughput comparison against the built-in JavaScript containers.
 *
 * Every contender stores the same u32 -> u32 pairs and is exercised through
 * the same operation sequence, so the numbers differ only by container.
 * Run `bun run build` first; the WASM contenders need dist/wasm.
 */

import { InternedSwissMap, SwissU32ToU32, SwissU32ToU64 } from "../src/index.ts";

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

function report(scenario: string, results: readonly Result[]): void {
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
    {
      name: "SwissU32ToU32 (wasm)",
      prepare: () => () => {
        let found = 0;
        for (let i = 0; i < count; i++) {
          if (swiss.get(probes[i]!) !== undefined) found++;
        }
        return found;
      },
    },
    {
      name: "Map",
      prepare: () => () => {
        let found = 0;
        for (let i = 0; i < count; i++) {
          if (map.get(probes[i]!) !== undefined) found++;
        }
        return found;
      },
    },
    {
      name: "Object (numeric keys)",
      prepare: () => () => {
        let found = 0;
        for (let i = 0; i < count; i++) {
          if (object[probes[i]!] !== undefined) found++;
        }
        return found;
      },
    },
  ];

  if (label.startsWith("dense")) {
    contenders.push({
      name: "Int32Array (direct index)",
      prepare: () => () => {
        let found = 0;
        for (let i = 0; i < count; i++) {
          const key = probes[i]!;
          if (key < count && array[key] !== undefined) found++;
        }
        return found;
      },
    });
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
        {
          name: "SwissU32ToU64.get (per key)",
          prepare: () => () => {
            let found = 0;
            for (let i = 0; i < count; i++) {
              if (swiss64.get(keys[i]!) !== undefined) found++;
            }
            return found;
          },
        },
        {
          name: "Map<number, bigint>",
          prepare: () => () => {
            let found = 0;
            for (let i = 0; i < count; i++) {
              if (bigintMap.get(keys[i]!) !== undefined) found++;
            }
            return found;
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
        {
          name: "InternedSwissMap (wasm + Map)",
          prepare: () => () => {
            let found = 0;
            for (let i = 0; i < count; i++) {
              if (interned.get(strings[i]!) !== undefined) found++;
            }
            return found;
          },
        },
        {
          name: "Map<string, number>",
          prepare: () => () => {
            let found = 0;
            for (let i = 0; i < count; i++) {
              if (map.get(strings[i]!) !== undefined) found++;
            }
            return found;
          },
        },
        {
          name: "Object (string keys)",
          prepare: () => () => {
            let found = 0;
            for (let i = 0; i < count; i++) {
              if (object[strings[i]!] !== undefined) found++;
            }
            return found;
          },
        },
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
  const results: string[] = [];

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
      {
        name: "swiss",
        prepare: () => () => {
          let found = 0;
          for (let i = 0; i < count; i++) {
            if (table.get(keys[i]!) !== undefined) found++;
          }
          return found;
        },
      },
      count,
      true,
    );

    const mapResult = await measure(
      {
        name: "map",
        prepare: () => () => {
          let found = 0;
          for (let i = 0; i < count; i++) {
            if (map.get(keys[i]!) !== undefined) found++;
          }
          return found;
        },
      },
      count,
      true,
    );

    const ratio = swissResult.nsPerOp / mapResult.nsPerOp;
    const winner = ratio < 1 ? "SwissTable" : "Map";

    results.push(
      `  ${count.toLocaleString().padStart(10)}  ` +
        `${swissResult.nsPerOp.toFixed(1).padStart(7)} ns  ` +
        `${mapResult.nsPerOp.toFixed(1).padStart(7)} ns  ` +
        `${ratio.toFixed(2).padStart(5)}x  ${winner}`,
    );
  }

  console.log("\nsingle-key lookup vs entry count — sparse keys");
  console.log("---------------------------------------------");
  console.log("      entries    Swiss      Map  ratio  winner");
  for (const line of results) console.log(line);
}

const sparseKeys = makeSparseKeys(ENTRY_COUNT);
const denseKeys = makeDenseKeys(ENTRY_COUNT);

console.log(
  `${ENTRY_COUNT.toLocaleString()} entries, best of ${MEASURED_ROUNDS} rounds` +
    ` after ${WARMUP_ROUNDS} warmups — Bun ${Bun.version}`,
);

await fillScenario("sparse keys", sparseKeys);
await fillScenario("dense keys", denseKeys);
await lookupScenario("sparse keys", sparseKeys, true);
await lookupScenario("sparse keys", sparseKeys, false);
await lookupScenario("dense keys", denseKeys, true);
await bulkScenario(sparseKeys);
await stringKeyScenario(ENTRY_COUNT);
await scaleSweep([2_000, 8_000, 16_000, 32_000, 128_000, 512_000]);
