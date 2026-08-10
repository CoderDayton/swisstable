import { describe, expect, test } from "bun:test";

import {
  InternedSwissMap,
  StringInterner,
  SwissU32ToU32,
  SwissU32ToU64,
} from "../src/index.ts";

/** Live entries at the 7/8 load factor over `1 << 20` slots. */
const MAX_ENTRIES = 917_504;

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

describe("differential against Map", () => {
  test("agrees over 100k mixed operations", async () => {
    const table = await SwissU32ToU32.create(1000);
    const oracle = new Map<number, number>();
    const random = rng(0x5eed);

    for (let i = 0; i < 100_000; i += 1) {
      const key = Math.floor(random() * 50_000) >>> 0;
      const roll = random();

      if (roll < 0.55) {
        const value = Math.floor(random() * 0xffff_ffff) >>> 0;
        table.set(key, value);
        oracle.set(key, value);
      } else if (roll < 0.75) {
        expect(table.delete(key)).toBe(oracle.delete(key));
      } else if (roll < 0.9) {
        expect(table.get(key)).toBe(oracle.get(key) as number);
      } else {
        expect(table.has(key)).toBe(oracle.has(key));
      }
    }

    expect(table.size).toBe(oracle.size);

    let mismatches = 0;
    for (const [key, value] of oracle) {
      if (table.get(key) !== value) mismatches += 1;
    }
    expect(mismatches).toBe(0);
  });
});

describe("capacity ceiling", () => {
  test("fills to the compiled maximum and reads every entry back", async () => {
    const table = await SwissU32ToU32.create(MAX_ENTRIES);

    for (let i = 0; i < MAX_ENTRIES; i += 1) table.set(i, i ^ 0xa5a5);

    expect(table.size).toBe(MAX_ENTRIES);

    let wrong = 0;
    for (let i = 0; i < MAX_ENTRIES; i += 1) {
      if (table.get(i) !== (i ^ 0xa5a5)) wrong += 1;
    }
    expect(wrong).toBe(0);
  });

  // A full table has no room for a new key, but overwriting one that is
  // already present needs none, so set() has to look for the key before it
  // reserves space rather than after.
  test("overwrites at capacity but rejects a new key", async () => {
    const table = await SwissU32ToU32.create(MAX_ENTRIES);
    for (let i = 0; i < MAX_ENTRIES; i += 1) table.set(i, i);

    expect(() => table.set(5, 12_345)).not.toThrow();
    expect(table.get(5)).toBe(12_345);
    expect(() => table.set(MAX_ENTRIES + 1, 1)).toThrow(RangeError);
  });

  test("rejects a create beyond capacity without poisoning later creates", async () => {
    await expect(SwissU32ToU32.create(MAX_ENTRIES + 1)).rejects.toThrow(RangeError);

    const table = await SwissU32ToU32.create(100);
    expect(table.capacity).toBe(256);
  });
});

describe("tombstone churn", () => {
  test("repeated fill and delete leaves capacity where it started", async () => {
    const table = await SwissU32ToU32.create(10_000);
    const startCapacity = table.capacity;

    for (let round = 0; round < 20; round += 1) {
      for (let i = 0; i < 5_000; i += 1) table.set(round * 100_000 + i, i);
      for (let i = 0; i < 5_000; i += 1) table.delete(round * 100_000 + i);
    }

    expect(table.size).toBe(0);
    expect(table.capacity).toBe(startCapacity);

    table.set(1, 1);
    expect(table.get(1)).toBe(1);
  });

  test("survives repeated fill and clear cycles", async () => {
    const table = await SwissU32ToU32.create(100);

    for (let round = 0; round < 5; round += 1) {
      for (let i = 0; i < 20_000; i += 1) table.set(i, i);
      expect(table.size).toBe(20_000);
      table.clear();
      expect(table.size).toBe(0);
    }
  });
});

describe("reserve", () => {
  test("preserves contents while growing", async () => {
    const table = await SwissU32ToU32.create();
    for (let i = 0; i < 100; i += 1) table.set(i, i * 3);

    const before = table.capacity;
    table.reserve(200_000);

    expect(table.capacity).toBeGreaterThan(before);
    expect(table.size).toBe(100);

    let wrong = 0;
    for (let i = 0; i < 100; i += 1) if (table.get(i) !== i * 3) wrong += 1;
    expect(wrong).toBe(0);
  });

  test("shrinking is a no-op and a rejected reserve leaves the table usable", async () => {
    const table = await SwissU32ToU32.create(1000);
    const before = table.capacity;

    table.reserve(10);
    expect(table.capacity).toBe(before);

    expect(() => table.reserve(2_000_000)).toThrow(RangeError);
    expect(table.capacity).toBe(before);

    table.set(1, 1);
    expect(table.get(1)).toBe(1);
  });
});

describe("bulk results", () => {
  // The staging buffers live in WASM memory and are reused every call, so
  // the results have to be copies. If they were views, a second call would
  // rewrite a result the caller still holds.
  test("a getMany result is not disturbed by a later call", async () => {
    const table = await SwissU32ToU64.create(1000);
    table.set(1, 111, 0);
    table.set(2, 222, 0);

    const first = table.getMany(new Uint32Array([1]));
    table.getMany(new Uint32Array([2]));

    expect(first.valsLo[0]).toBe(111);
    expect(first.found[0]).toBe(1);
  });

  test("a deleteMany result is not disturbed by a later call", async () => {
    const table = await SwissU32ToU64.create(1000);
    table.set(1, 1, 0);
    table.set(2, 2, 0);

    const first = table.deleteMany(new Uint32Array([1]));
    table.deleteMany(new Uint32Array([2]));

    expect(first.deleted[0]).toBe(1);
    expect(first.removedCount).toBe(1);
  });

  test("chunks a batch larger than maxBatch", async () => {
    const table = await SwissU32ToU64.create(300_000);
    const count = 250_000;

    expect(count).toBeGreaterThan(table.maxBatch);

    const keys = new Uint32Array(count);
    const lo = new Uint32Array(count);
    const hi = new Uint32Array(count);
    for (let i = 0; i < count; i += 1) {
      keys[i] = (i * 2_654_435_761) >>> 0;
      lo[i] = i >>> 0;
      hi[i] = (i ^ 0xdead) >>> 0;
    }

    table.setMany(keys, lo, hi);
    expect(table.size).toBe(count);

    const got = table.getMany(keys);
    let wrong = 0;
    for (let i = 0; i < count; i += 1) {
      if (!got.found[i] || got.valsLo[i] !== lo[i] || got.valsHi[i] !== hi[i]) {
        wrong += 1;
      }
    }
    expect(wrong).toBe(0);

    expect(table.deleteMany(keys.subarray(0, 1000)).removedCount).toBe(1000);
    expect(table.deleteMany(keys.subarray(0, 10)).removedCount).toBe(0);
  });

  test("an empty batch is a no-op", async () => {
    const table = await SwissU32ToU64.create(100);
    const empty = new Uint32Array(0);

    table.setMany(empty, empty, empty);

    expect(table.size).toBe(0);
    expect(table.getMany(empty).found.length).toBe(0);
    expect(table.deleteMany(empty).removedCount).toBe(0);
  });
});

describe("InternedSwissMap.size", () => {
  test("counts live entries rather than interned strings", async () => {
    const map = new InternedSwissMap(await SwissU32ToU32.create(1000));

    map.set("x", 1).set("y", 2).set("x", 3);
    expect(map.size).toBe(2);

    map.delete("x");

    // The entry is gone, but the ID it was assigned is not reclaimed.
    expect(map.size).toBe(1);
    expect(map.interner.size).toBe(2);
  });

  test("shares a count with the table it wraps", async () => {
    const table = await SwissU32ToU32.create(1000);
    const map = new InternedSwissMap(table, new StringInterner());

    map.set("a", 1);
    table.set(999, 2);

    expect(map.size).toBe(2);
    expect(map.size).toBe(table.size);
  });
});
