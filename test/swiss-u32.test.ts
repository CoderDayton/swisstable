import { describe, expect, test } from "bun:test";

import { SwissU32ToU32 } from "../src/index.ts";

const WASM_PATH = new URL("../dist/wasm/swiss_u32.wasm", import.meta.url);
const wasmFile = Bun.file(WASM_PATH);
const wasmBuilt = await wasmFile.exists();

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

  test("overwrites an existing key on a table at its compiled ceiling", async () => {
    const table = await loadTable(0);

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

  // A ceiling is reported against what the caller wrote, so the message can
  // never name a WASM export the public API does not mention.
  test("a capacity ceiling names the caller's own argument", async () => {
    await expect(SwissU32ToU32.create(2_000_000)).rejects.toThrow(
      "expectedEntries exceeded the compiled SwissU32ToU32 capacity",
    );

    const table = await loadTable(0);
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
