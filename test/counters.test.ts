import { describe, expect, test } from "bun:test";

import { SwissU32ToU32, SwissU32ToU64 } from "../src/index.ts";

/**
 * `size` and `capacity` are read out of linear memory rather than by calling
 * the matching exports, so every path that moves either counter needs to be
 * shown to move the view too.
 *
 * The exports are still the definition. These tests compare the properties
 * against them directly, so a view left pointing at the wrong address — or a
 * counter the module updates somewhere the view does not see — fails here
 * rather than as a wrong answer somewhere downstream.
 */

/** Enough entries to force several growth rehashes on the way up. */
const MANY_ENTRIES = 50_000;

/** Reaches into the module the binding wraps, to compare against its exports. */
interface RawCounters {
  size(): number;
  capacity(): number;
}

function raw(table: object): RawCounters {
  return (table as unknown as { wasm: RawCounters }).wasm;
}

function expectAgreement(table: SwissU32ToU32 | SwissU32ToU64): void {
  expect(table.size).toBe(raw(table).size() >>> 0);
  expect(table.capacity).toBe(raw(table).capacity() >>> 0);
}

describe("SwissU32ToU32 counters", () => {
  test("agree with the exports across growth, deletes, clear, and shrink", async () => {
    const table = await SwissU32ToU32.create();
    expectAgreement(table);

    for (let key = 0; key < MANY_ENTRIES; key += 1) {
      table.set(key, key);
      // Checked at every boundary a rehash could land on, not just at the end.
      if ((key & 0x3ff) === 0) expectAgreement(table);
    }
    expectAgreement(table);

    for (let key = 0; key < MANY_ENTRIES; key += 2) table.delete(key);
    expectAgreement(table);

    table.shrinkToFit();
    expectAgreement(table);

    table.clear();
    expectAgreement(table);

    table.reserve(MANY_ENTRIES);
    expectAgreement(table);
  });

  test("size tracks each individual mutation", async () => {
    const table = await SwissU32ToU32.create(64);

    expect(table.size).toBe(0);

    table.set(1, 1);
    expect(table.size).toBe(1);

    // An overwrite is not a new entry.
    table.set(1, 2);
    expect(table.size).toBe(1);

    table.set(2, 2);
    expect(table.size).toBe(2);

    table.delete(1);
    expect(table.size).toBe(1);

    // Deleting an absent key changes nothing.
    table.delete(1);
    expect(table.size).toBe(1);

    table.clear();
    expect(table.size).toBe(0);
  });

  test("capacity rises on growth and falls only on shrink", async () => {
    const table = await SwissU32ToU32.create();
    const initial = table.capacity;

    for (let key = 0; key < MANY_ENTRIES; key += 1) table.set(key, key);
    const grown = table.capacity;
    expect(grown).toBeGreaterThan(initial);

    for (let key = 0; key < MANY_ENTRIES; key += 1) table.delete(key);
    expect(table.capacity).toBe(grown);

    table.clear();
    expect(table.capacity).toBe(grown);

    table.shrinkToFit();
    expect(table.capacity).toBeLessThan(grown);
  });

  test("two tables report their own counters, not a shared one", async () => {
    // One instance is one table, so a view built against the wrong module's
    // memory would show up as two tables agreeing when they should not.
    const first = await SwissU32ToU32.create(64);
    const second = await SwissU32ToU32.create(64);

    first.set(1, 1);
    first.set(2, 2);
    second.set(3, 3);

    expect(first.size).toBe(2);
    expect(second.size).toBe(1);
    expectAgreement(first);
    expectAgreement(second);
  });

  test("counters survive a re-init through load()", async () => {
    const table = await SwissU32ToU32.create(MANY_ENTRIES);
    for (let key = 0; key < 1000; key += 1) table.set(key, key);

    expect(table.size).toBe(1000);
    expectAgreement(table);
  });
});

describe("SwissU32ToU64 counters", () => {
  test("agree with the exports across growth, deletes, clear, and shrink", async () => {
    const table = await SwissU32ToU64.create();
    expectAgreement(table);

    for (let key = 0; key < MANY_ENTRIES; key += 1) {
      table.set(key, key, key);
      if ((key & 0x3ff) === 0) expectAgreement(table);
    }
    expectAgreement(table);

    for (let key = 0; key < MANY_ENTRIES; key += 2) table.delete(key);
    expectAgreement(table);

    table.shrinkToFit();
    expectAgreement(table);

    table.clear();
    expectAgreement(table);
  });

  test("reserve moves capacity without disturbing size", async () => {
    const table = await SwissU32ToU64.create();
    for (let key = 0; key < 100; key += 1) table.set(key, key, key);

    const before = table.capacity;
    table.reserve(MANY_ENTRIES);

    expect(table.capacity).toBeGreaterThan(before);
    expect(table.size).toBe(100);
    expectAgreement(table);
  });

  test("two tables report their own counters, not a shared one", async () => {
    const first = await SwissU32ToU64.create(64);
    const second = await SwissU32ToU64.create(64);

    first.set(1, 1, 1);
    first.set(2, 2, 2);
    second.set(3, 3, 3);

    expect(first.size).toBe(2);
    expect(second.size).toBe(1);
    expectAgreement(first);
    expectAgreement(second);
  });

  test("the bulk methods move the counters too", async () => {
    const table = await SwissU32ToU64.create();
    const keys = Uint32Array.from({ length: 5000 }, (_, i) => i);

    table.setMany(keys, keys, keys);
    expect(table.size).toBe(5000);
    expectAgreement(table);

    table.deleteMany(keys.subarray(0, 2000));
    expect(table.size).toBe(3000);
    expectAgreement(table);
  });
});
