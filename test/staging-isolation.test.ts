import { describe, expect, test } from "bun:test";

import { SwissU32ToU64 } from "../src/index.ts";
import { decodeBase64 } from "../src/embedded.ts";
import { SWISS_U32_WASM_BASE64 } from "../src/generated/swiss_u32.ts";
import { SWISS_U64_WASM_BASE64 } from "../src/generated/swiss_u64.ts";

/**
 * The raw module, driven directly.
 *
 * The bindings stage and issue a bulk call back to back, so they cannot
 * express the interleaving this guards against. Any other holder of the
 * instance can, which is why the separation is enforced in the module rather
 * than in the binding.
 */
async function rawExports() {
  const { instance } = await WebAssembly.instantiate(
    decodeBase64(SWISS_U64_WASM_BASE64),
  );
  return instance.exports as unknown as Record<string, CallableFunction> & {
    memory: WebAssembly.Memory;
  };
}

describe("scan and bulk staging buffers", () => {
  test("occupy disjoint ranges of linear memory", async () => {
    const wasm = await rawExports();

    const window = Number(wasm.scan_window!());
    const batch = Number(wasm.bulk_capacity!());

    const scan = [
      ["scan_keys", Number(wasm.scan_keys_ptr!()), window * 4],
      ["scan_vals_lo", Number(wasm.scan_values_lo_ptr!()), window * 4],
      ["scan_vals_hi", Number(wasm.scan_values_hi_ptr!()), window * 4],
    ] as const;

    const bulk = [
      ["bulk_keys", Number(wasm.bulk_keys_ptr!()), batch * 4],
      ["bulk_vals_lo", Number(wasm.bulk_values_lo_ptr!()), batch * 4],
      ["bulk_vals_hi", Number(wasm.bulk_values_hi_ptr!()), batch * 4],
      ["bulk_flags", Number(wasm.bulk_flags_ptr!()), batch],
    ] as const;

    for (const [scanName, scanStart, scanBytes] of scan) {
      for (const [bulkName, bulkStart, bulkBytes] of bulk) {
        const overlaps =
          scanStart < bulkStart + bulkBytes && bulkStart < scanStart + scanBytes;
        expect(`${scanName} vs ${bulkName}: ${overlaps}`).toBe(
          `${scanName} vs ${bulkName}: false`,
        );
      }
    }
  });

  test("occupy disjoint ranges in the u32 module too", async () => {
    const { instance } = await WebAssembly.instantiate(
      decodeBase64(SWISS_U32_WASM_BASE64),
    );
    const wasm = instance.exports as unknown as Record<
      string,
      CallableFunction
    >;

    const window = Number(wasm.scan_window!());
    const batch = Number(wasm.bulk_capacity!());

    const scan = [
      ["scan_keys", Number(wasm.scan_keys_ptr!()), window * 4],
      ["scan_values", Number(wasm.scan_values_ptr!()), window * 4],
    ] as const;

    const bulk = [
      ["bulk_keys", Number(wasm.bulk_keys_ptr!()), batch * 4],
      ["bulk_values", Number(wasm.bulk_values_ptr!()), batch * 4],
      ["bulk_flags", Number(wasm.bulk_flags_ptr!()), batch],
    ] as const;

    for (const [scanName, scanStart, scanBytes] of scan) {
      for (const [bulkName, bulkStart, bulkBytes] of bulk) {
        const overlaps =
          scanStart < bulkStart + bulkBytes && bulkStart < scanStart + scanBytes;
        expect(`${scanName} vs ${bulkName}: ${overlaps}`).toBe(
          `${scanName} vs ${bulkName}: false`,
        );
      }
    }
  });

  test("a walk does not disturb a batch staged before it", async () => {
    const wasm = await rawExports();
    wasm.init!(0);

    const batch = Number(wasm.bulk_capacity!());
    const keysPtr = Number(wasm.bulk_keys_ptr!());
    const loPtr = Number(wasm.bulk_values_lo_ptr!());
    const hiPtr = Number(wasm.bulk_values_hi_ptr!());

    const buffer = wasm.memory.buffer;
    const keys = new Uint32Array(buffer, keysPtr, batch);
    const lo = new Uint32Array(buffer, loPtr, batch);
    const hi = new Uint32Array(buffer, hiPtr, batch);

    // Something for the walk to find, so scan() has entries to stage.
    for (let i = 0; i < 500; i += 1) wasm.set!(i, i * 11, i * 13);

    // Stage a batch, then walk the table before issuing it: the ordering a
    // scan sharing the bulk buffers would corrupt without saying so.
    const COUNT = 8;
    for (let i = 0; i < COUNT; i += 1) {
      keys[i] = 90_000 + i;
      lo[i] = 7000 + i;
      hi[i] = 8000 + i;
    }

    expect(Number(wasm.scan!(0))).toBeGreaterThan(0);

    // The staged arguments must still be the ones written above.
    for (let i = 0; i < COUNT; i += 1) {
      expect([keys[i], lo[i], hi[i]]).toEqual([90_000 + i, 7000 + i, 8000 + i]);
    }

    expect(Number(wasm.set_many!(keysPtr, loPtr, hiPtr, COUNT))).toBe(0);

    // The module must have stored those, not the walk's entries.
    for (let i = 0; i < COUNT; i += 1) {
      expect(wasm.has_get!(90_000 + i)).toBe(1);
      const latched = new Uint32Array(buffer, Number(wasm.last_value_ptr!()), 2);
      expect([latched[0], latched[1]]).toEqual([7000 + i, 8000 + i]);
    }
  });

  test("the binding still walks and bulk-reads correctly", async () => {
    const table = await SwissU32ToU64.create(1000);
    for (let i = 0; i < 1000; i += 1) table.set(i, i * 3, i * 5);

    let walked = 0;
    for (const [key, { lo, hi }] of table) {
      expect([lo, hi]).toEqual([key * 3, key * 5]);
      walked += 1;
      if (walked % 100 === 0) {
        const got = table.getMany([1, 2, 3]);
        expect([...got.valsLo]).toEqual([3, 6, 9]);
      }
    }

    expect(walked).toBe(1000);
  });
});
