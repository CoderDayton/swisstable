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
| `Uint32Array`, `Int32Array` | 5.3 ns/key |
| `Float64Array` | 8.1 ns/key |
| plain `number[]` | 8.0 ns/key |
| `BigUint64Array` | 32 ns/key |

If you control the data, keep it in a `Uint32Array`. The rest exist so
interop is possible, not so it is free.

`Float32Array` is the one source that cannot carry the whole key range: with
24 bits of mantissa, a value past `2**24` was already rounded before the
library saw it (`16777217` is stored as `16777216`). The rounded value is
still a 32-bit integer, so it would pass validation and address the wrong key
— `Float32Array` elements are therefore restricted to `[-2**24, 2**24]` and
anything beyond is a `RangeError`. Use `Float64Array` for large keys.

A batch longer than `maxBatch` is chunked, but a rejected element still
applies nothing: `setMany`, `getMany`, and `deleteMany` validate a multi-chunk
batch before the first call. A capacity ceiling is the one failure that is not
atomic — `setMany` keeps the chunks that preceded it, the same way the module
reports a ceiling hit partway through a single chunk.

**Keys and values are strictly unsigned 32-bit.** Negatives, fractions,
`NaN`, and anything past `2³² − 1` throw `RangeError` rather than being
coerced. The check is `(x >>> 0) === x`, which is exact on the u32 range, and
the value is then passed as `x | 0` — the same 32 bits, but tagged as a
machine int32, which is why keys above `2^31` cost no more than keys below
it. Where the caller keeps its keys still matters; see
[performance.md](performance.md#where-the-callers-keys-are-stored).

**Capacity is bounded.** The u32 module holds `1 << 27` slots, or
117,440,512 live entries at the 7/8 load factor. The u64 module holds
`1 << 26` slots, or 58,720,256 entries; its entries are wider, so three of
its banks run out of wasm32 address space an exponent earlier.

Requests past the ceiling throw `RangeError`, and so does an operation the
host refuses to grow linear memory for. Rebuild with a lower
`SWISS_MAX_CAPACITY_LOG2` to cap what a module asks the host for.

Run a table below its ceiling, not at it. A table holding close to the maximum
while inserting and deleting at the same rate has no room left to grow into,
so it compacts on every insert instead of amortizing. Raise the exponent or
shard across instances.

**Each module instance owns exactly one table, and grows into it.** An
instance starts at 1.25 MiB (u32) or 1.75 MiB (u64), which is its staging
buffers and stack. From there it grows linear memory as the table reaches
each new bank, so an instance costs what it holds rather than what it could
hold. See [performance.md](performance.md#memory) for what an entry costs.

`create()` shares one compiled module across every table it makes. With
`load`, compile once with `WebAssembly.compile` and pass the module in each
time. Several instances alongside each other are shown in
[`examples/04-multiple-tables.ts`](../examples/04-multiple-tables.ts).

**Dropping a table does not release it promptly.** Its memory belongs to the
`WebAssembly.Instance` behind it and comes back when the garbage collector
runs, not when the last reference goes out of scope — so a table built per
request holds its memory until then, and a burst of them holds several at
once. Call `dispose()`, or bind the table with `using`, to hand the
instance back at a point you choose. Reusing one long-lived table and
calling `clear()` between rounds avoids the question entirely: one pass over
the control bytes, and no bank it has not already grown into. Linear memory
never shrinks, so neither `clear()` nor `shrinkToFit()` returns pages to the
host; they ready the table for the next round rather than shrink the
process. An instance holds the high-water mark of every bank it ever used.

**A stored `0` is never confused with an absent key.** Presence is reported
separately from the value, so no sentinel is overloaded anywhere in the API.

**Construction is async, everything else is synchronous** — `create`,
`createWithSeed`, `load`, and `loadWithSeed` return promises, and no other
method does.

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
2.2 ms for the first table, 167 µs for each one after, against 259 µs when
recompiling bytes on every call.

`expectedEntries` behaves as it does for `load`.

The hash is seeded from the runtime's CSPRNG, so the slot a key lands in
differs between instances and between processes — see [Untrusted
keys](#untrusted-keys-and-threading). Use `createWithSeed` when a run has to
be reproducible.

Throws `RangeError` if `expectedEntries` exceeds the compiled capacity, and
`Error` if the runtime exposes neither `crypto.getRandomValues` nor
`node:crypto`.

Requires WebAssembly SIMD (v128): Node 16.9+, Chrome 91+, Firefox 89+, or
Safari 16.4+. Call `supportsSimd()` first to branch on an unknown runtime;
without it, this rejects with an `Error` naming the requirement.

Prefer this unless you need control over loading, in which case use `load`.

### `static createWithSeed(expectedEntries, seed)`

```ts
static createWithSeed(
  expectedEntries: number,
  seed: number,
): Promise<SwissU32ToU32>
```

`create`, with `seed` in place of a random one. Two tables built with the
same seed lay their entries out identically, which is what makes a benchmark
comparable between runs and a layout-dependent bug reproducible.

```ts
const table = await SwissU32ToU32.createWithSeed(100_000, 0x5175_7ab1);
```

Throws `RangeError` if `seed` is not a `u32`.

> **Do not fix a seed for data an attacker can choose.** The seed is the only
> thing standing between a caller and a key set computed offline to collide,
> and hardcoding one puts every process running that code back on the same
> layout. Use it in tests, benchmarks, and reproducible builds; use `create`
> everywhere else.

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
available here: filling a pre-sized table is 2.7x to 3.2x faster than growing one
from empty, because growth rehashes through every doubling.

Seeding matches `create`: random per instance, with `loadWithSeed(wasmBytes,
expectedEntries, seed)` as the reproducible form and the same warning
attached.

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

### `static loadSync(module, expectedEntries?)`

```ts
static loadSync(
  module: WebAssembly.Module,
  expectedEntries?: number,
): SwissU32ToU32
```

The same table without a promise, for a class field, a getter, or anywhere
else that cannot `await`. It takes a compiled module only: bytes would have
to be compiled synchronously, which is the cost the asynchronous API exists
to avoid.

```ts
const module = await WebAssembly.compile(wasm);   // once, at startup

class Index {
  private readonly ids = SwissU32ToU32.loadSync(module, 10_000);
}
```

The seed comes from the global `crypto`, so this needs Node 19+, or any
browser, Deno, or Bun. The `node:crypto` fallback the async loaders use sits
behind a dynamic `import` and cannot be reached synchronously; on Node 16.9
to 18 use `load`, or `loadSyncWithSeed(module, expectedEntries, seed)`,
which needs no random source at all and carries the same fixed-seed warning
as `createWithSeed`.

### Accessors

| Member | Returns | Notes |
| --- | --- | --- |
| `size` | `number` | Live entries, excluding tombstones. Read out of linear memory rather than called, so it is as cheap as a local — safe in a loop condition. |
| `capacity` | `number` | Allocated slots, always a power of two. The table rehashes at 7/8 of this. Read the same way as `size`. |
| `maxBatch` | `number` | Keys one bulk call carries. Longer batches chunk automatically; sizing batches to this avoids the extra copy. |

### Methods

| Method | Returns | Notes |
| --- | --- | --- |
| `has(key)` | `boolean` | Prefer `get` when you also want the value — it costs the same single crossing. |
| `get(key)` | `number \| undefined` | One boundary crossing; the value is read from a cached view over linear memory. |
| `set(key, value)` | `this` | Inserts or overwrites. Overwriting works even at the capacity ceiling. |
| `getOrInsert(key, value)` | `number` | The value now stored: the existing one, or `value` if the key was absent. |
| `increment(key, delta?)` | `number` | Adds `delta` (default 1) to the stored value, treating an absent key as 0. Returns the new value. Wraps modulo 2³². |
| `delete(key)` | `boolean` | `true` if the key was present. Leaves a tombstone, reclaimed by the next rehash. |
| `setMany(keys, values)` | `void` | Throws `RangeError` if the two arrays differ in length. |
| `getMany(keys, out?)` | `BulkU32GetResult` | Allocates `{values, found}` sized to `keys.length`, or writes into `out` — pass the previous result back in a loop to make the steady state allocation-free. |
| `deleteMany(keys)` | `BulkDeleteResult` | Per-key flags plus the total removed. |

### Reading and writing in one crossing

`getOrInsert` and `increment` exist because the obvious spelling costs two
crossings and two probes for one logical operation:

```ts
table.set(key, (table.get(key) ?? 0) + 1);   // two of each
table.increment(key);                        // one of each
```

`increment` always saves a crossing, because the read and the write are one
operation whichever way the key falls. Counting 100,000 keys costs 6.7 ns
each on Bun against 12.0 for `get` plus `set`; the gain is **1.25x to 1.8x**
depending on the engine.

**`getOrInsert` only saves one when the key is absent.** Written out, the
second crossing is inside the branch:

```ts
if (table.get(key) === undefined) table.set(key, value);   // hit: 1, miss: 2
```

So the gain tracks the miss rate: **1.22x to 1.29x** over keys none of which
are present, and nothing at all over keys that are all present, where the two
tie on every engine. Reach for it where misses are common, which is what
memoizing is; on a read-mostly table `get` is still the right call.

`getOrInsert` is the shape TC39 settled on for `Map.prototype.getOrInsert`.
There is no callback form, because a callback would have to cross back.

The per-engine figures are in
[performance.md](performance.md#reading-and-writing-in-one-crossing);
reproduce with `bun run bench --scenario=upsert`.

### Bulk methods

These stage a whole batch into memory the module owns and cross the boundary
once per chunk instead of once per key — the widest margin over `Map` in the
suite. Over 100,000 sparse keys on Bun, `setMany` fills at 6.1 ns/key against
8.5 for a `set` loop and 51.2 for `Map`; `getMany` reads at 3.9 ns/key
against 5.1 for a `get` loop and 10.6 for `Map`.

That figure is with an `out` buffer passed back in. Allocating fresh result
arrays each call costs 6.3 against 4.2. Reuse them on a hot loop:

```ts
table.setMany(keys, values);

const out = table.getMany(batches[0]!);   // allocates once
for (const batch of batches) {
  table.getMany(batch, out);              // then writes into it
  // read out.values / out.found before the next call overwrites them
}
```

`out` must be at least as long as the batch, so size it for the longest one;
only the first `batch.length` elements are written.

Misses in `getMany` are reported through `found`, and their values are
zeroed, so output buffers never carry stale values from a previous batch.
`setMany` is **not atomic** on a capacity ceiling — see
[Rules that apply everywhere](#rules-that-apply-everywhere).
| `reserve(entries)` | `void` | Makes room for `entries` total without a further rehash, preserving contents. Rehashes when growth spent on since-deleted entries is what stands in the way, even where the capacity would suffice. No-op when the remaining growth already covers it. |
| `shrinkToFit()` | `void` | Rehashes down to the smallest capacity holding the live entries. No-op if already there. Recovers walk cost, not memory. |
| `clear()` | `void` | Empties the table but **retains capacity**. Follow with `shrinkToFit()` to hand the slots back. Neither returns memory to the host. |
| `dispose()` | `void` | Releases the module instance. Idempotent, and aliased as `Symbol.dispose` so a table works with `using`. Afterwards `size` and `capacity` read 0, and every method that would touch the instance throws. An iterator opened beforehand keeps walking, and keeps the instance alive until it ends. |

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
table that peaked at 100k entries and now holds 8 takes 72–131 µs per walk;
`shrinkToFit()` brings that to 1.3–1.9 µs. Call it after a bulk removal on a
long-lived table that is walked repeatedly.

**Order is unspecified.** It is slot order, which depends on the hash and
changes whenever the table rehashes. Two tables holding the same entries need
not agree on it. If you need a stable order, sort what you get.

**Mutating during a walk.** Inserting and deleting are allowed as long as the
table does not rehash; whether the walk observes the change is unspecified. A
rehash renumbers the slots, so a walk that continued across one would skip
some entries and repeat others with nothing in the data to show it — it
throws instead. `clear()` and `shrinkToFit()` both count as a rehash here.

**A walk over a table of 57,344 entries or fewer sees no second window**,
because its whole slot space fits the first: once that window has been handed
over, every entry has been reported and nothing is left to check, so mutating
from inside the loop cannot throw. Above that, the same code does throw. Test
a walk that mutates against a table larger than one window, or it will pass at
development sizes and fail in production. (The check does run before the first
window, so rehashing between opening an iterator and its first `next()` throws
at any size.)

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
beats `Map.prototype.forEach` by 2.6x on JavaScriptCore while losing to it by
28% to 37% on V8. The iterator protocol is more expensive everywhere:
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

`create`, `createWithSeed`, `load`, `loadWithSeed`, `loadSync`,
`loadSyncWithSeed`, `size`, `capacity`, `maxBatch`, `has`, `delete`,
`deleteMany`, `reserve`, `shrinkToFit`, and `clear` behave identically, with
the six constructors instantiating `swiss_u64.wasm` instead. Only the
value-carrying methods differ, taking and returning two lanes where the u32
table takes and returns one:

| Method | Returns |
| --- | --- |
| `get(key)` | `U64Lanes \| undefined` — allocates one `{lo, hi}` object per hit |
| `set(key, lo, hi)` | `this` |
| `getOrInsert(key, lo, hi)` | `U64Lanes` — the lanes now stored |
| `increment(key, deltaLo?, deltaHi?)` | `U64Lanes` — adds a 64-bit delta, carrying between lanes, wrapping modulo 2⁶⁴ |

Iteration works the same way, with the same order and mutation rules, except
that `values()` yields `U64Lanes` and `entries()` yields `[key, lanes]`. The
scan stages into buffers of its own and each chunk is copied out before it is
handed over, so a `getMany` issued between two steps of an open iterator
cannot disturb it, and neither can the reverse.

`forEach` is here too, and matches `Map`'s callback shape — which has one
value argument, so it must box the two lanes into a `U64Lanes` per entry.
**`forEachLanes(callback, thisArg?)`** is the same walk without that: it
calls `callback(lo, hi, key, table)` and allocates nothing. When the callback
discards the lanes the two run at the same speed, because escape analysis
removes the object; when it keeps them it cannot, and `forEachLanes` is
faster on every engine: 19% to 33% on V8, and about 2x on JavaScriptCore and
SpiderMonkey. Prefer it on a hot path.

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

As on the u32 table, with a lane pair in place of the single value:

| Member | Returns | Notes |
| --- | --- | --- |
| `setMany(keys, valsLo, valsHi)` | `void` | Throws `RangeError` if the three arrays differ in length. |
| `getMany(keys, out?)` | `BulkGetResult` | Allocates result arrays sized to `keys.length`, or writes into `out` (arrays at least that long) — pass the previous result back in a loop to make the steady state allocation-free. |

Misses in `getMany` are reported through `found`, and their lanes are zeroed,
so output buffers never carry stale values from a previous batch.

```ts
const table = await SwissU32ToU64.load(bytes, keys.length);

table.setMany(keys, valsLo, valsHi);
const { valsLo: out, found } = table.getMany(keys);

table.setSpan(42, { offset: 1024, length: 256 });
table.getSpan(42);   // { offset: 1024, length: 256 }
```

`setMany` is **not atomic** on a capacity ceiling — see
[Rules that apply everywhere](#rules-that-apply-everywhere).

## `StringInterner`

Assigns `u32` IDs to exact strings, in first-seen order starting at 0. By
default IDs remain stable for the lifetime of the instance.

```ts
new StringInterner(options?: { recycleIds?: boolean; maxSize?: number })
```

| Member | Returns | Notes |
| --- | --- | --- |
| `size` | `number` | Strings currently interned. Only ever grows unless IDs are recycled. |
| `recyclesIds` | `boolean` | The mode, fixed at construction. |
| `maxSize` | `number` | The cap, or `Infinity` when uncapped. Fixed at construction. |
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

### Capping growth

`{ maxSize: n }` refuses to assign an ID once `n` strings are interned,
throwing `RangeError`. Only assignment is capped: re-interning a string
already held returns its ID at the cap, and `resolve` and `lookup` keep
working. The constructor throws `RangeError` unless `maxSize` is a positive
integer or `Infinity`, the value `maxSize` reports for an uncapped interner.

An interner never forgets on its own, so a rotating key space grows for as
long as the process lives. A cap turns that from a slow leak into a failure
at a point you chose:

```ts
// A vocabulary this size is a bug, not a workload.
const interner = new StringInterner({ maxSize: 1_000_000 });
```

Recycling and a cap compose: releasing an ID frees room under it.

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
| `interner` | `OwnedStringInterner` | Readonly, and narrowed — see below. |
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

The `interner` property hands back the live interner so several maps can share
it, but typed as `OwnedStringInterner`: `claim`, `release`, and `forgetLast`
are not on it. Those run the ID lifecycle, which is the map's to run — calling
`release` for a key the map still holds would let a later string take that ID
and answer for the old key's value. Construct the interner yourself and keep
your own reference if you need the full surface.

`size` and `interner.size` answer different questions and diverge as soon as
anything is deleted. `size` counts live entries; `interner.size` counts every
distinct string ever seen, and never decreases, because IDs stay stable for
the lifetime of the interner. In a long-lived map with churning keys,
`interner.size` is the one that grows without bound.

## Untrusted keys and threading

**The hash is seeded per instance.** Every table draws a 32-bit seed from the
runtime's CSPRNG — `crypto.getRandomValues`, or `node:crypto` on the Node
versions predating the global — and mixes it into each key ahead of the
Murmur3 finalizer. The finalizer alone is a public, invertible permutation:
unseeded, the set of keys sharing a probe group is a property of the build,
the same in every process, and computable offline by anyone holding the
package. The seed makes it a property of the instance, so a key set that
collides in one process does not collide in the next.

What that does not buy: a 32-bit seed is not a keyed MAC. An attacker who can
observe which keys collide — through timing, most plausibly — can search the
seed space offline and then craft keys for the seed they recovered. What
remains is the bound: the group index takes 20 bits of the hash at the
default capacity, leaving 12 free, so **at most 4,096 distinct keys can share
a group**, and the worst case measures about 5x slower lookups, not a stall.

So the exposure is a recovered-seed attacker paying for a 5x slowdown, not a
precomputed key set that stalls every process running this package. If keys
are fully attacker-chosen and even that margin matters, hash them yourself
before interning.

`createWithSeed` and `loadWithSeed` opt out of the random seed. They exist
for reproducible runs and should not be used for untrusted input.

**A table is single-threaded.** One module instance is one table, and its
state is plain memory with no atomics. Do not share an instance across
workers: give each worker its own table. `load()` accepts an already-compiled
`WebAssembly.Module`, so workers can share the *compiled code* — which is
immutable — while each instantiates its own memory.

## Functions and types

```ts
function supportsSimd(): boolean              // can this runtime run the modules
function spanToLanes(span: Span): U64Lanes    // { lo: offset, hi: length }
function lanesToSpan(lanes: U64Lanes): Span   // { offset: lo, length: hi }
```

`supportsSimd()` validates a one-instruction v128 module, so it answers for
the feature the tables actually need. It is synchronous and cheap enough to
call on a code path that picks between this and a `Map` fallback.

Both carry their fields through unchanged rather than masking with `>>> 0`.
Masking would turn an out-of-range `offset` into a different, silently valid
u32 and defeat the validation `set` performs at the boundary.

| Type | Shape |
| --- | --- |
| `WasmSource` | `ArrayBuffer \| Uint8Array<ArrayBufferLike>` |
| `U64Lanes` | `{ lo: number; hi: number }` |
| `Span` | `{ offset: number; length: number }` |
| `BulkU32GetResult` | `{ values: Uint32Array; found: Uint8Array }` — what `SwissU32ToU32.getMany` returns |
| `BulkGetResult` | `{ valsLo: Uint32Array; valsHi: Uint32Array; found: Uint8Array }` — what `SwissU32ToU64.getMany` returns |
| `BulkDeleteResult` | `{ deleted: Uint8Array; removedCount: number }` — returned by `deleteMany` on both tables |
| `NumericKeyTable<V>` | `set`/`get`/`has`/`delete`, plus optional `forEach`/`entries` — the contract `InternedSwissMap` needs |
| `OwnedStringInterner` | `StringInterner` without `claim`/`release`/`forgetLast` — what `InternedSwissMap.interner` returns |
| `BulkU32Source` | Any integer typed array, `BigInt64Array`/`BigUint64Array`, `readonly number[]`, or `readonly bigint[]` — what the bulk methods accept, with the per-element rules in [Bulk sources](#bulk-sources) |
| `StringInternerOptions` | `{ recycleIds?: boolean; maxSize?: number }` — what the `StringInterner` constructor takes |

`SwissU32ToU32` satisfies `NumericKeyTable<number>` directly, optional members
included. `SwissU32ToU64` takes its value as two lanes, so wrap its
`set`/`get` at the call site to adapt it — and its `forEachLanes`/`entries` if
you want the wrapped table to stay iterable.

The raw WASM export interfaces are not published: they mirror the
`export_name` attributes in the C sources and are an implementation detail of
the two table classes. See [design.md](design.md) for what they contain.
