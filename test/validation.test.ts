import { describe, expect, test } from "bun:test";

import {
  InternedSwissMap,
  StringInterner,
  SwissU32ToU32,
  SwissU32ToU64,
  spanToLanes,
} from "../src/index.ts";

describe("bulk argument types", () => {
  // TypeScript rejects these statically -- hence the casts. The guards exist
  // for JavaScript callers and for `any` paths, where every typed array has
  // subarray and length, so the wrong element type would otherwise be copied
  // into the staging buffer and reinterpreted: wrong answers, not an error.
  test("rejects a typed array of the wrong element type", async () => {
    const table = await SwissU32ToU64.create(100);
    table.set(1, 111, 0);

    expect(() => table.getMany(new Int32Array([1]) as never)).toThrow(TypeError);
    expect(() => table.getMany(new Float64Array([1]) as never)).toThrow(TypeError);
    expect(() => table.deleteMany(new Int32Array([1]) as never)).toThrow(TypeError);
    expect(() =>
      table.setMany(
        new Int32Array([1]) as never,
        new Uint32Array([1]),
        new Uint32Array([1]),
      ),
    ).toThrow(TypeError);
  });

  test("rejects plain arrays and nullish arguments by name", async () => {
    const table = await SwissU32ToU64.create(100);

    expect(() => table.getMany([1, 2] as never)).toThrow("keys must be a Uint32Array");
    expect(() => table.getMany(undefined as never)).toThrow(TypeError);
    expect(() => table.deleteMany(null as never)).toThrow(TypeError);
    expect(() =>
      table.setMany(new Uint32Array(1), [1] as never, new Uint32Array(1)),
    ).toThrow("valsLo must be a Uint32Array");
  });

  test("still accepts a subarray view", async () => {
    const table = await SwissU32ToU64.create(100);
    const keys = new Uint32Array([1, 2, 3, 4]);

    table.setMany(
      keys.subarray(0, 2),
      new Uint32Array([10, 20]),
      new Uint32Array([0, 0]),
    );

    expect(table.size).toBe(2);
    expect(table.getMany(keys.subarray(0, 2)).valsLo[1]).toBe(20);
  });
});

describe("span shape", () => {
  test("reports the field the caller wrote", async () => {
    const table = await SwissU32ToU64.create(100);

    expect(() => table.setSpan(1, null as never)).toThrow(TypeError);
    expect(() => table.setSpan(1, {} as never)).toThrow("span.offset");
    expect(() => table.setSpan(1, { offset: 1 } as never)).toThrow("span.length");
    expect(() => table.setSpan(1, { offset: -1, length: 0 })).toThrow("span.offset");
  });

  // spanToLanes is a pure conversion; validation belongs at the boundary so
  // set() sees the value the caller actually wrote.
  test("spanToLanes still carries invalid fields through unmasked", () => {
    expect(spanToLanes({ offset: -1, length: 1.5 })).toEqual({ lo: -1, hi: 1.5 });
  });
});

describe("interner key types", () => {
  test("rejects non-string keys", () => {
    const interner = new StringInterner();

    expect(() => interner.intern(42 as never)).toThrow("text must be a string");
    expect(() => interner.intern(null as never)).toThrow(TypeError);
    expect(() => interner.intern(undefined as never)).toThrow(TypeError);
    expect(() => interner.lookup({} as never)).toThrow(TypeError);
    expect(() => interner.internAll([1, 2] as never)).toThrow(TypeError);
  });

  test("rejects non-string parts", () => {
    const interner = new StringInterner();

    expect(() => interner.internParts([1] as never)).toThrow("part must be a string");
    expect(() => interner.lookupParts(["a", 2] as never)).toThrow(TypeError);
  });

  // resolve() must never hand back something that is not a string.
  test("resolve only ever returns a string or undefined", () => {
    const interner = new StringInterner();
    interner.intern("real");

    expect(interner.resolve(0)).toBe("real");
    expect(interner.resolve(1)).toBeUndefined();
    expect(interner.resolve(-1)).toBeUndefined();
  });
});

describe("InternedSwissMap construction", () => {
  test("rejects a table that cannot satisfy the contract", async () => {
    expect(() => new InternedSwissMap(null as never)).toThrow(TypeError);
    expect(() => new InternedSwissMap({} as never)).toThrow("set is missing");
    expect(
      () => new InternedSwissMap({ set() {}, get() {}, has() {} } as never),
    ).toThrow("delete is missing");
  });

  test("rejects an interner of the wrong type", async () => {
    const table = await SwissU32ToU32.create(100);
    expect(() => new InternedSwissMap(table, {} as never)).toThrow(TypeError);
  });

  test("accepts a valid table", async () => {
    const table = await SwissU32ToU32.create(100);
    expect(() => new InternedSwissMap(table)).not.toThrow();
  });
});
