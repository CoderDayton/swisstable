import { describe, expect, test } from "bun:test";

import { SwissU32ToU32, SwissU32ToU64 } from "../src/index.ts";

/**
 * Entries interesting enough that a disposed table is not indistinguishable
 * from a fresh one: size and capacity both read non-zero before the call.
 */
const ENTRIES = 1_000;

describe("SwissU32ToU32.dispose", () => {
  test("reports an empty table and refuses every data method", async () => {
    const table = await SwissU32ToU32.create(ENTRIES);
    for (let key = 0; key < ENTRIES; key += 1) table.set(key, key * 3);

    expect(table.size).toBe(ENTRIES);
    expect(table.capacity).toBeGreaterThan(0);

    table.dispose();

    expect(table.size).toBe(0);
    expect(table.capacity).toBe(0);

    // Every crossing goes through the exports object dispose swapped, so
    // each of these names the class rather than failing as a bare TypeError.
    expect(() => table.get(1)).toThrow(/used after dispose/);
    expect(() => table.set(1, 1)).toThrow(/used after dispose/);
    expect(() => table.has(1)).toThrow(/used after dispose/);
    expect(() => table.delete(1)).toThrow(/used after dispose/);
    expect(() => table.clear()).toThrow(/used after dispose/);
    expect(() => table.reserve(10)).toThrow(/used after dispose/);
    expect(() => table.shrinkToFit()).toThrow(/used after dispose/);
    expect(() => [...table]).toThrow(/used after dispose/);
    expect(() => table.forEach(() => {})).toThrow(/used after dispose/);
  });

  test("names the class it was called on", async () => {
    const table = await SwissU32ToU32.create();
    table.dispose();
    expect(() => table.get(1)).toThrow(/SwissU32ToU32/);
  });

  test("is idempotent", async () => {
    const table = await SwissU32ToU32.create(ENTRIES);
    table.set(1, 1);

    table.dispose();
    table.dispose();

    expect(table.size).toBe(0);
    expect(() => table.get(1)).toThrow(/used after dispose/);
  });

  test("leaves other tables untouched", async () => {
    const doomed = await SwissU32ToU32.create(ENTRIES);
    const survivor = await SwissU32ToU32.create(ENTRIES);

    doomed.set(7, 70);
    survivor.set(7, 70);

    doomed.dispose();

    expect(survivor.get(7)).toBe(70);
    expect(survivor.size).toBe(1);
  });

  test("works with `using`", async () => {
    // Guarded because the oldest supported Node predates Symbol.dispose,
    // which is exactly why the alias is attached conditionally.
    expect(typeof Symbol.dispose).toBe("symbol");

    let escaped: SwissU32ToU32;
    {
      using table = await SwissU32ToU32.create(ENTRIES);
      table.set(1, 42);
      expect(table.get(1)).toBe(42);
      escaped = table;
    }

    expect(escaped.size).toBe(0);
    expect(() => escaped.get(1)).toThrow(/used after dispose/);
  });
});

describe("SwissU32ToU64.dispose", () => {
  test("reports an empty table and refuses every data method", async () => {
    const table = await SwissU32ToU64.create(ENTRIES);
    for (let key = 0; key < ENTRIES; key += 1) table.set(key, key, 0);

    expect(table.size).toBe(ENTRIES);

    table.dispose();

    expect(table.size).toBe(0);
    expect(table.capacity).toBe(0);

    expect(() => table.get(1)).toThrow(/used after dispose/);
    expect(() => table.set(1, 1, 0)).toThrow(/used after dispose/);
    expect(() => table.has(1)).toThrow(/used after dispose/);
    expect(() => table.delete(1)).toThrow(/used after dispose/);
    expect(() => [...table]).toThrow(/used after dispose/);
  });

  test("refuses the bulk methods, whose staging views it dropped", async () => {
    const table = await SwissU32ToU64.create(ENTRIES);
    table.setMany([1, 2], [10, 20], [0, 0]);

    table.dispose();

    expect(() => table.setMany([1], [1], [0])).toThrow(/used after dispose/);
    expect(() => table.getMany([1])).toThrow(/used after dispose/);
    expect(() => table.deleteMany([1])).toThrow(/used after dispose/);

    // A typed-array source stages with a single bulk copy, which fails inside
    // the copy rather than at the boundary; an empty batch never crosses at
    // all. Both have to report dispose rather than a buffer-offset error or
    // an empty success.
    const one = new Uint32Array([1]);
    expect(() => table.setMany(one, one, one)).toThrow(/used after dispose/);
    expect(() => table.getMany(one)).toThrow(/used after dispose/);
    expect(() => table.deleteMany(one)).toThrow(/used after dispose/);
    expect(() => table.getMany([])).toThrow(/used after dispose/);
    expect(() => table.deleteMany([])).toThrow(/used after dispose/);
  });

  test("names the class it was called on", async () => {
    const table = await SwissU32ToU64.create();
    table.dispose();
    expect(() => table.get(1)).toThrow(/SwissU32ToU64/);
  });

  test("works with `using`", async () => {
    let escaped: SwissU32ToU64;
    {
      using table = await SwissU32ToU64.create(ENTRIES);
      table.set(1, 42, 0);
      expect(table.get(1)).toEqual({ lo: 42, hi: 0 });
      escaped = table;
    }

    expect(escaped.size).toBe(0);
    expect(() => escaped.get(1)).toThrow(/used after dispose/);
  });
});
