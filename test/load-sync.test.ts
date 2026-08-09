import { describe, expect, test } from "bun:test";

import { SwissU32ToU32, SwissU32ToU64 } from "../src/index.ts";

const u32Module = await WebAssembly.compile(
  await Bun.file(new URL("../dist/wasm/swiss_u32.wasm", import.meta.url))
    .arrayBuffer(),
);
const u64Module = await WebAssembly.compile(
  await Bun.file(new URL("../dist/wasm/swiss_u64.wasm", import.meta.url))
    .arrayBuffer(),
);

describe("synchronous construction", () => {
  test("loadSync returns a usable table without awaiting", () => {
    using t = SwissU32ToU32.loadSync(u32Module, 100);

    t.set(1, 2);

    expect(t.get(1)).toBe(2);
    expect(t.capacity).toBeGreaterThanOrEqual(100);
  });

  test("loadSyncWithSeed reproduces the async layout for the same seed", async () => {
    const keys = Array.from({ length: 256 }, (_, i) => i * 7 + 1);

    using sync = SwissU32ToU32.loadSyncWithSeed(u32Module, 512, 0x1234_5678);
    using async = await SwissU32ToU32.loadWithSeed(
      u32Module,
      512,
      0x1234_5678,
    );

    for (const key of keys) {
      sync.set(key, key);
      async.set(key, key);
    }

    expect([...sync.keys()]).toEqual([...async.keys()]);
  });

  test("two loadSync tables are independent instances", () => {
    using a = SwissU32ToU32.loadSync(u32Module);
    using b = SwissU32ToU32.loadSync(u32Module);

    a.set(1, 10);

    expect(a.get(1)).toBe(10);
    expect(b.get(1)).toBeUndefined();
    expect(b.size).toBe(0);
  });

  test("unseeded sync tables disagree on layout", () => {
    const keys = Array.from({ length: 512 }, (_, i) => i * 7 + 1);

    const layout = (): number[] => {
      using t = SwissU32ToU32.loadSync(u32Module, 1_024);
      for (const key of keys) t.set(key, key);
      return [...t.keys()];
    };

    // Three independent pairs: a false failure needs every pair to collide.
    const differs = [1, 2, 3].some(
      () => layout().join() !== layout().join(),
    );

    expect(differs).toBe(true);
  });

  test("the bulk API works on a sync table", () => {
    using t = SwissU32ToU32.loadSync(u32Module, 16);

    t.setMany([1, 2, 3], [10, 20, 30]);

    expect([...t.getMany([1, 2, 3]).values]).toEqual([10, 20, 30]);
  });

  test("loadSync rejects a bad seed before instantiating", () => {
    expect(() => SwissU32ToU32.loadSyncWithSeed(u32Module, 0, -1)).toThrow(
      RangeError,
    );
    expect(() => SwissU32ToU32.loadSyncWithSeed(u32Module, 0, 1.5)).toThrow(
      RangeError,
    );
  });

  test("loadSync rejects a module that is not this one", () => {
    expect(() => SwissU32ToU32.loadSync(u64Module)).toThrow(TypeError);
  });

  test("expectedEntries past the ceiling throws", () => {
    expect(() => SwissU32ToU32.loadSync(u32Module, 2 ** 30)).toThrow(
      RangeError,
    );
  });

  test("the u64 table loads synchronously too", () => {
    using t = SwissU32ToU64.loadSync(u64Module, 100);

    t.set(1, 10, 20);

    expect(t.get(1)).toEqual({ lo: 10, hi: 20 });
  });
});
