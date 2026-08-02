# API reference

Everything the package exports, with the behaviour that is not obvious from
the signatures. For a guided tour instead, start at
[`examples/01-basic.ts`](../examples/01-basic.ts).

- [Rules that apply everywhere](#rules-that-apply-everywhere)
- [`SwissU32ToU32`](#swissu32tou32)
- [`SwissU32ToU64`](#swissu32tou64)
- [`StringInterner`](#stringinterner)
- [`InternedSwissMap`](#internedswissmap)
- [Functions and types](#functions-and-types)

## Rules that apply everywhere

**Keys and values are strictly unsigned 32-bit.** Negatives, fractions,
`NaN`, and anything past `2³² − 1` throw `RangeError` rather than being
coerced. The check is `(x >>> 0) === x`, which is exact on the u32 range, and
the value is then passed as `x | 0` — the same 32 bits, but tagged as a
machine int32. That tagging is worth ~14 ns per call; see
[performance.md](performance.md#what-dominates-the-int32-tagging-cliff).

**Capacity is fixed at build time.** The modules are freestanding and link
without an allocator, so the ceiling is `1 << 20` slots — 917,504 live
entries at the 7/8 load factor. Requests past it throw `RangeError`; raising
it means editing `MAX_CAPACITY` in the C source and rebuilding.

**Each module instance owns exactly one table.** Two tables mean two
instances. Compile the module once with `WebAssembly.compile` and pass it to
`load` repeatedly — see [`examples/04-multiple-tables.ts`](../examples/04-multiple-tables.ts).

**A stored `0` is never confused with an absent key.** Presence is reported
separately from the value, so no sentinel is overloaded anywhere in the API.

**Loading is async, everything else is synchronous.** `load` is the only
method that returns a promise.

## `SwissU32ToU32`

Maps `u32` keys to `u32` values. Use it for counters, ID remaps, and presence
sets.

### `static load(wasmBytes, expectedEntries?)`

```ts
static load(
  wasmBytes: WasmSource | WebAssembly.Module,
  expectedEntries?: number,
): Promise<SwissU32ToU32>
```

Instantiates `swiss_u32.wasm`. `wasmBytes` is either raw bytes or a module
already compiled with `WebAssembly.compile`; pass the compiled module when
creating several tables, to skip validation and codegen each time.

`expectedEntries` sizes the table up front. It is the cheapest optimization
available here — filling a pre-sized table is ~3.2x faster than growing one
from empty, because growth rehashes through every doubling.

Throws `TypeError` if the instance does not export the expected symbols, and
`RangeError` if `expectedEntries` exceeds the compiled capacity.

How you obtain the bytes is up to the runtime. On the server, resolve the
package subpath rather than hardcoding a path into `node_modules`:

```ts
import { readFile } from "node:fs/promises";
const wasm = await readFile(new URL(import.meta.resolve("swisstable/swiss_u32.wasm")));
```

In a browser or at the edge, fetch them:

```ts
const bytes = await (await fetch("/swiss_u32.wasm")).arrayBuffer();
const table = await SwissU32ToU32.load(bytes);
```

When creating several tables, compile once and pass the module:

```ts
const module = await WebAssembly.compile(wasm);
const forward = await SwissU32ToU32.load(module, 1_000);
const reverse = await SwissU32ToU32.load(module, 1_000);
```

### Accessors

| Member | Returns | Notes |
| --- | --- | --- |
| `size` | `number` | Live entries, excluding tombstones. |
| `capacity` | `number` | Allocated slots, always a power of two. The table rehashes at 7/8 of this. |

### Methods

| Method | Returns | Notes |
| --- | --- | --- |
| `has(key)` | `boolean` | Prefer `get` when you also want the value — it costs the same single crossing. |
| `get(key)` | `number \| undefined` | One boundary crossing; the value is read from a cached view over linear memory. |
| `set(key, value)` | `this` | Inserts or overwrites. Overwriting works even at the capacity ceiling. |
| `delete(key)` | `boolean` | `true` if the key was present. Leaves a tombstone, reclaimed by the next rehash. |
| `reserve(entries)` | `void` | Grows in place, preserving contents. No-op if the capacity already suffices. |
| `clear()` | `void` | Empties the table but **retains capacity** — a cleared instance never shrinks. |

```ts
const table = await SwissU32ToU32.load(bytes, 100_000);

table.set(1, 100).set(2, 200);
table.get(2);        // 200
table.get(99);       // undefined
table.delete(1);     // true
table.size;          // 1
```

## `SwissU32ToU64`

Maps `u32` keys to 64-bit values, carried as two `u32` lanes rather than
`bigint`. An `i64` crossing the WASM boundary is boxed as a `BigInt` on every
call, which costs more than the lookup it accompanies.

The reassembled value is `(hi × 2³²) + lo`.

### Everything `SwissU32ToU32` has

`load`, `size`, `capacity`, `has`, `delete`, `reserve`, and `clear` behave
identically. Only the value-carrying methods differ:

| Method | Returns |
| --- | --- |
| `get(key)` | `U64Lanes \| undefined` — allocates one `{lo, hi}` object per hit |
| `set(key, lo, hi)` | `this` |

### Spans

The conventional payload is an `{offset, length}` region — a string pool
entry, a KV-cache block:

| Method | Returns |
| --- | --- |
| `setSpan(key, span)` | `this` — encodes `lo = offset`, `hi = length` |
| `getSpan(key)` | `Span \| undefined` |

### Bulk methods

These stage a whole batch into memory the module owns and cross the boundary
once, instead of once per key. This is the widest margin over `Map` in the
suite.

| Member | Returns | Notes |
| --- | --- | --- |
| `maxBatch` | `number` | Keys per WASM call. Longer batches chunk automatically; size batches to this to avoid the extra copy. |
| `setMany(keys, valsLo, valsHi)` | `void` | Throws `RangeError` if the three arrays differ in length. |
| `getMany(keys)` | `BulkGetResult` | Result arrays are freshly allocated, sized to `keys.length`. |
| `deleteMany(keys)` | `BulkDeleteResult` | Per-key flags plus the total removed. |

Misses in `getMany` are reported through `found`, and their lanes are zeroed,
so output buffers never carry stale values from a previous batch.

```ts
const table = await SwissU32ToU64.load(bytes, keys.length);

table.setMany(keys, valsLo, valsHi);
const { valsLo: out, found } = table.getMany(keys);

table.setSpan(42, { offset: 1024, length: 256 });
table.getSpan(42);   // { offset: 1024, length: 256 }
```

`setMany` is **not atomic**: if a batch outgrows the table partway, the pairs
before the failure are applied and `size` reflects them.

## `StringInterner`

Assigns stable `u32` IDs to exact strings, in first-seen order starting at 0.
IDs remain stable for the lifetime of the instance.

| Member | Returns | Notes |
| --- | --- | --- |
| `size` | `number` | Distinct strings interned so far. |
| `intern(text)` | `number` | Existing ID, or a newly assigned one. |
| `internAll(texts)` | `Uint32Array` | IDs positionally matching `texts`. |
| `lookup(text)` | `number \| undefined` | Does **not** assign. |
| `resolve(id)` | `string \| undefined` | Reverse lookup, which is what makes IDs debuggable. |
| `internParts(parts)` | `number` | Composite key; see below. |
| `lookupParts(parts)` | `number \| undefined` | Does not assign. |
| `forgetLast(id)` | `boolean` | Releases the most recent ID; `false` if `id` is not the last. |

**Composite keys are length-prefixed** before interning, so no two distinct
part lists collide the way plain concatenation would allow:
`["ab", "c"]` encodes to `"2:ab1:c"`, `["a", "bc"]` to `"1:a2:bc"`.

**`forgetLast` is deliberately limited to the last ID.** Releasing an
arbitrary one would either leave a hole in the ID space or renumber the IDs
that follow, and stable IDs are the point of the class. It exists so a caller
that interns a key and then fails to store it can avoid leaking the ID.

## `InternedSwissMap`

A string-keyed facade over any numeric table. Strings are interned in
JavaScript and only the resulting IDs reach the table.

> **This is slower than `Map<string, V>` for repeated string lookups**, and
> structurally so — engines cache a string's hash on the string object, while
> this must intern first. Reach for it for the ergonomics. The pattern that
> actually wins is intern-once-then-key-by-ID; see
> [performance.md](performance.md#string-keys-an-asymmetry-in-what-the-engine-caches).

```ts
new InternedSwissMap<V>(table: NumericKeyTable<V>, interner?: StringInterner)
```

Pass a shared `StringInterner` when several maps should agree on what an ID
means. A fresh one is created when omitted.

| Member | Returns | Notes |
| --- | --- | --- |
| `interner` | `StringInterner` | Readonly. |
| `table` | `NumericKeyTable<V>` | Readonly. |
| `preloadVocabulary(vocabulary)` | `Uint32Array` | Interns up front so later calls never assign on the hot path. |
| `set(key, value)` | `this` | |
| `get(key)` | `V \| undefined` | |
| `has(key)` | `boolean` | |
| `delete(key)` | `boolean` | The key keeps its ID, so re-inserting reuses it. |
| `setParts(parts, value)` | `this` | Composite key. |
| `getParts(parts)` | `V \| undefined` | |
| `deleteParts(parts)` | `boolean` | |

If the underlying table rejects a write, an ID assigned for that call is
released again, so a failed `set` does not permanently consume an ID for a
key that was never stored. IDs from earlier successful calls are untouched.

## Functions and types

```ts
function spanToLanes(span: Span): U64Lanes    // { lo: offset, hi: length }
function lanesToSpan(lanes: U64Lanes): Span   // { offset: lo, length: hi }
```

Both carry their fields through unchanged rather than masking with `>>> 0`.
Masking would turn an out-of-range `offset` into a different, silently valid
u32 and defeat the validation `set` performs at the boundary.

| Type | Shape |
| --- | --- |
| `WasmSource` | `ArrayBufferLike \| Uint8Array<ArrayBufferLike>` |
| `U64Lanes` | `{ lo: number; hi: number }` |
| `Span` | `{ offset: number; length: number }` |
| `BulkGetResult` | `{ valsLo: Uint32Array; valsHi: Uint32Array; found: Uint8Array }` |
| `BulkDeleteResult` | `{ deleted: Uint8Array; removedCount: number }` |
| `NumericKeyTable<V>` | `set`/`get`/`has`/`delete` — the contract `InternedSwissMap` needs |

`SwissU32ToU32` satisfies `NumericKeyTable<number>` directly. `SwissU32ToU64`
takes its value as two lanes, so wrap its `set`/`get` at the call site to
adapt it.

The raw WASM export interfaces are not published: they mirror the
`export_name` attributes in the C sources and are an implementation detail of
the two table classes. See [design.md](design.md) for what they contain.
