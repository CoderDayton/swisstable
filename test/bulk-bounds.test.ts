import { beforeEach, describe, expect, test } from "bun:test";

import { decodeBase64 } from "../src/embedded.ts";
import { SWISS_U64_WASM_BASE64 } from "../src/generated/swiss_u64.ts";

/**
 * Status returned when an export is called with arguments it cannot honour.
 * Distinct from STATUS_CAPACITY_EXCEEDED (-2), which describes a well-formed
 * request the table simply has no room for.
 */
const STATUS_INVALID_ARGUMENT = -3;

/**
 * `delete_many` reports a removal count, so it has no room for a negative
 * status. A count can never exceed BULK_CAPACITY, which makes the module's
 * UINT32_MAX an unambiguous failure sentinel.
 *
 * It arrives as -1 rather than 4294967295: a WebAssembly `i32` result is
 * signed at the JavaScript boundary whatever the C return type says. Every
 * genuine removal count is non-negative, so the sentinel is still distinct.
 */
const DELETE_MANY_FAILED = -1;

/**
 * Raw module exports.
 *
 * These tests deliberately bypass `SwissU32ToU64`. The binding chunks every
 * batch and only ever passes the module's own staging addresses, so it can
 * never produce these arguments — but the exports are reachable by anything
 * holding the instance, which is exactly why the bound has to live in the
 * module rather than in TypeScript.
 */
interface RawExports {
  memory: WebAssembly.Memory;
  init(expectedEntries: number): number;
  size(): number;
  set(key: number, lo: number, hi: number): number;
  set_many(k: number, lo: number, hi: number, count: number): number;
  get_many(k: number, lo: number, hi: number, f: number, count: number): number;
  delete_many(k: number, deleted: number, count: number): number;
  bulk_capacity(): number;
  bulk_keys_ptr(): number;
  bulk_vals_lo_ptr(): number;
  bulk_vals_hi_ptr(): number;
  bulk_flags_ptr(): number;
}

const module = await WebAssembly.compile(decodeBase64(SWISS_U64_WASM_BASE64));

describe("bulk exports validate their own arguments", () => {
  let wasm: RawExports;
  let maxBatch: number;
  let keysPtr: number;
  let loPtr: number;
  let hiPtr: number;
  let flagsPtr: number;

  beforeEach(async () => {
    const instance = await WebAssembly.instantiate(module);
    wasm = instance.exports as unknown as RawExports;

    wasm.init(1024);
    maxBatch = wasm.bulk_capacity() >>> 0;
    keysPtr = wasm.bulk_keys_ptr() >>> 0;
    loPtr = wasm.bulk_vals_lo_ptr() >>> 0;
    hiPtr = wasm.bulk_vals_hi_ptr() >>> 0;
    flagsPtr = wasm.bulk_flags_ptr() >>> 0;

    for (let key = 0; key < 500; key += 1) wasm.set(key, key, 0);
  });

  describe("count beyond the staging capacity", () => {
    test("set_many rejects it and applies nothing", () => {
      const before = wasm.size();

      expect(wasm.set_many(keysPtr, loPtr, hiPtr, maxBatch + 1)).toBe(
        STATUS_INVALID_ARGUMENT,
      );
      expect(wasm.size()).toBe(before);
    });

    test("get_many rejects it", () => {
      expect(wasm.get_many(keysPtr, loPtr, hiPtr, flagsPtr, maxBatch + 1)).toBe(
        STATUS_INVALID_ARGUMENT,
      );
    });

    test("delete_many rejects it and removes nothing", () => {
      const before = wasm.size();

      expect(wasm.delete_many(keysPtr, flagsPtr, maxBatch + 1)).toBe(
        DELETE_MANY_FAILED,
      );
      expect(wasm.size()).toBe(before);
    });

    test("a count of 2**32 - 1 does not wrap the reserve bound", () => {
      const before = wasm.size();

      expect(wasm.set_many(keysPtr, loPtr, hiPtr, 0xffff_ffff)).toBe(
        STATUS_INVALID_ARGUMENT,
      );
      expect(wasm.size()).toBe(before);
    });
  });

  describe("pointers the module does not own", () => {
    test("get_many refuses to write lanes outside the staging buffers", () => {
      // Address 0 is inside linear memory and writable, so nothing traps —
      // the write simply lands on whatever lives there.
      expect(wasm.get_many(keysPtr, 0, hiPtr, flagsPtr, 16)).toBe(
        STATUS_INVALID_ARGUMENT,
      );
    });

    test("get_many refuses a flags pointer aimed at the table itself", () => {
      expect(wasm.get_many(keysPtr, loPtr, hiPtr, keysPtr + 4, 16)).toBe(
        STATUS_INVALID_ARGUMENT,
      );
    });

    test("set_many refuses to read keys from outside the staging buffers", () => {
      const before = wasm.size();

      expect(wasm.set_many(flagsPtr, loPtr, hiPtr, 16)).toBe(
        STATUS_INVALID_ARGUMENT,
      );
      expect(wasm.size()).toBe(before);
    });

    test("delete_many refuses a foreign output pointer", () => {
      const before = wasm.size();

      expect(wasm.delete_many(keysPtr, 0, 16)).toBe(DELETE_MANY_FAILED);
      expect(wasm.size()).toBe(before);
    });
  });

  describe("well-formed calls are unaffected", () => {
    test("the full staging capacity is still accepted", () => {
      const keys = new Uint32Array(wasm.memory.buffer, keysPtr, maxBatch);
      const lo = new Uint32Array(wasm.memory.buffer, loPtr, maxBatch);
      const hi = new Uint32Array(wasm.memory.buffer, hiPtr, maxBatch);

      for (let i = 0; i < maxBatch; i += 1) {
        keys[i] = 10_000 + i;
        lo[i] = i;
        hi[i] = 0;
      }

      expect(wasm.set_many(keysPtr, loPtr, hiPtr, maxBatch)).toBe(0);
      expect(wasm.size()).toBe(500 + maxBatch);
    });

    test("a round trip through all three exports still works", () => {
      const keys = new Uint32Array(wasm.memory.buffer, keysPtr, maxBatch);
      const lo = new Uint32Array(wasm.memory.buffer, loPtr, maxBatch);
      const flags = new Uint8Array(wasm.memory.buffer, flagsPtr, maxBatch);

      keys.set([1, 2, 3, 999_999]);

      expect(wasm.get_many(keysPtr, loPtr, hiPtr, flagsPtr, 4)).toBe(0);
      expect(Array.from(flags.subarray(0, 4))).toEqual([1, 1, 1, 0]);
      expect(Array.from(lo.subarray(0, 3))).toEqual([1, 2, 3]);

      keys.set([1, 2, 3, 999_999]);
      expect(wasm.delete_many(keysPtr, flagsPtr, 4)).toBe(3);
      expect(wasm.size()).toBe(497);
    });

    test("a count of zero is accepted", () => {
      expect(wasm.set_many(keysPtr, loPtr, hiPtr, 0)).toBe(0);
      expect(wasm.get_many(keysPtr, loPtr, hiPtr, flagsPtr, 0)).toBe(0);
      expect(wasm.delete_many(keysPtr, flagsPtr, 0)).toBe(0);
    });
  });
});
