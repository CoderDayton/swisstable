import { describe, expect, test } from "bun:test";

import { SwissU32ToU32 } from "../src/index.ts";

/** Fixed so a failure reproduces; these tests never see untrusted input. */
const SEED = 0x0b17_c0de;

/** Sparse keys, so nothing depends on a dense run mapping onto slot order. */
function sparseKeys(count: number, from = 0): Uint32Array {
  const keys = new Uint32Array(count);
  for (let i = 0; i < count; i++) keys[i] = (from + i) * 2_654_435_761 >>> 0;
  return keys;
}

async function table(expectedEntries = 0): Promise<SwissU32ToU32> {
  return SwissU32ToU32.createWithSeed(expectedEntries, SEED);
}

describe("u32 bulk API", () => {
  test("setMany then getMany round-trips every pair", async () => {
    using t = await table(4_096);
    const keys = sparseKeys(4_096);
    const values = keys.map((key) => (key ^ 0x5a5a_5a5a) >>> 0);

    t.setMany(keys, values);

    expect(t.size).toBe(4_096);

    const { values: out, found } = t.getMany(keys);

    expect([...found]).toEqual(Array.from({ length: 4_096 }, () => 1));
    expect([...out]).toEqual([...values]);
  });

  test("getMany reports misses and zeroes their values", async () => {
    using t = await table();
    t.setMany([1, 2, 3], [10, 20, 30]);

    const { values, found } = t.getMany([1, 999, 3]);

    expect([...found]).toEqual([1, 0, 1]);
    expect([...values]).toEqual([10, 0, 30]);
  });

  test("a reused out buffer never mixes in the previous batch's values", async () => {
    using t = await table();
    t.setMany([1, 2], [11, 22]);

    const out = t.getMany([1, 2]);
    expect([...out.values]).toEqual([11, 22]);

    t.getMany([1, 404], out);
    expect([...out.found]).toEqual([1, 0]);
    expect([...out.values]).toEqual([11, 0]);
  });

  test("setMany overwrites an existing key rather than duplicating it", async () => {
    using t = await table();
    t.setMany([7, 8], [1, 2]);
    t.setMany([7, 8], [3, 4]);

    expect(t.size).toBe(2);
    expect([...t.getMany([7, 8]).values]).toEqual([3, 4]);
  });

  test("deleteMany reports per-key flags and a total", async () => {
    using t = await table();
    t.setMany([1, 2, 3], [1, 2, 3]);

    const { deleted, removedCount } = t.deleteMany([1, 42, 3]);

    expect([...deleted]).toEqual([1, 0, 1]);
    expect(removedCount).toBe(2);
    expect(t.size).toBe(1);
    expect(t.get(2)).toBe(2);
  });

  test("a batch longer than maxBatch is chunked and stays correct", async () => {
    using t = await table();
    const count = t.maxBatch + 1_000;
    const keys = sparseKeys(count);
    const values = new Uint32Array(count).map((_, i) => i);

    t.setMany(keys, values);

    expect(t.size).toBe(count);

    const { found, values: out } = t.getMany(keys);

    expect(found.every((flag) => flag === 1)).toBe(true);
    expect(out[count - 1]).toBe(count - 1);

    expect(t.deleteMany(keys).removedCount).toBe(count);
    expect(t.size).toBe(0);
  });

  test("a mismatched value length is rejected before anything is written", async () => {
    using t = await table();
    expect(() => t.setMany([1, 2, 3], [1, 2])).toThrow(RangeError);
    expect(t.size).toBe(0);
  });

  test("a bad element rejects a multi-chunk batch entirely", async () => {
    using t = await table();
    const count = t.maxBatch + 10;
    const keys: number[] = Array.from({ length: count }, (_, i) => i + 1);
    keys[count - 1] = -0.5;

    expect(() => t.setMany(keys, keys.map(() => 1))).toThrow(RangeError);
    expect(t.size).toBe(0);
  });

  test("an empty batch is a no-op", async () => {
    using t = await table();
    t.setMany([], []);
    expect(t.getMany([]).found.length).toBe(0);
    expect(t.deleteMany([]).removedCount).toBe(0);
  });

  test("bulk results agree with the single-key methods", async () => {
    using t = await table();
    const keys = sparseKeys(1_000);
    const values = keys.map((_, i) => (i * 3) >>> 0);

    t.setMany(keys, values);

    for (let i = 0; i < keys.length; i++) {
      expect(t.get(keys[i]!)).toBe(values[i]!);
    }
  });

  test("bulk calls on a disposed table throw before staging", async () => {
    const t = await table();
    t.dispose();

    expect(() => t.getMany([1])).toThrow();
    expect(() => t.setMany([1], [1])).toThrow();
    expect(() => t.deleteMany([1])).toThrow();
  });
});
