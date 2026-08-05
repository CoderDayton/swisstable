import { describe, expect, test } from "bun:test";

import { SwissU32ToU32, SwissU32ToU64 } from "../src/index.ts";

/**
 * Entries to fill and then mostly remove.
 *
 * Large enough that the grown capacity is several scan windows and the
 * shrunk one is a single small bank, so the difference the walk pays is not
 * a rounding artefact of a table that was near-minimal to begin with.
 */
const PEAK_ENTRIES = 100_000;

/** Entries left behind after the removals. */
const REMAINING_ENTRIES = 8;

describe("SwissU32ToU32.shrinkToFit", () => {
  test("drops capacity to fit the survivors and keeps every one", async () => {
    const table = await SwissU32ToU32.create(PEAK_ENTRIES);

    for (let key = 0; key < PEAK_ENTRIES; key += 1) table.set(key, key * 3);
    for (let key = REMAINING_ENTRIES; key < PEAK_ENTRIES; key += 1) {
      table.delete(key);
    }

    const grown = table.capacity;
    table.shrinkToFit();

    expect(table.capacity).toBeLessThan(grown);
    expect(table.size).toBe(REMAINING_ENTRIES);

    for (let key = 0; key < REMAINING_ENTRIES; key += 1) {
      expect(table.get(key)).toBe(key * 3);
    }
  });

  test("the walk afterwards visits only the surviving entries", async () => {
    const table = await SwissU32ToU32.create(PEAK_ENTRIES);

    for (let key = 0; key < PEAK_ENTRIES; key += 1) table.set(key, key);
    for (let key = REMAINING_ENTRIES; key < PEAK_ENTRIES; key += 1) {
      table.delete(key);
    }

    table.shrinkToFit();

    expect([...table.keys()].sort((a, b) => a - b)).toEqual(
      Array.from({ length: REMAINING_ENTRIES }, (_, i) => i),
    );
  });

  test("leaves room to spare, so the next insert does not rehash", async () => {
    const table = await SwissU32ToU32.create(PEAK_ENTRIES);

    for (let key = 0; key < PEAK_ENTRIES; key += 1) table.set(key, key);
    for (let key = REMAINING_ENTRIES; key < PEAK_ENTRIES; key += 1) {
      table.delete(key);
    }

    table.shrinkToFit();
    const shrunk = table.capacity;

    table.set(0xdead_beef, 1);

    expect(table.capacity).toBe(shrunk);
    expect(table.get(0xdead_beef)).toBe(1);
  });

  test("is a no-op on a table already at its smallest capacity", async () => {
    const table = await SwissU32ToU32.create();
    table.set(1, 1);

    const before = table.capacity;
    table.shrinkToFit();

    expect(table.capacity).toBe(before);
    expect(table.get(1)).toBe(1);
  });

  test("is a no-op on a table that has never been sized", async () => {
    const table = await SwissU32ToU32.create();

    table.shrinkToFit();

    expect(table.size).toBe(0);
  });

  test("a shrink is a rehash, so it is reported to an open iterator", async () => {
    const table = await SwissU32ToU32.create(PEAK_ENTRIES);

    for (let key = 0; key < PEAK_ENTRIES; key += 1) table.set(key, key);
    for (let key = REMAINING_ENTRIES; key < PEAK_ENTRIES; key += 1) {
      table.delete(key);
    }

    const walk = table.entries();
    table.shrinkToFit();

    expect(() => walk.next()).toThrow(/rehashed during iteration/);
  });

  test("a table emptied entirely still holds its entries afterwards", async () => {
    const table = await SwissU32ToU32.create(PEAK_ENTRIES);

    for (let key = 0; key < PEAK_ENTRIES; key += 1) table.set(key, key);
    for (let key = 0; key < PEAK_ENTRIES; key += 1) table.delete(key);

    table.shrinkToFit();

    expect(table.size).toBe(0);
    expect([...table.keys()]).toEqual([]);

    table.set(7, 7);
    expect(table.get(7)).toBe(7);
  });
});

describe("SwissU32ToU64.shrinkToFit", () => {
  test("drops capacity to fit the survivors and keeps their lanes", async () => {
    const table = await SwissU32ToU64.create(PEAK_ENTRIES);

    for (let key = 0; key < PEAK_ENTRIES; key += 1) {
      table.set(key, key * 2, key * 5);
    }
    for (let key = REMAINING_ENTRIES; key < PEAK_ENTRIES; key += 1) {
      table.delete(key);
    }

    const grown = table.capacity;
    table.shrinkToFit();

    expect(table.capacity).toBeLessThan(grown);
    expect(table.size).toBe(REMAINING_ENTRIES);

    for (let key = 0; key < REMAINING_ENTRIES; key += 1) {
      expect(table.get(key)).toEqual({ lo: key * 2, hi: key * 5 });
    }
  });

  test("a shrink is reported to an open iterator", async () => {
    const table = await SwissU32ToU64.create(PEAK_ENTRIES);

    for (let key = 0; key < PEAK_ENTRIES; key += 1) table.set(key, key, key);
    for (let key = REMAINING_ENTRIES; key < PEAK_ENTRIES; key += 1) {
      table.delete(key);
    }

    const walk = table.entries();
    table.shrinkToFit();

    expect(() => walk.next()).toThrow(/rehashed during iteration/);
  });
});
