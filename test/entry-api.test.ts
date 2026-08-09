import { describe, expect, test } from "bun:test";

import { SwissU32ToU32, SwissU32ToU64 } from "../src/index.ts";

/** Fixed so a failure reproduces; these tests never see untrusted input. */
const SEED = 0x0b17_c0de;

describe("getOrInsert / increment (u32)", () => {
  test("getOrInsert inserts an absent key and returns what it stored", async () => {
    using t = await SwissU32ToU32.createWithSeed(0, SEED);

    expect(t.getOrInsert(1, 42)).toBe(42);
    expect(t.size).toBe(1);
    expect(t.get(1)).toBe(42);
  });

  test("getOrInsert leaves a present key alone", async () => {
    using t = await SwissU32ToU32.createWithSeed(0, SEED);
    t.set(1, 7);

    expect(t.getOrInsert(1, 42)).toBe(7);
    expect(t.get(1)).toBe(7);
    expect(t.size).toBe(1);
  });

  test("a stored 0 is returned rather than treated as absent", async () => {
    using t = await SwissU32ToU32.createWithSeed(0, SEED);
    t.set(1, 0);

    expect(t.getOrInsert(1, 99)).toBe(0);
    expect(t.size).toBe(1);
  });

  test("increment counts from zero on first sight", async () => {
    using t = await SwissU32ToU32.createWithSeed(0, SEED);

    expect(t.increment(5)).toBe(1);
    expect(t.increment(5)).toBe(2);
    expect(t.increment(5, 10)).toBe(12);
    expect(t.get(5)).toBe(12);
    expect(t.size).toBe(1);
  });

  test("increment wraps modulo 2^32", async () => {
    using t = await SwissU32ToU32.createWithSeed(0, SEED);
    t.set(1, 0xffff_ffff);

    expect(t.increment(1)).toBe(0);
  });

  test("a counter sweep agrees with a Map doing the same work", async () => {
    using t = await SwissU32ToU32.createWithSeed(0, SEED);
    const expected = new Map<number, number>();

    for (let i = 0; i < 20_000; i++) {
      const key = (i * 2_654_435_761) % 997;
      t.increment(key);
      expected.set(key, (expected.get(key) ?? 0) + 1);
    }

    expect(t.size).toBe(expected.size);
    for (const [key, count] of expected) expect(t.get(key)).toBe(count);
  });

  test("both reject arguments outside u32", async () => {
    using t = await SwissU32ToU32.createWithSeed(0, SEED);

    expect(() => t.getOrInsert(-1, 0)).toThrow(RangeError);
    expect(() => t.getOrInsert(0, 2 ** 32)).toThrow(RangeError);
    expect(() => t.increment(1.5)).toThrow(RangeError);
    expect(() => t.increment(1, -2)).toThrow(RangeError);
  });

  test("growth during getOrInsert keeps every earlier entry", async () => {
    using t = await SwissU32ToU32.createWithSeed(0, SEED);

    for (let i = 1; i <= 5_000; i++) expect(t.getOrInsert(i, i)).toBe(i);

    expect(t.size).toBe(5_000);
    for (let i = 1; i <= 5_000; i++) expect(t.get(i)).toBe(i);
  });
});

describe("getOrInsert / increment (u64)", () => {
  test("getOrInsert inserts both lanes, then leaves them alone", async () => {
    using t = await SwissU32ToU64.createWithSeed(0, SEED);

    expect(t.getOrInsert(1, 10, 20)).toEqual({ lo: 10, hi: 20 });
    expect(t.getOrInsert(1, 99, 99)).toEqual({ lo: 10, hi: 20 });
    expect(t.size).toBe(1);
  });

  test("increment carries from the low lane into the high one", async () => {
    using t = await SwissU32ToU64.createWithSeed(0, SEED);
    t.set(1, 0xffff_ffff, 0);

    expect(t.increment(1)).toEqual({ lo: 0, hi: 1 });
  });

  test("increment adds a full 64-bit delta", async () => {
    using t = await SwissU32ToU64.createWithSeed(0, SEED);

    expect(t.increment(1, 5, 3)).toEqual({ lo: 5, hi: 3 });
    expect(t.increment(1, 5, 3)).toEqual({ lo: 10, hi: 6 });
  });

  test("increment wraps modulo 2^64", async () => {
    using t = await SwissU32ToU64.createWithSeed(0, SEED);
    t.set(1, 0xffff_ffff, 0xffff_ffff);

    expect(t.increment(1)).toEqual({ lo: 0, hi: 0 });
  });
});
