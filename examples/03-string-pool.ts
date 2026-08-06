/**
 * String keys, and the string pool they are worth pairing with.
 *
 * Two things are shown, in the order they matter:
 *
 * 1. `InternedSwissMap`, the direct string-keyed facade. Convenient, but
 *    slower than `Map<string, V>` for repeated lookups — JavaScript engines
 *    cache a string's hash on the string object, so `Map` rehashes nothing
 *    while this must intern first. Reach for it for the ergonomics, not the
 *    speed.
 *
 * 2. Interning once and keying by the resulting u32 ID afterwards. This is
 *    the shape that actually wins: the string cost is paid once at load,
 *    and every later access is a numeric lookup.
 *
 * Run with `bun run examples/03-string-pool.ts`.
 */

import {
  InternedSwissMap,
  StringInterner,
  SwissU32ToU32,
  SwissU32ToU64,
} from "../src/index.ts";

// ── 1. The convenience facade ──────────────────────────────────────────

const counts = new InternedSwissMap(await SwissU32ToU32.create(1_000));

for (const word of ["alpha", "beta", "alpha", "gamma", "alpha"]) {
  counts.set(word, (counts.get(word) ?? 0) + 1);
}

console.log("alpha:", counts.get("alpha")); // 3
console.log("delta:", counts.get("delta")); // undefined

// Composite keys are length-prefixed before interning, so no two distinct
// part lists can collide the way plain concatenation would allow.
counts.setParts(["user", "42", "visits"], 7);
console.log("composite:", counts.getParts(["user", "42", "visits"])); // 7

// Plain concatenation would map both of these to "abc"; length-prefixing
// keeps them distinct.
counts.setParts(["ab", "c"], 1);
counts.setParts(["a", "bc"], 2);
console.log("ab|c:", counts.getParts(["ab", "c"])); // 1
console.log("a|bc:", counts.getParts(["a", "bc"])); // 2

// ── 2. Intern once, then stay numeric ──────────────────────────────────

const vocabulary = ["temperature", "pressure", "humidity", "wind_speed"];

// One shared interner can front several tables, so an ID means the same
// thing in all of them.
const interner = new StringInterner();
const ids = interner.internAll(vocabulary);

// Pack the strings into one contiguous buffer and store each one's
// {offset, length} span against its ID. This is the standard layout for a
// tokenizer vocabulary or a KV-cache index.
const encoder = new TextEncoder();
const encoded = vocabulary.map((text) => encoder.encode(text));
const poolSize = encoded.reduce((total, bytes) => total + bytes.length, 0);
const pool = new Uint8Array(poolSize);

const spans = await SwissU32ToU64.create(vocabulary.length);

let offset = 0;
for (const [index, bytes] of encoded.entries()) {
  pool.set(bytes, offset);
  spans.setSpan(ids[index]!, { offset, length: bytes.length });
  offset += bytes.length;
}

// From here the hot path never touches a string: an ID goes in, a span
// comes out, and the bytes are read straight from the pool.
const decoder = new TextDecoder();

for (const id of ids) {
  const span = spans.getSpan(id)!;
  const text = decoder.decode(pool.subarray(span.offset, span.offset + span.length));
  console.log(`id ${id} -> ${span.offset}+${span.length} -> ${text}`);
}

// The interner also runs in reverse, which is what makes IDs debuggable.
console.log("resolve(0):", interner.resolve(0));
console.log("resolve(999):", interner.resolve(999)); // undefined
console.log("interned strings:", interner.size);
