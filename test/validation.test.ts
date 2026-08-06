import { describe, expect, test } from "bun:test";

import {
  InternedSwissMap,
  StringInterner,
  SwissU32ToU32,
  SwissU32ToU64,
  spanToLanes,
} from "../src/index.ts";
import { materializeU32, stageU32 } from "../src/abi.ts";

// The staging helpers are reached through the bulk methods, which derive the
// element count from the source itself. These call them directly, so the
// range they are asked for is a precondition of the helper rather than of
// the caller that happens to compute it.
describe("staging range", () => {
  test("a source shorter than the requested range is rejected", () => {
    const dest = new Uint32Array(4).fill(0xdead);

    // An integer view stages with one bulk copy and inspects no element, so
    // without the check the missing tail would keep the previous batch's
    // bytes and reach WASM as keys.
    expect(() => stageU32(new Uint32Array([1, 2]), dest, 0, 4, "keys")).toThrow(
      RangeError,
    );
    expect(dest[2]).toBe(0xdead);

    expect(() => stageU32(new Uint32Array([1, 2, 3]), dest, 2, 2, "keys")).toThrow(
      "keys has 3 elements, but 4 were requested",
    );

    // The same range applies to sources that are converted element by
    // element, including the BigInt path, whose native conversion error
    // would otherwise name neither the parameter nor the length.
    expect(() => stageU32([1, 2], dest, 0, 4, "keys")).toThrow(RangeError);
    expect(() => stageU32(new BigInt64Array([1n]), dest, 0, 2, "keys")).toThrow(
      "keys has 1 elements, but 2 were requested",
    );
  });

  test("materializeU32 rejects a short integer view it would hand back", () => {
    expect(() => materializeU32(new Uint32Array([1, 2]), 4, "keys")).toThrow(
      "keys has 2 elements, but 4 were requested",
    );

    const source = new Uint32Array([1, 2, 3]);
    expect(materializeU32(source, 3, "keys")).toBe(source);
  });
});

describe("bulk argument types", () => {
  // Every accepted source has to agree on what a key means, whatever its
  // element type: the value is taken as a 32-bit integer, and a negative one
  // is its unsigned bit pattern.
  test("every numeric source addresses the same keys", async () => {
    const table = await SwissU32ToU64.create(100);
    const zeros = new Uint32Array(3);

    table.setMany(new Uint32Array([1, 2, 3]), new Uint32Array([10, 20, 30]), zeros);

    const expected = [10, 20, 30];
    const sources = [
      new Uint32Array([1, 2, 3]),
      new Int32Array([1, 2, 3]),
      new Uint16Array([1, 2, 3]),
      new Int16Array([1, 2, 3]),
      new Uint8Array([1, 2, 3]),
      new Uint8ClampedArray([1, 2, 3]),
      new Int8Array([1, 2, 3]),
      new Float64Array([1, 2, 3]),
      new Float32Array([1, 2, 3]),
      new BigUint64Array([1n, 2n, 3n]),
      new BigInt64Array([1n, 2n, 3n]),
      [1, 2, 3],
      [1n, 2n, 3n],
    ] as const;

    for (const source of sources) {
      const got = table.getMany(source);
      expect(Array.from(got.valsLo)).toEqual(expected);
      expect(Array.from(got.found)).toEqual([1, 1, 1]);
    }
  });

  // -1 as int32 is the same 32 bits as 4294967295 as uint32.
  test("negative values are their unsigned bit pattern", async () => {
    const table = await SwissU32ToU64.create(100);

    table.setMany(new Int32Array([-1, -2147483648]), new Uint32Array([7, 8]), new Uint32Array(2));

    expect(table.get(0xffff_ffff)).toEqual({ lo: 7, hi: 0 });
    expect(table.get(0x8000_0000)).toEqual({ lo: 8, hi: 0 });

    expect(Array.from(table.getMany([-1, -2147483648]).valsLo)).toEqual([7, 8]);
    expect(table.deleteMany(new Float64Array([-1])).removedCount).toBe(1);
  });

  // The lossy conversions a bulk `set` would have performed silently.
  test("rejects elements that are not 32-bit integers", async () => {
    const table = await SwissU32ToU64.create(100);

    expect(() => table.getMany(new Float64Array([1.5]))).toThrow("keys[0]");
    expect(() => table.getMany(new Float64Array([2 ** 32]))).toThrow(RangeError);
    expect(() => table.getMany(new Float64Array([-(2 ** 31) - 1]))).toThrow(RangeError);
    expect(() => table.getMany([1, 2.5])).toThrow("keys[1]");
    expect(() => table.getMany([1, Number.NaN])).toThrow(RangeError);
    expect(() => table.getMany(new BigInt64Array([2n ** 32n]))).toThrow(RangeError);
    expect(() => table.getMany([1, "2"] as never)).toThrow("keys[1] must be a number");
  });

  // A float32 has 24 mantissa bits, so the element the table would have seen
  // is not the one the caller wrote — and the rounded stand-in is itself a
  // valid key, which is what makes accepting it dangerous.
  test("rejects Float32Array elements past its exact integer range", async () => {
    const table = await SwissU32ToU64.create(100);

    expect(new Float32Array([2 ** 24 + 2])[0]).toBe(2 ** 24 + 2);

    expect(() => table.getMany(new Float32Array([2 ** 24 + 2]))).toThrow(RangeError);
    expect(() => table.getMany(new Float32Array([2 ** 32 - 1]))).toThrow("keys[0]");
    expect(() => table.getMany(new Float32Array([-(2 ** 24) - 2]))).toThrow(RangeError);

    // The exactly representable range still works, negatives included.
    expect(() => table.getMany(new Float32Array([2 ** 24, -1, 0]))).not.toThrow();

    // 2**24 + 1 is the one value the check cannot catch: it rounds *into* the
    // exact range, arriving indistinguishable from a genuine 2**24.
    expect(new Float32Array([2 ** 24 + 1])[0]).toBe(2 ** 24);
  });

  // The whole batch is checked before the first chunk is written, so where
  // the bad element sits does not change what the table ends up holding.
  test("a rejected element past maxBatch applies nothing", async () => {
    const table = await SwissU32ToU64.create(100);
    const total = table.maxBatch + 1;

    const keys: number[] = Array.from({ length: total }, (_, i) => i);
    keys[total - 1] = 1.5;

    expect(() =>
      table.setMany(keys, new Uint32Array(total), new Uint32Array(total)),
    ).toThrow(`keys[${total - 1}]`);
    expect(table.size).toBe(0);

    table.setMany(new Uint32Array([1]), new Uint32Array([7]), new Uint32Array(1));

    expect(() => table.deleteMany(keys)).toThrow(RangeError);
    expect(table.size).toBe(1);
  });

  // getMany writes its results chunk by chunk, and the documented steady
  // state hands the previous result back as `out`. A late rejection that
  // left the early chunks written would hand back a silent mixture of this
  // batch and the last one.
  test("a rejected element past maxBatch writes nothing", async () => {
    const table = await SwissU32ToU64.create(100);
    const total = table.maxBatch + 1;

    table.setMany([0], [111], [222]);

    const out = table.getMany(new Uint32Array(total));
    expect(out.valsLo[0]).toBe(111);

    // A key that is absent, so a chunk allowed to land would zero the lanes
    // and clear the flag — visibly different from what `out` already holds.
    const keys: number[] = Array.from({ length: total }, () => 7);
    keys[total - 1] = 1.5;

    expect(() => table.getMany(keys, out)).toThrow(`keys[${total - 1}]`);

    // Untouched, not overwritten by the chunks that would have run first.
    expect(out.valsLo[0]).toBe(111);
    expect(out.valsHi[0]).toBe(222);
    expect(out.found[0]).toBe(1);
  });

  test("rejects unsupported sequences by name", async () => {
    const table = await SwissU32ToU64.create(100);

    expect(() => table.getMany(undefined as never)).toThrow(TypeError);
    expect(() => table.deleteMany(null as never)).toThrow(TypeError);
    expect(() => table.getMany({ length: 2 } as never)).toThrow(
      "keys must be an array or typed array of numbers",
    );
    expect(() =>
      table.setMany(new Uint32Array(1), "ab" as never, new Uint32Array(1)),
    ).toThrow("valsLo must be an array or typed array of numbers");
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
