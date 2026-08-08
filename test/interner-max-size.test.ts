import { describe, expect, test } from "bun:test";

import {
  InternedSwissMap,
  StringInterner,
  SwissU32ToU32,
} from "../src/index.ts";

/** Small enough that the cap is reached in a couple of lines. */
const CAP = 3;

describe("StringInterner maxSize", () => {
  test("is uncapped by default", () => {
    const interner = new StringInterner();
    expect(interner.maxSize).toBe(Number.POSITIVE_INFINITY);
  });

  test("rejects a new string past the cap", () => {
    const interner = new StringInterner({ maxSize: CAP });

    for (let i = 0; i < CAP; i += 1) interner.intern(`key-${i}`);
    expect(interner.size).toBe(CAP);

    expect(() => interner.intern("one-too-many")).toThrow(RangeError);
    expect(() => interner.intern("one-too-many")).toThrow(/maxSize of 3/);
  });

  test("leaves the indexes consistent when it refuses", () => {
    const interner = new StringInterner({ maxSize: CAP });
    for (let i = 0; i < CAP; i += 1) interner.intern(`key-${i}`);

    expect(() => interner.intern("rejected")).toThrow(RangeError);

    // The refusal happens before any mutation, so nothing was half-assigned.
    expect(interner.size).toBe(CAP);
    expect(interner.lookup("rejected")).toBeUndefined();
    for (let i = 0; i < CAP; i += 1) {
      expect(interner.resolve(interner.lookup(`key-${i}`)!)).toBe(`key-${i}`);
    }
  });

  test("never refuses a string it already interned", () => {
    const interner = new StringInterner({ maxSize: CAP });

    const ids: number[] = [];
    for (let i = 0; i < CAP; i += 1) ids.push(interner.intern(`key-${i}`));

    // At the cap, so this is the case a naive size check would reject.
    for (let i = 0; i < CAP; i += 1) {
      expect(interner.intern(`key-${i}`)).toBe(ids[i]!);
    }
    expect(interner.size).toBe(CAP);
  });

  test("recycling frees room under the cap", () => {
    const interner = new StringInterner({ maxSize: CAP, recycleIds: true });

    const first = interner.intern("a");
    interner.intern("b");
    interner.intern("c");
    expect(() => interner.intern("d")).toThrow(RangeError);

    expect(interner.release(first)).toBe(true);
    expect(interner.size).toBe(CAP - 1);

    // The released slot is available again, and takes the recycled ID.
    expect(interner.intern("d")).toBe(first);
    expect(interner.size).toBe(CAP);
  });

  test("rejects a cap that is not a positive integer", () => {
    for (const maxSize of [0, -1, 1.5, Number.NaN]) {
      expect(() => new StringInterner({ maxSize })).toThrow(RangeError);
      expect(() => new StringInterner({ maxSize })).toThrow(/positive integer/);
    }
  });

  test("accepts a cap of one", () => {
    const interner = new StringInterner({ maxSize: 1 });
    expect(interner.intern("only")).toBe(0);
    expect(() => interner.intern("second")).toThrow(RangeError);
  });
});

describe("InternedSwissMap under a capped interner", () => {
  test("refuses a new key past the cap and keeps the existing ones", async () => {
    const map = new InternedSwissMap(
      await SwissU32ToU32.create(64),
      new StringInterner({ maxSize: CAP }),
    );

    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);

    expect(() => map.set("d", 4)).toThrow(RangeError);

    expect(map.size).toBe(CAP);
    expect(map.get("a")).toBe(1);
    expect(map.get("c")).toBe(3);
    expect(map.get("d")).toBeUndefined();

    // Overwriting a key already present is not growth, so it still works.
    map.set("a", 10);
    expect(map.get("a")).toBe(10);
    expect(map.size).toBe(CAP);
  });
});
