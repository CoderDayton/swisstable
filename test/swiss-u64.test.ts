import { describe, expect, test } from "bun:test";

import { SwissU32ToU64, lanesToSpan, spanToLanes } from "../src/index.ts";

const WASM_PATH = new URL("../dist/wasm/swiss_u64.wasm", import.meta.url);
const wasmFile = Bun.file(WASM_PATH);
const wasmBuilt = await wasmFile.exists();

describe("span lane conversion", () => {
  test("round-trips {offset,length} through lo/hi lanes", () => {
    const span = { offset: 128, length: 64 };

    expect(spanToLanes(span)).toEqual({ lo: 128, hi: 64 });
    expect(lanesToSpan(spanToLanes(span))).toEqual(span);
  });

  test("carries out-of-range fields through instead of masking them", () => {
    // Masking with `>>> 0` here would turn these into different, silently
    // valid u32s and defeat the validation `set` performs at the boundary.
    expect(spanToLanes({ offset: -1, length: 2.5 })).toEqual({
      lo: -1,
      hi: 2.5,
    });
  });
});

// Requires `bun run build`; skipped when the module has not been compiled.
describe.skipIf(!wasmBuilt)("SwissU32ToU64", () => {
  async function loadTable(expectedEntries = 1024): Promise<SwissU32ToU64> {
    return SwissU32ToU64.load(await wasmFile.arrayBuffer(), expectedEntries);
  }

  test("stores and retrieves u64 lanes", async () => {
    const table = await loadTable();

    table.set(7, 0xdeadbeef, 0x0000_0001);

    expect(table.has(7)).toBe(true);
    expect(table.get(7)).toEqual({ lo: 0xdeadbeef, hi: 1 });
    expect(table.size).toBe(1);
  });

  test("distinguishes a zero value from an absent key", async () => {
    const table = await loadTable();

    table.set(1, 0, 0);

    expect(table.get(1)).toEqual({ lo: 0, hi: 0 });
    expect(table.get(2)).toBeUndefined();
  });

  test("deletes keys and reports whether anything was removed", async () => {
    const table = await loadTable();

    table.set(3, 5, 0);

    expect(table.delete(3)).toBe(true);
    expect(table.delete(3)).toBe(false);
    expect(table.has(3)).toBe(false);
  });

  test("bulk round-trip preserves order and found flags", async () => {
    const table = await loadTable();
    const count = 1000;

    const keys = Uint32Array.from({ length: count }, (_, i) => i * 3 + 1);
    const valsLo = Uint32Array.from({ length: count }, (_, i) => i);
    const valsHi = Uint32Array.from({ length: count }, (_, i) => i * 2);

    table.setMany(keys, valsLo, valsHi);

    const probe = Uint32Array.from([...keys, 2]);
    const result = table.getMany(probe);

    expect(result.found.subarray(0, count)).toEqual(
      new Uint8Array(count).fill(1),
    );
    expect(result.found[count]).toBe(0);
    expect(result.valsLo.subarray(0, count)).toEqual(valsLo);
    expect(result.valsHi.subarray(0, count)).toEqual(valsHi);
  });

  test("getMany writes into caller-owned out arrays without allocating", async () => {
    const table = await loadTable();

    const keys = Uint32Array.from({ length: 16 }, (_, i) => i + 1);
    table.setMany(keys, keys, keys);

    // Oversized buffers are allowed; only the first keys.length elements
    // are written, so the sentinel past that must survive.
    const out = {
      valsLo: new Uint32Array(32).fill(0xdead),
      valsHi: new Uint32Array(32).fill(0xdead),
      found: new Uint8Array(32).fill(7),
    };

    const result = table.getMany(keys, out);

    expect(result).toBe(out);
    expect(out.valsLo.subarray(0, 16)).toEqual(keys);
    expect(out.valsHi.subarray(0, 16)).toEqual(keys);
    expect(out.found.subarray(0, 16)).toEqual(new Uint8Array(16).fill(1));
    expect(out.valsLo[16]).toBe(0xdead);
    expect(out.found[16]).toBe(7);
  });

  test("getMany rejects out arrays shorter than the batch", async () => {
    const table = await loadTable();

    const keys = Uint32Array.from({ length: 8 }, (_, i) => i + 1);
    const out = {
      valsLo: new Uint32Array(8),
      valsHi: new Uint32Array(8),
      found: new Uint8Array(4), // too short
    };

    expect(() => table.getMany(keys, out)).toThrow(RangeError);
  });

  test("chunks batches larger than the module's staging capacity", async () => {
    const table = await loadTable(1 << 17);
    const count = 100_000; // > bulk_capacity (65536), so this spans chunks

    const keys = Uint32Array.from({ length: count }, (_, i) => i * 2 + 1);
    const valsLo = Uint32Array.from({ length: count }, (_, i) => i);
    const valsHi = Uint32Array.from({ length: count }, (_, i) => i ^ 0xffff);

    table.setMany(keys, valsLo, valsHi);

    expect(table.size).toBe(count);

    const result = table.getMany(keys);

    expect(result.valsLo).toEqual(valsLo);
    expect(result.valsHi).toEqual(valsHi);
    expect(result.found).toEqual(new Uint8Array(count).fill(1));
  });

  test("bulk staging buffers sit outside the table banks", async () => {
    const table = await loadTable(1 << 16);

    // Filling the table must not disturb bytes staged for a bulk call.
    const keys = Uint32Array.from({ length: 4096 }, (_, i) => i + 1);
    table.setMany(keys, keys, keys);

    const sentinel = Uint32Array.from({ length: 8 }, (_, i) => 0xa5a5_0000 + i);
    const probe = table.getMany(sentinel);

    expect(probe.found).toEqual(new Uint8Array(8));
    expect(table.getMany(keys).valsLo).toEqual(keys);
  });

  test("setMany rejects mismatched array lengths", async () => {
    const table = await loadTable();

    expect(() =>
      table.setMany(
        Uint32Array.from([1, 2]),
        Uint32Array.from([1]),
        Uint32Array.from([1, 2]),
      ),
    ).toThrow(RangeError);
  });

  test("deleteMany reports per-key flags and a removal count", async () => {
    const table = await loadTable();

    table.setMany(
      Uint32Array.from([1, 2, 3]),
      Uint32Array.from([1, 2, 3]),
      new Uint32Array(3),
    );

    const { deleted, removedCount } = table.deleteMany(
      Uint32Array.from([1, 3, 99]),
    );

    expect(removedCount).toBe(2);
    expect(deleted).toEqual(Uint8Array.from([1, 1, 0]));
    expect(table.size).toBe(1);
  });

  test("rejects keys outside the u32 range", async () => {
    const table = await loadTable();

    expect(() => table.set(-1, 0, 0)).toThrow(RangeError);
    expect(() => table.set(1.5, 0, 0)).toThrow(RangeError);
  });

  test("rejects a span whose fields are not unsigned 32-bit integers", async () => {
    const table = await loadTable();

    expect(() => table.setSpan(1, { offset: -1, length: 4 })).toThrow(
      RangeError,
    );
    expect(() => table.setSpan(1, { offset: 0, length: 2.5 })).toThrow(
      RangeError,
    );
    expect(table.has(1)).toBe(false);
  });

  test("bulk-overwrites a batch already present on a table at its ceiling", async () => {
    const table = await loadTable(0);

    let inserted = 0;
    expect(() => {
      for (;; inserted++) table.set(inserted, inserted, 0);
    }).toThrow(RangeError);

    // Every key here is already present, so the batch needs no new slot —
    // set_many's pessimistic reserve must not turn that into a failure.
    const present = Uint32Array.from({ length: 64 }, (_, i) => i);
    expect(() => table.setMany(present, present, present)).not.toThrow();

    expect(table.size).toBe(inserted);
    expect(table.get(7)).toEqual({ lo: 7, hi: 7 });
  });

  test("clear empties the table without discarding capacity", async () => {
    const table = await loadTable();

    table.set(1, 1, 0);
    table.clear();

    expect(table.size).toBe(0);
    expect(table.capacity).toBeGreaterThan(0);
  });
});
