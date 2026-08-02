/**
 * Bulk operations on the u32 -> u64 table.
 *
 * The bulk methods stage a whole batch into the module's memory and cross
 * the WASM boundary once, instead of once per key. That fixed crossing cost
 * is the single biggest term at small batch sizes, so this is where the
 * margin over `Map` is widest — see docs/performance.md.
 *
 * The timings printed below are single-shot and include JIT warmup, so they
 * run several times slower than the steady-state figures in that document.
 * Use `bun run bench` for numbers worth comparing.
 *
 * Run with `bun run examples/02-bulk.ts` (after `bun run build`).
 */

import { SwissU32ToU64 } from "../src/index.ts";

const WASM_PATH = new URL("../dist/wasm/swiss_u64.wasm", import.meta.url);
const wasmBytes = await Bun.file(WASM_PATH).arrayBuffer();

const COUNT = 100_000;

const table = await SwissU32ToU64.load(wasmBytes, COUNT);

// Bulk methods take parallel typed arrays. Values are two u32 lanes rather
// than a bigint, because an i64 return would be boxed on every call.
const keys = new Uint32Array(COUNT);
const valsLo = new Uint32Array(COUNT);
const valsHi = new Uint32Array(COUNT);

for (let i = 0; i < COUNT; i++) {
  keys[i] = i * 2_654_435_761 >>> 0; // Knuth's multiplicative scatter.
  valsLo[i] = i;
  valsHi[i] = i >>> 8;
}

const filled = Bun.nanoseconds();
table.setMany(keys, valsLo, valsHi);
const fillNs = Bun.nanoseconds() - filled;

console.log(`filled ${table.size} entries in ${(fillNs / 1e6).toFixed(1)} ms`);
console.log(`  ${(fillNs / COUNT).toFixed(1)} ns/entry`);

// Batches larger than maxBatch are chunked automatically; each chunk is
// still one crossing. Size batches to this to avoid the extra copy.
console.log("maxBatch:", table.maxBatch);

// getMany returns parallel results: found[i] is 1 when keys[i] was present.
const looked = Bun.nanoseconds();
const { valsLo: outLo, found } = table.getMany(keys);
const lookupNs = Bun.nanoseconds() - looked;

let hits = 0;
for (let i = 0; i < COUNT; i++) if (found[i] === 1) hits++;

console.log(`looked up ${hits} hits in ${(lookupNs / 1e6).toFixed(1)} ms`);
console.log(`  ${(lookupNs / COUNT).toFixed(1)} ns/lookup`);
console.log("first value round-trips:", outLo[0] === valsLo[0]);

// Misses are reported through `found`, and their lanes are zeroed, so the
// output buffers never carry stale values from a previous batch.
const missing = new Uint32Array([1, 3, 5]);
const missResult = table.getMany(missing);
console.log("misses found flags:", Array.from(missResult.found));

// deleteMany reports both a per-key flag and the total actually removed.
const toDelete = keys.subarray(0, 10);
const { removedCount } = table.deleteMany(toDelete);
console.log("removed:", removedCount, "size now:", table.size);

// Single-key access still works, and costs one crossing thanks to the
// latched-result slot. Prefer getMany past a handful of keys: `get`
// allocates a `{lo, hi}` object per hit.
console.log("single get:", table.get(keys[20]!));

// A span is the conventional payload: lo = offset, hi = length.
table.setSpan(42, { offset: 1024, length: 256 });
console.log("span:", table.getSpan(42));
