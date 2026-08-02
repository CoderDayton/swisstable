import { describe, expect, test } from "bun:test";

import { InternedSwissMap, StringInterner } from "../src/index.ts";
import type { NumericKeyTable } from "../src/index.ts";

/** In-memory stand-in for a WASM table, for binding-level tests. */
function mapTable<V>(): NumericKeyTable<V> {
  const backing = new Map<number, V>();
  return {
    get size() {
      return backing.size;
    },
    set: (key, value) => backing.set(key, value),
    get: (key) => backing.get(key),
    has: (key) => backing.has(key),
    delete: (key) => backing.delete(key),
  };
}

/** A table that rejects every write, standing in for a full WASM table. */
function rejectingTable<V>(): NumericKeyTable<V> {
  return {
    size: 0,
    set: () => {
      throw new RangeError("set exceeded the compiled capacity");
    },
    get: () => undefined,
    has: () => false,
    delete: () => false,
  };
}

describe("StringInterner", () => {
  test("forgetLast releases only the most recent ID", () => {
    const interner = new StringInterner();

    const first = interner.intern("a");
    const second = interner.intern("b");

    expect(interner.forgetLast(first)).toBe(false); // Not the last.
    expect(interner.size).toBe(2);

    expect(interner.forgetLast(second)).toBe(true);
    expect(interner.size).toBe(1);
    expect(interner.lookup("b")).toBeUndefined();
    expect(interner.resolve(second)).toBeUndefined();

    // The released ID is handed out again to the next new string.
    expect(interner.intern("c")).toBe(second);
    expect(interner.lookup("a")).toBe(first);
  });
});

describe("InternedSwissMap", () => {
  test("a rejected write does not leak an ID for a new key", () => {
    const interner = new StringInterner();
    const map = new InternedSwissMap<number>(rejectingTable(), interner);

    expect(() => map.set("never-stored", 1)).toThrow(RangeError);
    expect(interner.size).toBe(0);
    expect(interner.lookup("never-stored")).toBeUndefined();

    expect(() => map.setParts(["also", "never"], 1)).toThrow(RangeError);
    expect(interner.size).toBe(0);
  });

  test("a rejected write keeps an ID a previous write assigned", () => {
    const interner = new StringInterner();
    const backing = new Map<number, number>();
    let failing = false;

    const table: NumericKeyTable<number> = {
      get size() {
        return backing.size;
      },
      set: (key, value) => {
        if (failing) throw new RangeError("full");
        backing.set(key, value);
      },
      get: (key) => backing.get(key),
      has: (key) => backing.has(key),
      delete: (key) => backing.delete(key),
    };

    const map = new InternedSwissMap<number>(table, interner);

    map.set("kept", 1);
    const id = interner.lookup("kept");

    failing = true;
    expect(() => map.set("kept", 2)).toThrow(RangeError);

    // The key was already interned, so its ID must survive the failure.
    expect(interner.lookup("kept")).toBe(id);
    expect(interner.size).toBe(1);
  });
});

describe("StringInterner", () => {
  test("assigns IDs in first-seen order starting at 0", () => {
    const interner = new StringInterner();

    expect(interner.intern("a")).toBe(0);
    expect(interner.intern("b")).toBe(1);
    expect(interner.intern("a")).toBe(0);
    expect(interner.size).toBe(2);
  });

  test("resolves IDs back to strings and rejects out-of-range IDs", () => {
    const interner = new StringInterner();
    const id = interner.intern("token");

    expect(interner.resolve(id)).toBe("token");
    expect(interner.resolve(id + 1)).toBeUndefined();
    expect(interner.resolve(-1)).toBeUndefined();
  });

  test("lookup does not assign an ID", () => {
    const interner = new StringInterner();

    expect(interner.lookup("missing")).toBeUndefined();
    expect(interner.size).toBe(0);
  });

  test("internAll returns a Uint32Array of IDs", () => {
    const interner = new StringInterner();

    expect(interner.internAll(["x", "y", "x"])).toEqual(
      Uint32Array.from([0, 1, 0]),
    );
  });

  test("length-prefixed parts avoid concatenation collisions", () => {
    const interner = new StringInterner();

    const left = interner.internParts(["ab", "c"]);
    const right = interner.internParts(["a", "bc"]);

    expect(left).not.toBe(right);
    expect(interner.lookupParts(["ab", "c"])).toBe(left);
    expect(interner.lookupParts(["nope"])).toBeUndefined();
  });
});

describe("InternedSwissMap", () => {
  test("routes string keys through interned IDs", () => {
    const map = new InternedSwissMap<number>(mapTable<number>());

    map.set("alpha", 7);

    expect(map.get("alpha")).toBe(7);
    expect(map.has("alpha")).toBe(true);
    expect(map.delete("alpha")).toBe(true);
    expect(map.get("alpha")).toBeUndefined();
  });

  test("misses on never-interned keys without assigning IDs", () => {
    const map = new InternedSwissMap<number>(mapTable<number>());

    expect(map.get("ghost")).toBeUndefined();
    expect(map.has("ghost")).toBe(false);
    expect(map.delete("ghost")).toBe(false);
    expect(map.interner.size).toBe(0);
  });

  test("part-keyed accessors mirror the single-key ones", () => {
    const map = new InternedSwissMap<number>(mapTable<number>());

    map.setParts(["cache", "v1"], 3);

    expect(map.getParts(["cache", "v1"])).toBe(3);
    expect(map.getParts(["cachev", "1"])).toBeUndefined();
    expect(map.deleteParts(["cache", "v1"])).toBe(true);
  });

  test("preloadVocabulary interns the whole vocabulary up front", () => {
    const map = new InternedSwissMap<number>(mapTable<number>());

    expect(map.preloadVocabulary(["a", "b"])).toEqual(
      Uint32Array.from([0, 1]),
    );
    expect(map.interner.size).toBe(2);
  });
});
