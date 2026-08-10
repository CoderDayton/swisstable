import { describe, expect, test } from "bun:test";

import { SwissU32ToU32 } from "../src/index.ts";

const WASM_PATH = new URL("../dist/wasm/swiss_u32.wasm", import.meta.url);
const wasmFile = Bun.file(WASM_PATH);
const wasmBuilt = await wasmFile.exists();

/**
 * The same module built at 2^16 slots, so its ceiling is 57,344 entries
 * rather than the shipped 117,440,512 and a test can actually reach it.
 * See CAPPED_U32 in scripts/build-wasm.ts.
 */
const cappedFile = Bun.file(
  new URL("../dist/wasm/swiss_u32_capped.wasm", import.meta.url),
);
const cappedBuilt = await cappedFile.exists();

// Requires `bun run build`; skipped when the module has not been compiled.
describe.skipIf(!wasmBuilt)("SwissU32ToU32", () => {
  async function loadTable(expectedEntries = 1024): Promise<SwissU32ToU32> {
    return SwissU32ToU32.load(await wasmFile.arrayBuffer(), expectedEntries);
  }

  test("stores, overwrites, and retrieves values", async () => {
    const table = await loadTable();

    table.set(7, 99).set(7, 100);

    expect(table.get(7)).toBe(100);
    expect(table.has(7)).toBe(true);
    expect(table.size).toBe(1);
  });

  test("distinguishes a zero value from an absent key", async () => {
    const table = await loadTable();

    table.set(1, 0);

    expect(table.get(1)).toBe(0);
    expect(table.get(2)).toBeUndefined();
    expect(table.has(2)).toBe(false);
  });

  test("deletes keys and reports whether anything was removed", async () => {
    const table = await loadTable();

    table.set(3, 5);

    expect(table.delete(3)).toBe(true);
    expect(table.delete(3)).toBe(false);
    expect(table.get(3)).toBeUndefined();
    expect(table.size).toBe(0);
  });

  test("survives rehashing past the initial capacity", async () => {
    const table = await loadTable(16);
    const count = 50_000;

    for (let i = 0; i < count; i++) table.set(i * 7 + 1, i);

    expect(table.size).toBe(count);
    expect(table.capacity).toBeGreaterThanOrEqual(count);

    for (let i = 0; i < count; i += 997) {
      expect(table.get(i * 7 + 1)).toBe(i);
    }
    expect(table.get(2)).toBeUndefined();
  });

  test("reuses tombstoned slots without losing live entries", async () => {
    const table = await loadTable();

    for (let i = 0; i < 512; i++) table.set(i, i);
    for (let i = 0; i < 512; i += 2) table.delete(i);
    for (let i = 0; i < 512; i += 2) table.set(i, i * 10);

    expect(table.size).toBe(512);
    expect(table.get(4)).toBe(40);
    expect(table.get(5)).toBe(5);
  });

  test("round-trips keys and values above 2^31", async () => {
    const table = await loadTable();

    // These cross the boundary as negative int32 values; the C side reads
    // the same bits back as uint32_t.
    const keys = [0x8000_0000, 0xffff_ffff, 0xdead_beef];

    for (const [index, key] of keys.entries()) {
      table.set(key, 0xffff_ff00 + index);
    }

    for (const [index, key] of keys.entries()) {
      expect(table.get(key)).toBe(0xffff_ff00 + index);
      expect(table.has(key)).toBe(true);
    }

    // A high key must not collide with its signed reinterpretation.
    expect(table.get(0)).toBeUndefined();
    expect(table.size).toBe(keys.length);
  });

  test("clear empties the table without discarding capacity", async () => {
    const table = await loadTable();

    table.set(1, 1);
    table.clear();

    expect(table.size).toBe(0);
    expect(table.get(1)).toBeUndefined();
    expect(table.capacity).toBeGreaterThan(0);
  });

  test.skipIf(!cappedBuilt)("overwrites an existing key on a table at its compiled ceiling", async () => {
    const table = await SwissU32ToU32.load(await cappedFile.arrayBuffer(), 0);

    // Fill until the compiled capacity is genuinely exhausted.
    let inserted = 0;
    expect(() => {
      for (;; inserted++) table.set(inserted, inserted);
    }).toThrow(RangeError);

    // An overwrite consumes no slot, so it must still succeed here: the
    // growth decision has to follow the existence check, not precede it.
    expect(() => table.set(5, 12345)).not.toThrow();
    expect(table.get(5)).toBe(12345);
    expect(table.size).toBe(inserted);

    // The ceiling still applies to a genuine insert.
    expect(() => table.set(inserted + 1, 1)).toThrow(RangeError);
  });

  // A bulk chunk can grow linear memory several times before it runs out of
  // slots, and a grow detaches every view the binding caches. The refusal
  // has to leave those rebuilt, or the table reads back as empty afterwards.
  test.skipIf(!cappedBuilt)("stays readable after a bulk call hits the ceiling", async () => {
    const table = await SwissU32ToU32.load(await cappedFile.arrayBuffer(), 0);

    const count = table.maxBatch;
    const keys = new Uint32Array(count);
    const values = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      keys[i] = i;
      values[i] = i * 3;
    }

    expect(() => table.setMany(keys, values)).toThrow(RangeError);

    expect(table.size).toBeGreaterThan(0);
    expect(table.capacity).toBeGreaterThan(0);
    expect(table.get(5)).toBe(15);

    const probe = table.getMany(new Uint32Array([1, 2, 3]));
    expect(Array.from(probe.values)).toEqual([3, 6, 9]);
    expect(Array.from(probe.found)).toEqual([1, 1, 1]);
  });

  // A ceiling is reported against what the caller wrote, so the message can
  // never name a WASM export the public API does not mention.
  test.skipIf(!cappedBuilt)("a capacity ceiling names the caller's own argument", async () => {
    await expect(SwissU32ToU32.create(200_000_000)).rejects.toThrow(
      "expectedEntries exceeded the compiled SwissU32ToU32 capacity",
    );

    const table = await SwissU32ToU32.load(await cappedFile.arrayBuffer(), 0);
    expect(() => {
      for (let key = 0; ; key++) table.set(key, key);
    }).toThrow("set exceeded the compiled SwissU32ToU32 capacity");
  });

  test("rejects keys and values outside the u32 range", async () => {
    const table = await loadTable();

    expect(() => table.set(-1, 0)).toThrow(RangeError);
    expect(() => table.set(0, 2 ** 32)).toThrow(RangeError);
    expect(() => table.get(1.5)).toThrow(RangeError);
  });
});
