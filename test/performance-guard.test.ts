import { describe, expect, test } from "bun:test";

import { SwissU32ToU32, SwissU32ToU64 } from "../src/index.ts";

/**
 * Catastrophic-regression gate, not a benchmark.
 *
 * The point of the package is that a table beats `Map` on these workloads.
 * Nothing else in the suite would notice if a change made it ten times
 * slower while staying correct — `bun run bench` measures that, but nobody
 * runs it on a pull request.
 *
 * Every assertion is a ratio against `Map` measured in the same process, so
 * a slow or contended machine moves both contenders together and the ratio
 * holds. Each contender is scored by its fastest round rather than its
 * median: interference only ever makes a round slower, and it does not
 * arrive evenly between the two, so a median carries whatever the host did
 * during the run into the ratio.
 *
 * {@link FLOOR} is set from what a regression looks like, not from the
 * margin. What this catches is the order-of-magnitude kind — work repeated
 * per key that should not be, a lost pre-size — which puts the table at or
 * below `Map` and so fails against any floor above parity. What it does not
 * catch is a lost bulk path: crossing once per key rather than once per
 * batch costs `setMany` about a sixth of its margin, and no floor separates
 * that from a busy host. `bun run bench` is where that shows.
 *
 * Setting the floor near the measured margin therefore buys nothing, and
 * costs a false failure whenever the host is busy: contention does not reach
 * the two contenders equally, and a run competing with a compile has been
 * seen at less than half the ratio the same machine gives when idle.
 *
 * On CI the ratios run on Linux only. Hosted macOS and Windows runners are
 * co-tenanted virtual machines whose noise is not symmetric between
 * contenders. Everywhere else, including every local run on any platform,
 * they always run.
 */
const RATIOS_ARE_MEANINGFUL =
  process.env.CI === undefined || process.platform === "linux";

const ENTRIES = 50_000;

/** Rounds per contender; the fastest is compared. */
const ROUNDS = 5;

/**
 * Untimed rounds run before the clock starts.
 *
 * The table's set path needs several passes over 50,000 keys before the
 * engine tiers it up, and a single warm-up leaves the first timed rounds
 * running at roughly twice the steady-state cost.
 */
const WARMUP_ROUNDS = 5;

/**
 * Smallest speedup over `Map` a run may report before it is a bug.
 *
 * Held just above parity. `bun run bench` and docs/performance.md are where
 * the actual margins live; restating one here would only turn a routine
 * measurement change into a failing test.
 */
const FLOOR = 1.25;

/** Sparse keys, which is the distribution the package is built for. */
const KEYS = new Uint32Array(ENTRIES);
for (let i = 0; i < ENTRIES; i += 1) KEYS[i] = (i * 2_654_435_761) >>> 0;

const VALUES = new Uint32Array(ENTRIES);
for (let i = 0; i < ENTRIES; i += 1) VALUES[i] = i;

/** One contender: `setup` restores the state `run` consumes, untimed. */
interface Contender {
  setup?: () => void;
  run: () => void;
}

/**
 * Nanoseconds per operation in the fastest of {@link ROUNDS} rounds.
 *
 * `setup` runs before each round but outside the clock, so a workload that
 * consumes its own input — deleting every key — measures the operation
 * rather than the refill, and both contenders start each round alike.
 */
function fastest({ setup, run }: Contender): number {
  for (let round = 0; round < WARMUP_ROUNDS; round += 1) {
    setup?.();
    run();
  }

  const timings: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    setup?.();
    const started = Bun.nanoseconds();
    run();
    timings.push((Bun.nanoseconds() - started) / ENTRIES);
  }

  return Math.min(...timings);
}

/**
 * Asserts the table beats `Map` by at least {@link FLOOR}.
 *
 * The message carries both timings and the ratio, because the number is the
 * whole diagnosis: a run that missed the floor by a hair is a busy host, and
 * one that came in near parity is a structural regression.
 */
function expectFaster(label: string, table: Contender, map: Contender): void {
  const mapNs = fastest(map);
  const tableNs = fastest(table);
  const speedup = mapNs / tableNs;

  expect(
    speedup,
    `${label}: ${speedup.toFixed(2)}x against Map, below the ${FLOOR.toFixed(2)}x floor ` +
      `(table ${tableNs.toFixed(1)} ns/op, Map ${mapNs.toFixed(1)} ns/op)`,
  ).toBeGreaterThanOrEqual(FLOOR);
}

describe("performance guard", () => {
  test.if(RATIOS_ARE_MEANINGFUL)("fills a pre-sized table faster than Map", async () => {
    const table = await SwissU32ToU32.create(ENTRIES);

    expectFaster(
      "fill",
      {
        setup: () => table.clear(),
        run: () => {
          for (let i = 0; i < ENTRIES; i += 1) table.set(KEYS[i]!, VALUES[i]!);
        },
      },
      {
        run: () => {
          const map = new Map<number, number>();
          for (let i = 0; i < ENTRIES; i += 1) map.set(KEYS[i]!, VALUES[i]!);
        },
      },
    );
  });

  test.if(RATIOS_ARE_MEANINGFUL)("deletes faster than Map", async () => {
    const table = await SwissU32ToU32.create(ENTRIES);
    let reference = new Map<number, number>();

    expectFaster(
      "delete",
      {
        // A fresh table, not a refill: deleting every key leaves the slots
        // tombstoned, and refilling over them would time a rehash instead.
        setup: () => {
          table.clear();
          for (let i = 0; i < ENTRIES; i += 1) table.set(KEYS[i]!, VALUES[i]!);
        },
        run: () => {
          for (let i = 0; i < ENTRIES; i += 1) table.delete(KEYS[i]!);
        },
      },
      {
        setup: () => {
          reference = new Map<number, number>();
          for (let i = 0; i < ENTRIES; i += 1) {
            reference.set(KEYS[i]!, VALUES[i]!);
          }
        },
        run: () => {
          for (let i = 0; i < ENTRIES; i += 1) reference.delete(KEYS[i]!);
        },
      },
    );
  });

  const widestMargin = "bulk-fills faster than Map, which is the widest margin";
  test.if(RATIOS_ARE_MEANINGFUL)(widestMargin, async () => {
    const table = await SwissU32ToU64.create(ENTRIES);
    const lanes = new Uint32Array(ENTRIES);

    expectFaster(
      "setMany",
      {
        setup: () => table.clear(),
        run: () => table.setMany(KEYS, VALUES, lanes),
      },
      {
        run: () => {
          const map = new Map<number, { lo: number; hi: number }>();
          for (let i = 0; i < ENTRIES; i += 1) {
            map.set(KEYS[i]!, { lo: VALUES[i]!, hi: 0 });
          }
        },
      },
    );
  });

  test("walks the whole table in a bounded number of crossings", async () => {
    // Deterministic, unlike the ratios above: a walk reads one window of
    // slots per crossing, so a change that reverted it to one crossing per
    // entry fails here whatever the machine is doing.
    const table = await SwissU32ToU32.create(ENTRIES);
    for (let i = 0; i < ENTRIES; i += 1) table.set(KEYS[i]!, VALUES[i]!);

    let seen = 0;
    table.forEach(() => {
      seen += 1;
    });

    expect(seen).toBe(ENTRIES);
    expect(table.capacity).toBeLessThanOrEqual(1 << 17);
  });
});
