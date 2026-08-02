import { describe, expect, test } from "bun:test";

import { SwissU32ToU32, SwissU32ToU64 } from "../src/index.ts";

/**
 * Entries needed to push capacity past one scan window.
 *
 * The scan hands back one window of slots per crossing, so a table smaller
 * than a window exercises exactly one chunk and never crosses a boundary —
 * which is where resumption, mutation detection, and the copy-out all live.
 * 100k entries size the table to 262144 slots, four windows.
 */
const MULTI_WINDOW_ENTRIES = 100_000;

/** xorshift32, so a failure reproduces from the seed alone. */
function rng(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

/**
 * Builds a table and a `Map` holding the same entries, through a mixed
 * insert/delete sequence so the control array is left full of tombstones
 * rather than a clean prefix of live slots.
 */
async function churned(
  operations: number,
  seed: number,
): Promise<{ table: SwissU32ToU32; oracle: Map<number, number> }> {
  const table = await SwissU32ToU32.create(1000);
  const oracle = new Map<number, number>();
  const random = rng(seed);

  for (let i = 0; i < operations; i += 1) {
    const key = Math.floor(random() * (operations / 2)) >>> 0;

    if (random() < 0.7) {
      const value = Math.floor(random() * 0xffff_ffff) >>> 0;
      table.set(key, value);
      oracle.set(key, value);
    } else {
      table.delete(key);
      oracle.delete(key);
    }
  }

  return { table, oracle };
}

describe("SwissU32ToU32 iteration", () => {
  test("keys() yields every live key exactly once", async () => {
    const { table, oracle } = await churned(50_000, 0x1234);

    const seen = [...table.keys()];

    expect(seen.length).toBe(oracle.size);
    expect(new Set(seen).size).toBe(oracle.size);
    expect(seen.every((key) => oracle.has(key))).toBe(true);
  });

  test("values() yields every live value, matching multiplicity", async () => {
    const { table, oracle } = await churned(50_000, 0x2345);

    const seen = [...table.values()].sort((a, b) => a - b);
    const expected = [...oracle.values()].sort((a, b) => a - b);

    expect(seen).toEqual(expected);
  });

  test("entries() pairs each key with its own value", async () => {
    const { table, oracle } = await churned(50_000, 0x3456);

    let wrong = 0;
    let count = 0;
    for (const [key, value] of table.entries()) {
      if (oracle.get(key) !== value) wrong += 1;
      count += 1;
    }

    expect(wrong).toBe(0);
    expect(count).toBe(oracle.size);
  });

  test("the table is iterable, yielding the same pairs as entries()", async () => {
    const table = await SwissU32ToU32.create(100);
    table.set(1, 10).set(2, 20).set(3, 30);

    expect([...table].sort((a, b) => a[0] - b[0])).toEqual([
      [1, 10],
      [2, 20],
      [3, 30],
    ]);
  });

  test("forEach passes value, key, and the table, and honours thisArg", async () => {
    const table = await SwissU32ToU32.create(100);
    table.set(7, 70);

    const context = { seen: [] as unknown[] };
    table.forEach(function (this: typeof context, value, key, self) {
      this.seen.push(value, key, self);
    }, context);

    expect(context.seen).toEqual([70, 7, table]);
  });

  test("an empty table yields nothing", async () => {
    const table = await SwissU32ToU32.create(1000);

    expect([...table.keys()]).toEqual([]);
    expect([...table.entries()]).toEqual([]);

    let calls = 0;
    table.forEach(() => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  test("a cleared table yields nothing after having held entries", async () => {
    const table = await SwissU32ToU32.create(1000);
    for (let i = 0; i < 500; i += 1) table.set(i, i);
    table.clear();

    expect([...table.keys()]).toEqual([]);
  });

  test("deleted keys are skipped rather than yielded as tombstones", async () => {
    const table = await SwissU32ToU32.create(1000);
    for (let i = 0; i < 512; i += 1) table.set(i, i);
    for (let i = 0; i < 512; i += 2) table.delete(i);

    const seen = [...table.keys()].sort((a, b) => a - b);

    expect(seen.length).toBe(256);
    expect(seen[0]).toBe(1);
    expect(seen.every((key) => key % 2 === 1)).toBe(true);
  });

  // Slot order is unspecified and deliberately so, but the whole slot space
  // still has to be walked: a table larger than one scan window is where a
  // dropped or repeated chunk would show up.
  test("covers a table spanning several scan windows", async () => {
    const table = await SwissU32ToU32.create(MULTI_WINDOW_ENTRIES);
    for (let i = 0; i < MULTI_WINDOW_ENTRIES; i += 1) table.set(i, i ^ 0x5a5a);

    expect(table.capacity).toBeGreaterThan(65_536);

    let count = 0;
    let wrong = 0;
    const seen = new Uint8Array(MULTI_WINDOW_ENTRIES);
    for (const [key, value] of table) {
      if (value !== (key ^ 0x5a5a)) wrong += 1;
      if (seen[key] === 1) wrong += 1;
      seen[key] = 1;
      count += 1;
    }

    expect(wrong).toBe(0);
    expect(count).toBe(MULTI_WINDOW_ENTRIES);
  });

  // Each iterator carries its own cursor and its own copy of the current
  // chunk, so two of them can be advanced alternately without either one
  // observing the other's scan.
  test("two iterators interleave without disturbing each other", async () => {
    const table = await SwissU32ToU32.create(MULTI_WINDOW_ENTRIES);
    for (let i = 0; i < MULTI_WINDOW_ENTRIES; i += 1) table.set(i, i);

    const first = table.keys();
    const second = table.keys();
    const fromFirst: number[] = [];
    const fromSecond: number[] = [];

    for (;;) {
      const a = first.next();
      const b = second.next();
      if (a.done && b.done) break;
      if (!a.done) fromFirst.push(a.value);
      if (!b.done) fromSecond.push(b.value);
    }

    expect(fromFirst.length).toBe(MULTI_WINDOW_ENTRIES);
    expect(fromSecond).toEqual(fromFirst);
  });

  test("a rehash during iteration is reported rather than skipping entries", async () => {
    const table = await SwissU32ToU32.create(MULTI_WINDOW_ENTRIES);
    for (let i = 0; i < MULTI_WINDOW_ENTRIES; i += 1) table.set(i, i);

    const iterator = table.entries();
    iterator.next();

    table.reserve(500_000);

    expect(() => [...iterator]).toThrow(/rehash/i);
  });

  test("a rehash before the first next() is reported, not a buffer overrun", async () => {
    // The iterator sizes its chunk buffers from the capacity it sees when
    // it is built, so the walk has to be pinned to that same capacity.
    const table = await SwissU32ToU32.create(1);
    table.set(0, 0);

    const iterator = table.entries();

    for (let i = 0; i < MULTI_WINDOW_ENTRIES; i += 1) table.set(i, i);

    expect(() => iterator.next()).toThrow(/rehash/i);
  });

  test("a clear during iteration is reported too", async () => {
    const table = await SwissU32ToU32.create(MULTI_WINDOW_ENTRIES);
    for (let i = 0; i < MULTI_WINDOW_ENTRIES; i += 1) table.set(i, i);

    const iterator = table.keys();
    iterator.next();

    table.clear();

    expect(() => [...iterator]).toThrow(/rehash/i);
  });
});

describe("SwissU32ToU64 iteration", () => {
  test("entries() pairs each key with its own lanes", async () => {
    const table = await SwissU32ToU64.create(1000);
    for (let i = 1; i <= 500; i += 1) table.set(i, i * 3, i * 5);

    let wrong = 0;
    let count = 0;
    for (const [key, { lo, hi }] of table.entries()) {
      if (lo !== key * 3 || hi !== key * 5) wrong += 1;
      count += 1;
    }

    expect(wrong).toBe(0);
    expect(count).toBe(500);
  });

  test("keys() and values() agree with the single-key API", async () => {
    const table = await SwissU32ToU64.create(1000);
    table.set(1, 11, 111).set(2, 22, 222);

    expect([...table.keys()].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(
      [...table.values()].sort((a, b) => a.lo - b.lo),
    ).toEqual([
      { lo: 11, hi: 111 },
      { lo: 22, hi: 222 },
    ]);
  });

  test("forEach passes lanes, key, and the table", async () => {
    const table = await SwissU32ToU64.create(100);
    table.set(9, 90, 900);

    const seen: unknown[] = [];
    table.forEach((value, key, self) => seen.push(value, key, self));

    expect(seen).toEqual([{ lo: 90, hi: 900 }, 9, table]);
  });

  // The scan writes through the same staging buffers the bulk methods use,
  // so an iterator that yielded views over them would hand back whatever the
  // interleaved call left behind. The chunk is copied out before it yields.
  test("an interleaved getMany does not corrupt an open iterator", async () => {
    const table = await SwissU32ToU64.create(1000);
    for (let i = 1; i <= 100; i += 1) table.set(i, i, 0);

    const iterator = table.entries();
    const first = iterator.next().value as [number, { lo: number; hi: number }];

    table.getMany(new Uint32Array([1, 2, 3]));

    const rest = [...iterator];

    expect(rest.length).toBe(99);
    expect(rest.every(([key, value]) => value.lo === key)).toBe(true);
    expect(first[1].lo).toBe(first[0]);
  });

  test("covers a table spanning several scan windows", async () => {
    const table = await SwissU32ToU64.create(MULTI_WINDOW_ENTRIES);
    for (let i = 0; i < MULTI_WINDOW_ENTRIES; i += 1) table.set(i, i, i ^ 0xf0f0);

    let count = 0;
    let wrong = 0;
    for (const [key, { lo, hi }] of table) {
      if (lo !== key || hi !== (key ^ 0xf0f0)) wrong += 1;
      count += 1;
    }

    expect(wrong).toBe(0);
    expect(count).toBe(MULTI_WINDOW_ENTRIES);
  });

  test("a rehash before the first next() is reported, not a buffer overrun", async () => {
    const table = await SwissU32ToU64.create(1);
    table.set(0, 0, 0);

    const iterator = table.entries();

    for (let i = 0; i < MULTI_WINDOW_ENTRIES; i += 1) table.set(i, i, 0);

    expect(() => iterator.next()).toThrow(/rehash/i);
  });
});
