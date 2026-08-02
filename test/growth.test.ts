import { describe, expect, test } from "bun:test";

import { SwissU32ToU32, SwissU32ToU64 } from "../src/index.ts";

/**
 * Fills a table to its 7/8 load factor, then runs `pairs` delete+insert
 * cycles that hold the live count constant.
 *
 * This is the steady state of any cache: entries are evicted as fast as they
 * arrive, so `size` never moves but every insert consumes growth. It is the
 * shape that exposes whether spent growth is reclaimed in amortized time.
 */
function churnPlan(capacity: number, pairs: number) {
  const filled = Math.floor((capacity * 7) / 8);
  return { filled, pairs, firstFresh: capacity * 4 };
}

describe("growth under steady-state churn", () => {
  test("SwissU32ToU32 grows out of the load factor instead of rehashing per insert", async () => {
    const table = await SwissU32ToU32.create(65_536);
    const { filled, pairs, firstFresh } = churnPlan(table.capacity, 4_000);

    for (let key = 0; key < filled; key += 1) table.set(key, key);

    const startCapacity = table.capacity;

    for (let i = 0; i < pairs; i += 1) {
      table.delete(i);
      table.set(firstFresh + i, 1);
    }

    // Live count is unchanged, so a table that only doubles at the load
    // factor never doubles here — it compacts in place on every single
    // insert, recovering exactly one slot each time. Growing is what makes
    // the reclaim amortized.
    expect(table.size).toBe(filled);
    expect(table.capacity).toBeGreaterThan(startCapacity);
  });

  test("SwissU32ToU64 grows out of the load factor instead of rehashing per insert", async () => {
    const table = await SwissU32ToU64.create(65_536);
    const { filled, pairs, firstFresh } = churnPlan(table.capacity, 4_000);

    for (let key = 0; key < filled; key += 1) table.set(key, key, 0);

    const startCapacity = table.capacity;

    for (let i = 0; i < pairs; i += 1) {
      table.delete(i);
      table.set(firstFresh + i, 1, 0);
    }

    expect(table.size).toBe(filled);
    expect(table.capacity).toBeGreaterThan(startCapacity);
  });

  test("churn at the load factor stays within a small multiple of an empty table", async () => {
    // `atLoadFactor` is resolved against the capacity the table actually
    // allocated, not the requested one — they differ by a doubling, and
    // measuring 7/8 of the request lands at 7/16 of the capacity, which is
    // not the state under test.
    const atLoadFactor = Symbol("7/8 of the allocated capacity");

    async function perPairMicros(
      filled: number | typeof atLoadFactor,
    ): Promise<number> {
      const table = await SwissU32ToU32.create(65_536);
      const target =
        filled === atLoadFactor ? Math.floor((table.capacity * 7) / 8) : filled;

      for (let key = 0; key < target; key += 1) table.set(key, key);

      // Enough pairs that one run spans milliseconds rather than the tens of
      // microseconds an earlier version measured, where a single GC pause
      // preceding the test decided the result.
      const pairs = 50_000;
      const fresh = table.capacity * 4;

      // Evict the key inserted `target` steps ago, so the live count holds at
      // `target` for the whole run. Deleting `i` outright stops matching
      // anything once i passes `target`, which turns eviction into growth and
      // measures the wrong thing.
      const evicted = (i: number) => (i < target ? i : fresh + i - target);

      const start = performance.now();

      for (let i = 0; i < pairs; i += 1) {
        table.delete(evicted(i));
        table.set(fresh + i, 1);
      }

      return ((performance.now() - start) * 1000) / pairs;
    }

    /** Best of three: a slow trial is interference, a fast one is not. */
    async function best(
      filled: number | typeof atLoadFactor,
    ): Promise<number> {
      let fastest = Infinity;
      for (let trial = 0; trial < 3; trial += 1) {
        fastest = Math.min(fastest, await perPairMicros(filled));
      }
      return fastest;
    }

    const empty = await best(2_000);
    const loaded = await best(atLoadFactor);

    // Deliberately loose: the regression this guards against is four orders of
    // magnitude, so a bound that tolerates a noisy machine still catches it
    // with room to spare.
    expect(loaded / empty).toBeLessThan(25);
  });
});
