import { describe, expect, test } from "bun:test";

import { supportsSimd } from "../src/embedded.ts";
import { SwissU32ToU32, SwissU32ToU64 } from "../src/index.ts";

// The probe is what decides whether a compile failure is reported as a
// missing runtime feature or passed through as it arrived. A probe that
// disagreed with the modules would relabel every genuine failure -- a
// truncated payload, a bad build -- as "this runtime lacks SIMD".
describe("SIMD detection", () => {
  test("agrees with the modules on a runtime that can compile them", async () => {
    await SwissU32ToU32.create(16);

    expect(supportsSimd()).toBe(true);
  });
});

// Unlike the load()-based suites, these need no compiled .wasm on disk:
// the module bytes are generated into src/generated and committed.
describe("create()", () => {
  test("builds a working u32 table with no module bytes", async () => {
    const table = await SwissU32ToU32.create(1024);

    table.set(0xdead_beef, 42);

    expect(table.get(0xdead_beef)).toBe(42);
    expect(table.size).toBe(1);
  });

  test("builds a working u64 table with no module bytes", async () => {
    const table = await SwissU32ToU64.create(1024);

    table.setSpan(7, { offset: 128, length: 64 });

    expect(table.getSpan(7)).toEqual({ offset: 128, length: 64 });
  });

  test("sizes the table for the expected entries", async () => {
    const sized = await SwissU32ToU32.create(2000);
    const empty = await SwissU32ToU32.create();

    expect(sized.capacity).toBe(4096);
    expect(empty.capacity).toBe(64);
  });

  test("rejects an expected count beyond the compiled capacity", async () => {
    await expect(SwissU32ToU32.create(200_000_000)).rejects.toThrow(RangeError);
  });

  // The compiled module is shared, so a caller must not be able to observe
  // another table's entries through it.
  test("gives each table its own memory", async () => {
    const first = await SwissU32ToU32.create(64);
    const second = await SwissU32ToU32.create(64);

    first.set(1, 111);
    second.set(2, 222);

    expect(first.get(2)).toBeUndefined();
    expect(second.get(1)).toBeUndefined();
    expect(first.size).toBe(1);
    expect(second.size).toBe(1);
  });

  test("matches a table loaded from bytes", async () => {
    const created = await SwissU32ToU32.create(1024);
    const bytes = await Bun.file(
      new URL("../dist/wasm/swiss_u32.wasm", import.meta.url),
    ).arrayBuffer();
    const loaded = await SwissU32ToU32.load(bytes, 1024);

    for (const key of [1, 1000, 0xffff_ffff]) {
      created.set(key, key);
      loaded.set(key, key);
    }

    expect(created.capacity).toBe(loaded.capacity);
    expect(created.size).toBe(loaded.size);
    expect(created.get(0xffff_ffff)).toBe(loaded.get(0xffff_ffff));
  });
});
