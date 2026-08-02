/**
 * Several tables at once, and the capacity ceiling.
 *
 * Each module instance owns exactly one table in its own linear memory —
 * the native sources hold it in static storage and link without an
 * allocator. Two tables therefore mean two instances, which is cheap
 * because `create` compiles the module once and shares it.
 *
 * Run with `bun run examples/04-multiple-tables.ts`.
 */

import { SwissU32ToU32 } from "../src/index.ts";

// No compile step to manage: the first create() compiles the embedded
// module, and every later one reuses it. Only instantiation is per-table.
const forward = await SwissU32ToU32.create(1_000);
const reverse = await SwissU32ToU32.create(1_000);

// A bidirectional index, one direction per instance. The instances share
// no state: writing to one is invisible to the other.
for (const [id, code] of [[1, 900], [2, 901], [3, 902]] as const) {
  forward.set(id, code);
  reverse.set(code, id);
}

console.log("forward 2 ->", forward.get(2)); // 901
console.log("reverse 901 ->", reverse.get(901)); // 2
console.log("reverse has 2:", reverse.has(2)); // false — separate tables

// ── Capacity ───────────────────────────────────────────────────────────

// Capacity is bounded at build time by MAX_CAPACITY in the native source,
// so a request past it fails loudly instead of degrading. Raising it means
// rebuilding, since the linear memory reserved by scripts/build-wasm.ts has
// to cover the larger banks.
try {
  await SwissU32ToU32.create(2_000_000);
} catch (error) {
  console.log("oversized load:", (error as RangeError).message);
}

// `reserve` grows an existing table in place, preserving its contents. It
// is worth calling when the final size becomes known after construction.
const table = await SwissU32ToU32.create();
table.set(7, 70);

console.log("capacity before reserve:", table.capacity);
table.reserve(100_000);
console.log("capacity after reserve:", table.capacity);
console.log("contents survived:", table.get(7)); // 70

// Growth is automatic without a reserve, but it costs a full rehash each
// time the table crosses its 7/8 load factor. Sizing up front avoids that.
const unsized = await SwissU32ToU32.create();
const capacities: number[] = [];

for (let i = 0; i < 20_000; i++) {
  unsized.set(i, i);
  const current = unsized.capacity;
  if (capacities.at(-1) !== current) capacities.push(current);
}

console.log("rehash points:", capacities.join(" -> "));
