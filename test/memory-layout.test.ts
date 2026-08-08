import { describe, expect, test } from "bun:test";

import { decodeBase64 } from "../src/embedded.ts";
import { SWISS_U32_WASM_BASE64 } from "../src/generated/swiss_u32.ts";
import { SWISS_U64_WASM_BASE64 } from "../src/generated/swiss_u64.ts";

/**
 * Two properties the bindings rest on that no other test would notice
 * breaking, because both fail silently rather than wrongly.
 *
 * The stack sits below all data, so a stack overflow traps as an
 * out-of-bounds access instead of quietly overwriting the table banks. The
 * linker places it there, and `zig cc` passes --stack-first itself rather
 * than accepting it from the build script, so the layout is asserted here
 * instead of being read off a flag.
 *
 * Linear memory never grows, which is what makes a cached typed-array view
 * safe to hold: a growing memory detaches every view over it, and the
 * bindings build theirs once at construction.
 */

/** -Wl,-z,stack-size in scripts/build-wasm.ts. */
const STACK_SIZE = 65_536;

interface Layout {
  readonly name: string;
  readonly base64: string;
  /** Every export that reports the address of a static. */
  readonly pointers: readonly string[];
}

const LAYOUTS: Layout[] = [
  {
    name: "swiss_u32",
    base64: SWISS_U32_WASM_BASE64,
    pointers: [
      "size_ptr",
      "capacity_ptr",
      "last_value_ptr",
      "scan_keys_ptr",
      "scan_values_ptr",
    ],
  },
  {
    name: "swiss_u64",
    base64: SWISS_U64_WASM_BASE64,
    pointers: [
      "size_ptr",
      "capacity_ptr",
      "last_value_ptr",
      "scan_keys_ptr",
      "scan_vals_lo_ptr",
      "scan_vals_hi_ptr",
      "bulk_keys_ptr",
      "bulk_vals_lo_ptr",
      "bulk_vals_hi_ptr",
      "bulk_flags_ptr",
    ],
  },
];

async function instantiate(base64: string): Promise<Record<string, unknown>> {
  const { instance } = await WebAssembly.instantiate(decodeBase64(base64), {});
  return instance.exports as Record<string, unknown>;
}

describe.each(LAYOUTS)("$name memory layout", ({ base64, pointers }) => {
  test("places every static above the stack", async () => {
    const exports = await instantiate(base64);

    for (const name of pointers) {
      const address = (exports[name] as () => number)();
      expect(address).toBeGreaterThanOrEqual(STACK_SIZE);
    }
  });

  test("refuses to grow linear memory", async () => {
    const exports = await instantiate(base64);
    const memory = exports["memory"] as WebAssembly.Memory;
    const before = memory.buffer.byteLength;

    expect(() => memory.grow(1)).toThrow();
    expect(memory.buffer.byteLength).toBe(before);
    expect(memory.buffer.detached).toBe(false);
  });
});
