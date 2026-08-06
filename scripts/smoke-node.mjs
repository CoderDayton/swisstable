/*
 * Smoke test for the published build under plain Node.
 *
 * `bun test` runs the TypeScript sources under Bun, which proves neither
 * that `tsc` emitted something Node can load nor that the runtime globals
 * the bindings reach for — `atob`, `WebAssembly` — are there. This imports
 * the built entry point exactly as an installed dependency would.
 *
 * Plain JavaScript, not TypeScript: it has to run on the oldest Node the
 * package claims to support, which cannot strip types.
 *
 * Run after `bun run build`, from the repository root:
 *
 *   node scripts/smoke-node.mjs
 */

import assert from "node:assert/strict";

const { SwissU32ToU32, SwissU32ToU64, InternedSwissMap } = await import(
  "../dist/js/index.js"
);

const u32 = await SwissU32ToU32.create(1024);

u32.set(0xdead_beef, 42);
assert.equal(u32.get(0xdead_beef), 42, "u32 get should return what set stored");
assert.equal(u32.size, 1, "u32 size should count the one entry");
assert.equal(u32.get(1), undefined, "u32 get should report an absent key");
assert.deepEqual([...u32], [[0xdead_beef, 42]], "u32 should iterate its entry");

const u64 = await SwissU32ToU64.create(1024);

u64.setMany([1, 2, 3], [10, 20, 30], [0, 0, 1]);

const { valsLo, valsHi, found } = u64.getMany([1, 3, 4]);

assert.deepEqual([...valsLo], [10, 30, 0], "u64 low lanes should round-trip");
assert.deepEqual([...valsHi], [0, 1, 0], "u64 high lanes should round-trip");
assert.deepEqual([...found], [1, 1, 0], "u64 should report the absent key");

const map = new InternedSwissMap(await SwissU32ToU32.create(64));

map.set("hello", 5);
assert.equal(map.get("hello"), 5, "interned map should round-trip a string key");
assert.equal(map.get("world"), undefined, "interned map should report a miss");

console.log(`smoke test passed on node ${process.version}`);
