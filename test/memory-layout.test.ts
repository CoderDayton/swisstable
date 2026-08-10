import { describe, expect, test } from "bun:test";

import { SwissU32ToU32 } from "../src/index.ts";
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

const MIB = 1024 * 1024;

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
      "scan_values_lo_ptr",
      "scan_values_hi_ptr",
      "bulk_keys_ptr",
      "bulk_values_lo_ptr",
      "bulk_values_hi_ptr",
      "bulk_flags_ptr",
    ],
  },
];

async function instantiate(base64: string): Promise<Record<string, unknown>> {
  const { instance } = await WebAssembly.instantiate(decodeBase64(base64), {});
  return instance.exports as Record<string, unknown>;
}

/**
 * The u32 module with a ceiling it cannot afford — 2^20 slots against 8 MiB
 * of linear memory. See STARVED_U32 in scripts/build-wasm.ts.
 *
 * A rehash that cannot reach its new bank has to report the refusal before
 * it touches anything, so the table it was called on is left exactly as it
 * was rather than half rebuilt.
 */
const starvedFile = Bun.file(
  new URL("../dist/wasm/swiss_u32_starved.wasm", import.meta.url),
);

// Requires `bun run build`; skipped when the module has not been compiled.
describe.skipIf(!(await starvedFile.exists()))("a host that refuses a grow", () => {
  test("reports it without disturbing the table", async () => {
    const table = await SwissU32ToU32.load(await starvedFile.arrayBuffer(), 0);

    let inserted = 0;
    expect(() => {
      for (;; inserted += 1) table.set(inserted, inserted * 3);
    }).toThrow(RangeError);

    // The memory ran out well before the slots did, which is what makes
    // this a different path from the capacity ceiling.
    expect(table.capacity).toBeLessThan(1 << 20);
    expect(table.size).toBe(inserted);

    let wrong = 0;
    for (let i = 0; i < inserted; i += 1) {
      if (table.get(i) !== i * 3) wrong += 1;
    }
    expect(wrong).toBe(0);

    // An overwrite consumes no slot, so it needs no growth and must still
    // succeed on a table that can no longer grow.
    table.set(5, 12_345);
    expect(table.get(5)).toBe(12_345);
  });
});

describe.each(LAYOUTS)("$name memory layout", ({ base64, pointers }) => {
  test("places every static above the stack", async () => {
    const exports = await instantiate(base64);

    for (const name of pointers) {
      const address = (exports[name] as () => number)();
      expect(address).toBeGreaterThanOrEqual(STACK_SIZE);
    }
  });

  test("reserves only what its statics need at instantiation", async () => {
    const exports = await instantiate(base64);
    const memory = exports["memory"] as WebAssembly.Memory;

    // The banks are laid out on the heap, so an untouched instance
    // reserves the staging buffers and the stack and nothing else. What
    // this pins is that the reservation does not scale with the capacity
    // ceiling: a table holding a few thousand entries must not pay for one
    // that reaches the maximum.
    expect(memory.buffer.byteLength).toBeLessThan(2 * MIB);
  });

  test("grows linear memory to reach a bank it cannot already address", async () => {
    const exports = await instantiate(base64);
    const memory = exports["memory"] as WebAssembly.Memory;
    const before = memory.buffer.byteLength;

    // 200,000 entries need more bank than the initial reservation holds,
    // so reaching them is what proves the module grows rather than
    // failing — and that the growth is driven by the table, not reserved
    // up front.
    expect((exports["init"] as (n: number) => number)(200_000)).toBe(0);
    expect(memory.buffer.byteLength).toBeGreaterThan(before);
  });
});
