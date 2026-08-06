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

Arguments are validated at the boundary and rejected by name, so a mistake
reports the parameter you wrote rather than surfacing later as an internal
error:

| Argument | Requirement | On violation |
| --- | --- | --- |
| Keys, values, `expectedEntries`, `entries` | Unsigned 32-bit integer | `RangeError` naming the parameter |
| Bulk `keys`, `valsLo`, `valsHi` | Any array or typed array of 32-bit integers | `TypeError` for the container, `RangeError` naming the element index |
| `span` | Object with u32 `offset` and `length` | `TypeError`, then `RangeError` naming `span.offset` / `span.length` |
| Interner keys and parts | `string` | `TypeError` — a non-string would break `resolve`'s return type |
| `new InternedSwissMap(table)` | Object with `set`/`get`/`has`/`delete` | `TypeError` at construction, not at first use |

The container of a bulk argument is checked once per call. Whether its
elements are checked too depends on the source — see below.

### Bulk sources

The bulk methods take any numeric sequence, typed as `BulkU32Source`: every
integer typed array, `Float32Array`/`Float64Array`, `BigInt64Array`/
`BigUint64Array`, and plain arrays of `number` or `bigint`. Every element must
be an integer in `[-2**31, 2**32 - 1]`; a negative value is its unsigned bit
pattern, so `-1` and `4294967295` are the same key from any source.

Integer typed arrays are the fast path and are copied wholesale, never
inspected element by element. The others cannot be: a float array truncates
silently on a bulk copy (`1.5` to `1`, `2**32` to `0`) and a BigInt array
cannot be copied at all, so their elements are converted individually and
validated. That cost is real and you only pay it for a source that needs it:

| Source | `getMany` over 100k keys |
| --- | --- |
| `Uint32Array`, `Int32Array` | 8.1 ns/key |
| `Float64Array` | 8.9 ns/key |
| plain `number[]` | 16.9 ns/key |
| `BigUint64Array` | 82.9 ns/key |

If you control the data, keep it in a `Uint32Array`. The rest exist so
interop is possible, not so it is free.

`Float32Array` is the one source that cannot carry the whole key range: with
24 bits of mantissa, a value past `2**24` was already rounded before the
library saw it (`16777217` is stored as `16777216`). The rounded value is
still a 32-bit integer, so it would pass validation and address the wrong key
— `Float32Array` elements are therefore restricted to `[-2**24, 2**24]` and
anything beyond is a `RangeError`. Use `Float64Array` for large keys.

A batch longer than `maxBatch` is chunked, but a rejected element still
applies nothing: `setMany` and `deleteMany` validate a multi-chunk batch
before the first call. A capacity ceiling is the one failure that is not
atomic — `setMany` keeps the chunks that preceded it, the same way the module
reports a ceiling hit partway through a single chunk.


**Keys and values are strictly unsigned 32-bit.** Negatives, fractions,
`NaN`, and anything past `2³² − 1` throw `RangeError` rather than being
coerced. The check is `(x >>> 0) === x`, which is exact on the u32 range, and
the value is then passed as `x | 0` — the same 32 bits, but tagged as a
machine int32, which is why keys above `2^31` cost no more than keys below
it. Where the caller keeps its keys still matters; see
[performance.md](performance.md#where-the-callers-keys-are-stored).

**Capacity is fixed at build time.** The modules are freestanding and link
without an allocator, so the ceiling is `1 << 20` slots — 917,504 live
entries at the 7/8 load factor. Requests past it throw `RangeError`. Rebuild
with `SWISS_MAX_CAPACITY_LOG2` set to a different power-of-two exponent to
move it either way; the build script sizes linear memory from the same
number.

**Each module instance owns exactly one table, and reserves its whole budget
up front.** The banks are static arrays, so an instance reserves 20 MiB (u32)
or 28 MiB (u64) of linear memory from instantiation whether it holds one
entry or its maximum. The reservation is address space and is committed page
by page as the table touches it, so a small table still resides small — but
two tables mean two instances and twice the reservation. See
[performance.md](performance.md#memory) for what an entry costs. Compile the
module once with `WebAssembly.compile` and pass it to `load` repeatedly — see
[`examples/04-multiple-tables.ts`](../examples/04-multiple-tables.ts). For
many small tables, build a second pair of modules with a lower
`SWISS_MAX_CAPACITY_LOG2`: at `2^16` a u32 instance costs 3.1 MiB instead of
20, capped at 57,344 entries.

**A stored `0` is never confused with an absent key.** Presence is reported
separately from the value, so no sentinel is overloaded anywhere in the API.

**Loading is async, everything else is synchronous.** `load` is the only
method that returns a promise.

## `SwissU32ToU32`

Maps `u32` keys to `u32` values. Use it for counters, ID remaps, and presence
sets.

### `static create(expectedEntries?)`

```ts
static create(expectedEntries?: number): Promise<SwissU32ToU32>
```

Creates a table from the module compiled into the package. No `.wasm` file
is involved, so this behaves identically on every runtime.

The module is compiled on the first call and shared by every later one, so
only instantiation is paid per table. Measured on Bun 1.3.14 / x64 Linux:
1.49 ms for the first table, 152 µs for each one after, against 276 µs when
recompiling bytes on every call.

`expectedEntries` behaves as it does for `load`.

Throws `RangeError` if `expectedEntries` exceeds the compiled capacity.

Prefer this unless you need control over loading, in which case use `load`.

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
| `size` | `number` | Read out of linear memory, not a call. As cheap as a local — safe in a loop condition. |
| `capacity` | `number` | Same. Always a power of two; the table rehashes at 7/8 of it. |
| `has(key)` | `boolean` | Prefer `get` when you also want the value — it costs the same single crossing. |
| `get(key)` | `number \| undefined` | One boundary crossing; the value is read from a cached view over linear memory. |
| `set(key, value)` | `this` | Inserts or overwrites. Overwriting works even at the capacity ceiling. |
| `delete(key)` | `boolean` | `true` if the key was present. Leaves a tombstone, reclaimed by the next rehash. |
| `reserve(entries)` | `void` | Grows in place, preserving contents. No-op if the capacity already suffices. |
| `shrinkToFit()` | `void` | Rehashes down to the smallest capacity holding the live entries. No-op if already there. |
| `clear()` | `void` | Empties the table but **retains capacity**. Follow with `shrinkToFit()` to hand the slots back. |

### Iteration

| Method | Yields |
| --- | --- |
| `keys()` | `number` |
| `values()` | `number` |
| `entries()`, `[Symbol.iterator]()` | `[key, value]` |
| `forEach(callback, thisArg?)` | calls `callback(value, key, table)` |

Entries are read out one window of slots per WASM call rather than one per
key, so a full walk is a handful of crossings whatever the size — 16 at the
compiled ceiling.

**A walk costs O(capacity), not O(size).** A scan visits every group of slots,
so the cost tracks the slot space rather than what is in it — and capacity
only ever rises on its own: `reserve` and the growth path raise it, `clear`
retains it, and a `delete` leaves a tombstone rather than a freed slot. A
table that peaked at 100k entries and now holds 8 takes 36 µs per walk;
`shrinkToFit()` brings that to 0.5 µs. Call it after a bulk removal on a
long-lived table that is walked repeatedly.

**Order is unspecified.** It is slot order, which depends on the hash and
changes whenever the table rehashes. Two tables holding the same entries need
not agree on it. If you need a stable order, sort what you get.

**Mutating during a walk.** Inserting and deleting are allowed as long as the
table does not rehash; whether the walk observes the change is unspecified. A
rehash renumbers the slots, so a walk that continued across one would skip
some entries and repeat others with nothing in the data to show it — it
throws instead. `clear()` and `shrinkToFit()` both count as a rehash here.

The generation check runs once per slot window, so read this as **may throw**
rather than always throws: a rehash after the last window has been handed
over ends the walk normally, and correctly — every entry was already reported
exactly once from the layout the walk pinned.

```ts
for (const [key, value] of table) { /* … */ }

const iterator = table.keys();
iterator.next();
table.reserve(500_000);   // rehashes
[...iterator];            // throws: rehashed during iteration
```

**Cost.** `forEach` allocates nothing per entry, and over 100k entries it
beats `Map.prototype.forEach` by 2.3x on JavaScriptCore while losing to it by
about 25% on V8. The iterator protocol is more expensive everywhere:
`keys()`, `values()`, and `entries()` allocate a result record per entry the
way the built-ins do, and `entries()` runs slower than `Map`'s, whose
iterator is engine-internal. Prefer `forEach` when the values are needed and
`keys()` when they are not — `keys()` is the cheapest walk on every engine.
Reproduce all of it with `bun run bench`, or `bun run bench:all` for the
per-engine spread.

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

`create`, `load`, `size`, `capacity`, `has`, `delete`, `reserve`, and `clear`
behave identically, `create` and `load` instantiating `swiss_u64.wasm`
instead. Only the value-carrying methods differ:

| Method | Returns |
| --- | --- |
| `get(key)` | `U64Lanes \| undefined` — allocates one `{lo, hi}` object per hit |
| `set(key, lo, hi)` | `this` |

Iteration works the same way, with the same order and mutation rules, except
that `values()` yields `U64Lanes` and `entries()` yields `[key, lanes]`. The
scan borrows the same staging buffers the bulk methods use, so each chunk is
copied out before it is handed over — a `getMany` issued between two steps of
an open iterator cannot disturb it.

`forEach` is here too, and matches `Map`'s callback shape — which has one
value argument, so it must box the two lanes into a `U64Lanes` per entry.
**`forEachLanes(callback, thisArg?)`** is the same walk without that: it
calls `callback(lo, hi, key, table)` and allocates nothing. When the callback
discards the lanes the two run level, because escape analysis removes the
object; when it keeps them it cannot, and `forEachLanes` measures ~1.6x
faster. Prefer it on a hot path.

```ts
table.forEachLanes((lo, hi, key) => {
  // no allocation per entry, whatever the callback does with the lanes
});
```

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
| `getMany(keys, out?)` | `BulkGetResult` | Allocates result arrays sized to `keys.length`, or writes into `out` (arrays at least that long) — pass the previous result back in a loop to make the steady state allocation-free. |
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

Assigns `u32` IDs to exact strings, in first-seen order starting at 0. By
default IDs remain stable for the lifetime of the instance.

```ts
new StringInterner(options?: { recycleIds?: boolean })
```

| Member | Returns | Notes |
| --- | --- | --- |
| `size` | `number` | Strings currently interned. Only ever grows unless IDs are recycled. |
| `recyclesIds` | `boolean` | The mode, fixed at construction. |
| `release(id)` | `boolean` | Frees an ID for reuse. **Throws `TypeError` unless `recycleIds` is on.** |
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
that interns a key and then fails to store it can avoid leaking the ID. With
recycling on it also accepts an ID `intern` has just taken from the pool,
which is not at the end of the ID space and so cannot be found by position.

### Recycling IDs

Without recycling, a deleted key keeps its ID and its string forever. That is
the right default — IDs are stable, so they can be held anywhere — but for a
long-lived map whose keys rotate it is a leak: the interner retires one ID per
distinct key *ever seen*, not per key currently held. `size` never falls.

`{ recycleIds: true }` hands a released ID to the next new string instead,
bounding the ID space at the number of strings live at once:

```ts
const map = new InternedSwissMap(table, new StringInterner({ recycleIds: true }));

for (let i = 0; i < 300_000; i += 1) {
  map.set(`key-${i}`, i);
  if (i >= 1000) map.delete(`key-${i - 1000}`);
}

map.interner.size;   // 1000 — without recycling, 300000
```

What you give up, and the rules that follow from it:

- **An ID no longer identifies one string.** Anything holding an ID across a
  `delete` may be reading a different key's value. Do not persist, log, or
  share IDs from a recycling interner.
- **A recycling interner cannot be shared between maps.** The second
  `InternedSwissMap` built around one throws `TypeError`. A delete in the
  first map would hand its ID to a new string while the second map's entry
  under that ID still answered for the old key. Non-recycling interners stay
  shareable.
- **Only `InternedSwissMap.delete`/`deleteParts` release**, and only when the
  table actually held the entry. A key that was interned but never stored
  keeps its ID, since `resolve` still answers for it.

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
| `size` | `number` | Live entries in the table, not strings interned. |
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
| `keys()` | `IterableIterator<string>` | Each ID resolved back to its string. |
| `values()` | `IterableIterator<V>` | |
| `entries()`, `[Symbol.iterator]()` | `IterableIterator<[string, V]>` | |
| `forEach(callback, thisArg?)` | `void` | Calls `callback(value, key, map)`. The allocation-free walk. |

### Iteration

Order is the underlying table's — slot order, so unspecified. Not insertion
order, and not the order keys were interned in.

A key built with `setParts` comes back in its **encoded** form (`["user",
"42"]` reads back as `"4:user2:42"`), because that encoded string is what was
interned.

Iteration needs more of the table than the four required methods, so it is
feature-detected: `forEach` needs the table's `forEach`, and the pull
iterators need its `entries`. Both are **optional** members of
`NumericKeyTable` — a table written against the original four-method contract
still works everywhere else and throws `TypeError` only here.

An ID the interner cannot resolve throws rather than being skipped or handed
back as `undefined`. It means the table holds an entry written through the
public `table` property directly, bypassing interning, so there is no string
key to report.

If the underlying table rejects a write, an ID assigned for that call is
released again, so a failed `set` does not permanently consume an ID for a
key that was never stored. IDs from earlier successful calls are untouched.

`size` and `interner.size` answer different questions and diverge as soon as
anything is deleted. `size` counts live entries; `interner.size` counts every
distinct string ever seen, and never decreases, because IDs stay stable for
the lifetime of the interner. In a long-lived map with churning keys,
`interner.size` is the one that grows without bound.

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
| `NumericKeyTable<V>` | `set`/`get`/`has`/`delete`, plus optional `forEach`/`entries` — the contract `InternedSwissMap` needs |

`SwissU32ToU32` satisfies `NumericKeyTable<number>` directly, optional members
included. `SwissU32ToU64` takes its value as two lanes, so wrap its
`set`/`get` at the call site to adapt it — and its `forEachLanes`/`entries` if
you want the wrapped table to stay iterable.

The raw WASM export interfaces are not published: they mirror the
`export_name` attributes in the C sources and are an implementation detail of
the two table classes. See [design.md](design.md) for what they contain.
