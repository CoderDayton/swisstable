# Performance

**On sparse `u32` keys at 100,000 entries these tables beat `Map` on every
runtime measured, by 1.3x to 12x, with the widest margins on bulk transfer
and mutation rather than on lookup. Below ~2,000 entries `Map` wins nearly
everywhere. By 8,000 the tables are ahead on every engine except
JavaScriptCore, which crosses over near 10,000. For string keys `Map` wins
everywhere, and for dense keys a typed array beats both.**

Four things explain the whole picture:

1. A crossing into WASM costs a few nanoseconds before any work happens, so
   the tables need a working-set advantage large enough to repay it. That
   only exists once a table outgrows cache.
2. **`Map` is not one container.** JavaScriptCore's `Map` looks up a sparse
   `u32` key in 11.1 ns; V8's takes 26–27 ns for the same work. The tables
   cost about the same everywhere, so most of the spread between columns
   below is `Map` moving, not the table.
3. The largest single cost on the JavaScriptCore path is not in the table at
   all. It is how the caller stores its keys, and it is worth ~1.7x.
4. Batching moves the crossing off the per-key path entirely, which is why
   the bulk APIs show the widest margins.

## How these numbers were taken

| runtime | engine | collector on demand | clock resolution |
| --- | --- | --- | --- |
| Bun 1.3.14 | JavaScriptCore | yes | 0.03 µs |
| Node 24.15.0 | V8 | yes | 0.06 µs |
| Deno 2.9.4 | V8 | yes | 0.17 µs |
| Chrome 151 | V8 | yes | 5 µs |
| Firefox 153 | SpiderMonkey | no | 20 µs |

13th Gen Intel Core i9-13900K, Linux x64. 100,000 entries, median of 21
rounds, median of 3 passes, one isolate per contender. Treat the ratios
within a column as the portable part and the absolute figures as specific to
this machine. The ratios *across* columns are portable too, and are the point
of publishing five.

Five properties of the harness are load-bearing:

- **Every runtime executes the same scenario code.** `benches/runtime.ts`
  supplies the four things that differ between hosts (a nanosecond clock,
  module loading, isolation, and where results go) and the scenarios import
  nothing else, so a column difference is an engine difference.
- **Each contender runs in an isolate of its own**: a child process on the
  server runtimes, a `Worker` in a browser. Contenders sharing one isolate
  specialize each other's inline caches on the library's call sites.
- **Rounds reduce by median, not best-of**, and passes reduce by median
  again. A minimum is biased low by an amount that grows with variance, and
  what varies most is whatever allocates — so a best-of discounts the
  collection a container causes.
- **Keys are probed in a shuffled order.** `Map` stores entries in insertion
  order, so replaying that order walks its entry table sequentially and, for
  dense integer keys, its bucket index too.
- **Firefox has no on-demand collector**, so its rows carry whatever the
  harness's own garbage costs; every other column collects between the warmup
  and measured rounds. The browser columns also cover a subset of the
  scenarios: the ones that compare against `Map`, which is every row
  published here.

## Results at 100,000 entries

Speedup against `Map`. Above 1.00x the table is faster:

![Speedup against Map by workload, one point per runtime, on a log
scale](assets/speedup.svg)

Rows are ordered by how much the table wins. The five points on a row are the
same library on five engines, so their spread is `Map` varying, not the table.

| workload | Bun 1.3.14 | Node 24.15.0 | Deno 2.9.4 | Chrome 151 | Firefox 153 |
| --- | --- | --- | --- | --- | --- |
| fill, sparse (pre-sized) | 5.2x | 6.2x | 5.0x | 3.6x | 4.7x |
| fill, sparse (grown from empty) | 1.59x | 2.3x | 1.93x | 1.37x | 2.1x |
| fill, dense (pre-sized) | 4.0x | 4.1x | 3.2x | 2.4x | 3.6x |
| lookup hit, sparse | 1.50x | 2.7x | 2.8x | 2.3x | 1.60x |
| lookup miss, sparse | 1.29x | 3.2x | 3.4x | 2.5x | 1.70x |
| lookup hit, dense | 1.08x | 1.67x | 1.77x | 1.33x | 1.25x |
| lookup miss, dense | 0.89x | 1.79x | 1.89x | 1.94x | 1.38x |
| `has`, sparse | 1.77x | 3.2x | 3.5x | 2.9x | 1.86x |
| overwrite an existing key | 2.2x | 2.5x | 2.5x | 2.2x | 2.8x |
| delete | 6.1x | 5.5x | 5.8x | 4.1x | 4.7x |
| churn (delete + reinsert) | 3.3x | 3.6x | 3.5x | 2.6x | 3.2x |
| count (`increment`) | 1.26x | 1.33x | 1.35x | 1.28x | 0.89x |
| `getOrInsert`, key absent | 5.3x | 6.3x | 5.4x | 5.0x | 5.1x |
| u32 bulk fill (`setMany`) | 8.4x | 11x | 8.3x | 7.6x | 9.2x |
| u32 bulk lookup (`getMany`) | 2.7x | 5.6x | 4.9x | 5.4x | 3.6x |
| u64 bulk fill (`setMany`) | 10x | 9.7x | 8.6x | 6.4x | 8.5x |
| u64 bulk lookup (`getMany`) | 2.1x | 4.1x | 3.8x | 3.6x | 2.3x |
| u64 bulk delete (`deleteMany`) | 7.1x | 12x | 9.1x | — | — |
| iterate (`forEach`) | 2.6x | 0.78x | 0.75x | 0.73x | 1.38x |
| string keys, repeated lookup | 0.34x | 0.49x | 0.44x | 0.42x | 0.72x |

The same rows as nanoseconds per operation, SwissTable / `Map`:

| workload | Bun 1.3.14 | Node 24.15.0 | Deno 2.9.4 | Chrome 151 | Firefox 153 |
| --- | --- | --- | --- | --- | --- |
| fill, sparse (pre-sized) | 8.5 / 43.9 | 11.4 / 70.6 | 11.5 / 57.7 | 13.3 / 47.6 | 12.4 / 58.0 |
| fill, sparse (grown from empty) | 27.5 / 43.9 | 30.5 / 70.6 | 30.0 / 57.7 | 34.7 / 47.6 | 28.2 / 58.0 |
| fill, dense (pre-sized) | 8.8 / 35.7 | 11.4 / 46.2 | 11.1 / 35.1 | 12.6 / 29.8 | 11.4 / 40.6 |
| lookup hit, sparse | 7.4 / 11.1 | 9.9 / 26.4 | 9.4 / 26.8 | 11.1 / 26.0 | 12.2 / 19.5 |
| lookup miss, sparse | 8.7 / 11.2 | 10.2 / 32.3 | 10.1 / 34.0 | 11.4 / 28.3 | 12.2 / 20.8 |
| lookup hit, dense | 7.3 / 7.8 | 9.9 / 16.5 | 9.5 / 16.8 | 10.9 / 14.5 | 10.7 / 13.5 |
| lookup miss, dense | 8.0 / 7.2 | 10.0 / 18.0 | 9.7 / 18.4 | 10.8 / 21.0 | 10.6 / 14.7 |
| `has`, sparse | 6.3 / 11.2 | 8.2 / 26.6 | 7.8 / 27.2 | 9.0 / 25.8 | 10.2 / 18.9 |
| overwrite an existing key | 6.8 / 14.8 | 10.4 / 25.8 | 10.1 / 25.6 | 11.4 / 25.5 | 10.8 / 30.8 |
| delete | 5.7 / 35.0 | 9.4 / 52.4 | 7.9 / 45.5 | 10.2 / 41.3 | 8.4 / 39.8 |
| churn (delete + reinsert) | 10.4 / 34.5 | 13.4 / 47.5 | 13.1 / 46.1 | 15.3 / 40.2 | 13.7 / 44.4 |
| count (`increment`) | 6.7 / 8.4 | 9.4 / 12.5 | 9.2 / 12.4 | 10.9 / 13.8 | 13.0 / 11.6 |
| `getOrInsert`, key absent | 8.8 / 46.5 | 12.0 / 75.9 | 12.0 / 64.2 | 13.7 / 68.9 | 12.6 / 64.2 |
| u32 bulk fill (`setMany`) | 6.1 / 51.2 | 6.4 / 70.3 | 6.9 / 56.7 | 6.3 / 47.7 | 6.6 / 60.8 |
| u32 bulk lookup (`getMany`) | 3.9 / 10.5 | 4.0 / 22.5 | 4.9 / 24.0 | 4.2 / 22.6 | 4.4 / 16.1 |
| u64 bulk fill (`setMany`) | 7.3 / 73.5 | 8.0 / 77.5 | 8.3 / 71.7 | 7.8 / 50.5 | 7.8 / 66.4 |
| u64 bulk lookup (`getMany`) | 5.1 / 10.6 | 5.7 / 23.6 | 6.5 / 24.9 | 7.0 / 24.9 | 7.0 / 16.1 |
| u64 bulk delete (`deleteMany`) | 4.2 / 30.0 | 4.2 / 49.0 | 4.7 / 42.6 | — | — |
| iterate (`forEach`) | 6.6 / 17.0 | 13.2 / 10.3 | 13.8 / 10.4 | 12.9 / 9.4 | 6.0 / 8.3 |
| string keys, repeated lookup | 26.5 / 9.1 | 37.6 / 18.5 | 29.0 / 12.7 | 27.3 / 11.4 | 98.0 / 70.5 |

`Map` columns are `Map<number, number>`, or `Map<number, {lo,hi}>` for the
u64 rows. A `Map<number, bigint>` is worse again, 61 to 106 ns to fill,
because every value is boxed.

One row does not share the others' working set. **`count (increment)` is
100,000 increments over 1,000 distinct keys**, because a counter that never
sees a key twice is not a counter. Those 1,000 entries fit in cache, which is
why `Map` costs 8.4–13.8 ns there against the 26–34 it costs at 100,000
keys, and why it is the only row a browser engine takes.

Read the table column by column, not row by row. The SwissTable numbers move
little between engines: a sparse lookup hit costs 7.4–12.2 ns everywhere,
because the work is a WASM call and two memory accesses no engine is involved
in. `Map` moves a lot, 11.1 ns on JavaScriptCore against 26–27 ns on V8, and
that is what makes the same library look 1.50x faster on Bun and 2.8x faster
on Deno.

## Mutation, not lookup, is where the margin is

Lookup is the workload most often benchmarked and the one these tables win
least. The spread opens on everything that writes.

`delete` is 4.1x to 6.1x. `Map` unlinks an entry from its insertion-ordered
chain and eventually compacts it; a control byte here goes from its
fingerprint to `DELETED` and nothing else moves. Churn, meaning delete a key
and put it straight back, is 2.6x to 3.6x, and holds capacity while doing it,
because a re-insert reclaims the tombstone without consuming growth.

`has` is cheaper than `get` on the same table on every runtime: both cross
once and probe identically, and the difference is only the latched result
that `get` reads back out of linear memory.

Key distribution costs the table nothing: dense, sparse and
scattered-but-small keys all look up at the same speed, because the Murmur3
finalizer spreads every input bit before the hash is split. See
[design.md](design.md#hash-splitting). The dense rows are closer because
`Map` is faster there, not because the table is slower. On JavaScriptCore a
dense miss is the one row `Map` wins outright, at 7.2 ns against 8.0.

Neither is the right answer for dense keys anyway: a directly-indexed
`Int32Array` fills at 0.9–1.3 ns and looks up at 0.6–0.7 ns on every runtime,
and a plain object looks up at 0.5–0.8 ns. If the keys really are dense, use
the array.

## Reading and writing in one crossing

`increment` and `getOrInsert` fold a read and a write into a single call, so
they pay one crossing and probe once where the obvious spelling pays two of
each. Nanoseconds per key, against the alternative written out beside it:

| workload | Bun 1.3.14 | Node 24.15.0 | Deno 2.9.4 | Chrome 151 | Firefox 153 |
| --- | --- | --- | --- | --- | --- |
| `increment` | 6.7 | 9.4 | 9.2 | 10.9 | 13.0 |
| `get` + `set` | 12.0 | 15.6 | 15.0 | 17.9 | 16.2 |
| `getOrInsert`, key absent | 8.8 | 12.0 | 12.0 | 13.7 | 12.6 |
| `get`, then `set` if absent | 10.8 | 14.8 | 14.9 | 17.7 | 15.4 |
| `getOrInsert`, key present | 6.7 | 9.4 | 9.6 | 11.6 | 10.6 |
| `get`, then `set` if absent | 6.0 | 9.4 | 8.8 | 10.7 | 9.2 |

`increment` wins on every engine, 1.25x on SpiderMonkey and 1.6–1.8x
elsewhere, because the read and the write are one operation whichever way the
key falls.

**`getOrInsert` only wins when the key is absent**, and the last two rows are
why: `get`-then-`set` puts its second crossing inside the `undefined` branch,
so on a hit it never issues one and the two tie. Its gain therefore tracks
the miss rate: 1.22x to 1.29x when nothing is present, nothing when
everything is. Reach for it where misses are common, which is what memoizing
is.

Against `Map` the counting row is the one place a browser engine wins: 0.89x
on Firefox, 1.26x to 1.35x everywhere else. The working set is 1,000 keys,
small enough that `Map` stays in cache and the crossing is most of the
budget. It is the same effect the crossover section describes, seen from the
other side.

## Memory

Bytes per entry on the JavaScript heap, measured at 500,000 entries with each
container built once in a process of its own:

| container | Bun 1.3.14 | Node 24.15.0 | Deno 2.9.4 |
| --- | --- | --- | --- |
| `Map<number, number>` | 67.1 B | 37.4 B | 37.4 B |
| `Object` (numeric keys) | 50.3 B | 58.4 B | 58.3 B |
| `Map<number, {lo,hi}>` | 99.1 B | 77.4 B | 77.4 B |
| `Map<number, bigint>` | 99.1 B | 61.4 B | 61.4 B |

The tables are not on that heap and are not measured the same way. Their
footprint is layout rather than allocation: a slot costs 18 B in the u32
module and 26 B in the u64 module, counting both banks. At the 7/8 load
ceiling that is

| | per slot | per entry, both banks | per entry, live bank |
| --- | --- | --- | --- |
| `SwissU32ToU32` | 18 B | 20.6 B | 10.3 B |
| `SwissU32ToU64` | 26 B | 29.7 B | 14.9 B |

A rehash needs somewhere to move entries to, so a second bank exists, but
only one holds entries at a time. The live-bank column is what the data
occupies; the both-banks column is what the module addresses while a rehash
is in flight. Against `Map`'s 37.4 B on V8 that is 3.6x less live, or 1.8x
less counting the standby bank. Against JavaScriptCore's 67.1 B, 6.5x and
3.3x.

**An instance grows with its table.** It starts at 1.25 MiB of linear memory
for the u32 module and 1.75 MiB for the u64 one, then adds 9 or 13 bytes per
slot as the table reaches each new bank. Resident memory at 500,000 entries
on Node:

| | pre-sized with `create(500_000)` | grown from empty |
| --- | --- | --- |
| `SwissU32ToU32` | +10.8 MiB | +20.6 MiB |
| `SwissU32ToU64` | +16.5 MiB | +23.6 MiB |

Pre-sizing is worth roughly half the memory as well as the rehashes: a table
that grows into its capacity keeps the pages of the banks it passed through.
Memory is never returned, so an instance holds the high-water mark of every
bank it used, measured at 1.8x to 1.9x the final bank across a fill.

Every table is its own module instance, and each declares a `--max-memory`
at its ceiling: 3.4 GiB for u32, 2.4 GiB for u64. That is address space the
host reserves without committing, but a 32-bit or memory-constrained host
may decline it at instantiation. Build with a lower
`SWISS_MAX_CAPACITY_LOG2` to shrink what the module asks for.

A resident-set reading is the wrong instrument for the comparison, and
`--scenario=memory` reports it only as a cross-check. It counts a WASM bank
in full the moment it is touched, while a `Map` disappears into heap pages
the engine had already committed. Measured that way Deno reports its `Map` at
15.5 B/entry, which is not a property of the `Map`.

## Why: the cost model

A single-key operation costs

```text
T = c + g + r + a * mu(N)
```

| term | what it is | measured |
| --- | --- | --- |
| `c` | JS -> WASM boundary crossing | 0.8 ns (0 args), 2.6 ns (1 int32 arg) |
| `g` | key validation in the binding | 0.37 ns |
| `r` | reading the latched result from linear memory | 0.23 ns |
| `a` | serialized random memory accesses on the critical path | 2 |
| `mu(N)` | mean latency of one such access, set by working-set size | 1–10 ns |

Those terms are measured on JavaScriptCore; `c` is what differs most between
engines, and it is visible in the tables above as the ~2 ns the V8 hosts add
to every single-key row.

`Map` pays no `c`, `g`, or `r`, and has `a = 2` as well — bucket table, then
entry record. **So these tables win only when their smaller working set makes
`mu(N)` enough smaller to repay the crossing**, or when the engine's own
`Map` is slow enough that the crossing never mattered. An entry costs 10.3 B
in the live bank against `Map`'s measured 37–67 B, so the advantage arrives
when `Map` spills a cache level and the table does not.

Three implementation decisions follow directly from this model:

- **Key and value share one record** (`Entry` in the C sources). Separate key
  and value arrays put them on different cache lines, making `a = 3` and
  costing a whole extra memory round trip per hit.
- **Lookups latch their result in linear memory** rather than returning it.
  `has_get()` reports presence and the value is read through a cached
  typed-array view, so `a` stays 2 and `c` is paid once instead of twice.
- **Lookups never return a packed u64.** One call beats two only until the
  return value has to be boxed as a `BigInt`, which costs more than a second
  crossing.

## Where the caller's keys are stored

A JavaScript number at or above `2^31` cannot be tagged as a machine int32.
Every binding therefore validates with `(x >>> 0) === x` and passes `x | 0`:
WASM `i32` parameters are untyped bit patterns and the C side reads them as
`uint32_t`, so passing the signed reinterpretation is free and exact.

That removes any difference between low and high `u32` keys, but it cannot
reach the caller's own element load (`bun run bench --scenario=tagging`):

| key source | Bun | Node | Deno |
| --- | --- | --- | --- |
| `Uint32Array`, keys `< 2^31` | 6.4 ns | 8.0 ns | 7.7 ns |
| `Uint32Array`, keys `>= 2^31` | 6.2 ns | 8.1 ns | 7.6 ns |
| plain `Array` (always a double) | 10.5 ns | 9.2 ns | 8.3 ns |

Keys held in a plain `Array` are already boxed doubles before the binding
sees them, and unboxing them costs ~1.6x on JavaScriptCore against ~1.1x on
V8. Keep keys in a typed array. It is free where it does not matter and worth
a lot where it does.

## Why fill is measured twice

`Map` and `Object` cannot be pre-sized in JavaScript. They always grow from
empty and pay for every internal rehash inside the timed region, so timing
only a pre-sized table would compare against containers handed their final
capacity for free.

Growing from empty costs about 3x: 27.5 ns against 8.5 on Bun, 30.5 against
11.4 on Node. That is the price of rehashing through 11 doublings, 64 to
131,072 slots, each re-probing every live entry. It still beats `Map` by
1.37x to 2.3x, so the ranking never depended on the advantage. Pre-size
anyway when the count is known. It is the cheapest optimization available
here, and it also halves the memory the table ends up holding.

Lookups need only one row: a grown table converges on exactly the capacity a
pre-sized one starts with — both reach 131,072 slots at 100,000 entries — so
the working set is identical either way.

## How fast a batch amortizes its crossing

A bulk call stages a whole batch and crosses once per chunk, so the crossing
divides by the batch size. Both curves are the same 100,000 keys; only the
batch handed to one call changes:

| batch | `getMany` (Bun / Node / Deno) | `setMany` (Bun / Node / Deno) |
| --- | --- | --- |
| 1 | 195 / 149 / 145 ns | 195 / 157 / 150 ns |
| 8 | 27.1 / 22.1 / 21.8 ns | 32.6 / 24.8 / 25.4 ns |
| 64 | 6.9 / 6.6 / 7.3 ns | 11.8 / 10.0 / 10.8 ns |
| 512 | 5.0 / 4.5 / 5.6 ns | 7.9 / 8.4 / 9.0 ns |
| 4,096 | 4.6 / 4.3 / 5.3 ns | 7.4 / 7.9 / 8.2 ns |
| 100,000 | 4.6 / 4.9 / 5.9 ns | 7.2 / 7.8 / 8.3 ns |

A batch of 1 is worse than the per-key API, paying the staging setup with
nothing to divide it into. From ~512 the crossing has stopped mattering, and
past ~4,096 the curve is flat: there is no reason to hand-tune batch sizes
above that, and `maxBatch` chunking makes larger batches free anyway.

## Load factor barely matters; capacity does

Holding entries fixed at 50,000 and varying capacity:

| load | slots | Bun | Node | Deno |
| --- | --- | --- | --- | --- |
| 76% | 65,536 | 7.4 ns | 9.0 ns | 8.9 ns |
| 38% | 131,072 | 7.2 ns | 8.8 ns | 8.6 ns |
| 19% | 262,144 | 8.6 ns | 10.2 ns | 10.0 ns |
| 10% | 524,288 | 10.1 ns | 12.2 ns | 11.7 ns |

Running at the 7/8 load factor costs nothing against running half empty. The
group scan resolves in its first iteration either way. What does cost is the
control array outgrowing cache: at 10% full the table is 32% to 36% slower
than at 76%. Over-reserving costs memory as well as speed, so size
`expectedEntries` to what you expect rather than padding it.

## Whole-table operations

| operation | Bun | Node | Deno |
| --- | --- | --- | --- |
| `clear()` | 5.6 µs | 4.1 µs | 3.4 µs |
| `shrinkToFit()` after emptying | 144 µs | 59 µs | 60 µs |
| `reserve()` forcing one rehash | 1.75 ms | 1.49 ms | 1.48 ms |

`clear()` is a memset of the control bytes. The other two rehash, and a
rehash is the expensive thing in this design. That is the whole argument for
passing `expectedEntries` up front.

Capacity only ever rises on its own, and a scan visits every slot, so a table
that peaked large and was then emptied keeps paying peak walk cost until
`shrinkToFit()` hands the slots back. Walking the 8 entries left from a peak
of 100,000 costs 72–131 µs before the call and 1.3–1.9 µs after it. It
recovers walk cost, not memory: the pages stay with the instance.

## Iteration is the one place the engine changes the answer

| walk | Bun | Node | Deno | Chrome | Firefox |
| --- | --- | --- | --- | --- | --- |
| `keys()` | 8.4 ns | 8.0 ns | 7.9 ns | 6.5 ns | 6.2 ns |
| `forEach` | 6.6 ns | 13.2 ns | 13.8 ns | 12.9 ns | 6.0 ns |
| `Map.forEach` | 17.0 ns | 10.3 ns | 10.4 ns | 9.4 ns | 8.3 ns |
| u64 `forEachLanes`, lanes kept | 3.6 ns | 12.4 ns | 12.9 ns | 13.1 ns | 6.1 ns |
| u64 `forEach`, lanes kept | 7.2 ns | 14.8 ns | 17.1 ns | 15.7 ns | 12.6 ns |

`forEach` beats `Map.forEach` by 2.6x on JavaScriptCore and loses to it by
28% to 37% on V8, where the per-entry callback through the WASM scan costs
more than V8's own iteration. `keys()` is within 8.4 ns everywhere and is the
walk to reach for when the values are not needed.

`forEachLanes` exists for the u64 table because the boxed `{lo, hi}` object
is only free while the JIT can prove it does not outlive the call. A caller
that keeps the lanes does not let it prove that, and the lane-wise callback
is then faster on every engine: 19% to 33% on V8, and about 2x on
JavaScriptCore and SpiderMonkey.

## The two limits that cannot be engineered away

### Small tables: the crossing is the whole budget

`T >= c`, and a crossing does no work at all. Below the crossover both
containers are cache-resident, `mu(N)` is near zero for both, and the
crossing is pure overhead. Where that crossover sits is an engine question,
because it depends on how fast the engine's own `Map` is:

| entries | Bun 1.3.14 | Node 24.15.0 | Deno 2.9.4 | Chrome 151 | Firefox 153 |
| --- | --- | --- | --- | --- | --- |
| 2,000 | 0.65x | 0.77x | 1.03x | 0.80x | 0.35x |
| 8,000 | 0.94x | 1.81x | 2.71x | 2.26x | 1.69x |
| 16,000 | 1.37x | 2.76x | 2.98x | 2.61x | 1.80x |
| 32,000 | 1.26x | 2.82x | 3.08x | 2.70x | 1.79x |
| 128,000 | 1.46x | 2.91x | 3.13x | 2.74x | 1.88x |
| 512,000 | 1.65x | 2.81x | 3.27x | 2.66x | 1.63x |

![Speedup against Map as the table grows, one line per runtime, crossing 1x
between 2,000 and 16,000 entries](assets/crossover.svg)

Every line rises steeply and then flattens: once the table outgrows cache the
advantage stops growing, because both containers are paying `mu(N)` by then.

Below ~2,000 entries `Map` wins nearly everywhere, and on SpiderMonkey it
wins by 3x. By 8,000 the table is ahead on every engine except
JavaScriptCore, which crosses over near 10,000. Above ~16,000 entries the
table wins everywhere. If a single number is needed: **below 2,000 use
`Map`, above 16,000 use the table, and in between measure your own engine.**

### String keys: an asymmetry in what the engine caches

JavaScript engines cache a string's hash on the string object, so a
`Map<string, V>` lookup rehashes nothing. Any WASM-side string table must
copy and hash the bytes — `O(len)` against `O(1)`, per lookup — and no
implementation choice removes that asymmetry.

`InternedSwissMap` is therefore 1.4x to 2.9x slower than `Map<string, number>`
on repeated string lookups, on every engine, and always will be. Its purpose
is different: intern once, then use the u32 ID for every subsequent
operation, at which point the hot path is the numeric table and the string
never appears again. See
[`examples/03-string-pool.ts`](../examples/03-string-pool.ts).

## Reproducing

```bash
bun run build

bun run bench        # this runtime, all scenarios, text tables
bun run bench:all    # every runtime installed, three passes each
bun run bench:compare  # merge benches/results/*.json into these tables
```

The two charts are Vega-Lite specs with their data inlined, in
[`assets/`](assets/). Update them alongside the tables above and re-render
with:

```bash
bunx -p vega -p vega-lite vl2svg docs/assets/speedup.vl.json docs/assets/speedup.svg
bunx -p vega -p vega-lite vl2svg docs/assets/crossover.vl.json docs/assets/crossover.svg
```

`bun run bench` also runs under the other hosts directly, which is useful
when only one column is in question:

```bash
node --expose-gc benches/bench.ts --scenario=lookup
deno run --allow-read --allow-run --v8-flags=--expose-gc benches/bench.ts
bun run bench:browser --browser=firefox --scenario=lookup
```

`--scenario=memory` needs a host that reports its own heap, so it runs under
Bun, Node, and Deno and is skipped in a browser rather than reported from a
figure a page cannot take.

`benches/bench.ts` reports the median of 21 rounds after 3 warmups. Read-only
workloads replay until a round covers at least 2M operations, so harness
overhead stays negligible at small `N`; mutating workloads never replay,
since a second pass would overwrite rather than insert. Each contender is
measured in an isolate of its own — `--no-isolate` puts them back together,
which is faster and not comparable. `--scenario=<name,...>` runs a subset;
`--help` lists them, and `--json` emits the results as data, including the
engine, CPU, clock resolution, and collector availability the run was taken
under.
