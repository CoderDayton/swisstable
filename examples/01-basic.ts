/**
 * Basic u32 -> u32 usage.
 *
 * Covers creating a table, the read/write methods, and the two behaviours
 * that differ from `Map`: keys and values are strictly unsigned 32-bit, and
 * capacity is bounded at build time rather than unbounded.
 *
 * Run with `bun run examples/01-basic.ts`.
 */

import { SwissU32ToU32 } from "../src/index.ts";

// create() uses the module compiled into the package, so there is no .wasm
// file to locate. Sizing up front avoids rehashing during the initial fill.
const table = await SwissU32ToU32.create(1_000);

table.set(1, 100);
table.set(2, 200);
table.set(2, 250); // Overwrites rather than inserting.

console.log("size:", table.size); // 2
console.log("get(2):", table.get(2)); // 250
console.log("get(99):", table.get(99)); // undefined
console.log("has(99):", table.has(99)); // false

// A stored 0 is distinguishable from an absent key: presence is reported
// separately from the value, so `get` never has to overload a sentinel.
table.set(3, 0);
console.log("get(3):", table.get(3), "vs missing:", table.get(4)); // 0 vs undefined

// Deleting leaves a tombstone; the slot is reclaimed on the next rehash.
console.log("delete(1):", table.delete(1)); // true
console.log("delete(1) again:", table.delete(1)); // false
console.log("size after delete:", table.size); // 2

// The full u32 range is valid on both sides, including values above 2^31.
table.set(0xffff_ffff, 0xdead_beef);
console.log("get(0xffffffff):", table.get(0xffff_ffff)?.toString(16)); // deadbeef

// Anything outside [0, 2^32 - 1] is rejected rather than silently coerced,
// which is where a plain object or a Map would quietly accept it.
for (const bad of [-1, 1.5, 2 ** 32, Number.NaN]) {
  try {
    table.set(bad, 1);
  } catch (error) {
    console.log(`set(${bad}):`, (error as RangeError).message);
  }
}

// capacity is the allocated slot count, always a power of two. The table
// rehashes once live entries reach 7/8 of it.
console.log("capacity:", table.capacity);

// clear() empties the table but keeps the capacity, so reusing an instance
// for a much smaller workload holds on to the larger allocation.
table.clear();
console.log("after clear — size:", table.size, "capacity:", table.capacity);
