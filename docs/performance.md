# Performance

**On sparse `u32` keys at 100,000 entries these tables beat `Map` on every
runtime measured — by 1.4x to 12x, with the widest margins on mutation and
bulk transfer rather than on lookup. Below ~2,000 entries `Map` wins nearly
everywhere; by 8,000 the tables are ahead on every engine except
JavaScriptCore, which crosses over near 10,000. For string keys `Map` wins
everywhere, and for dense keys a typed array beats both.**

Four things explain the whole picture:

1. A crossing into WASM costs a few nanoseconds before any work happens, so
   the tables need a working-set advantage large enough to repay it — which
   only exists once a table outgrows cache.
2. **`Map` is not one container.** JavaScriptCore's `Map` looks up a sparse
   `u32` key in 11.0 ns; V8's takes 25–26 ns for the same work. The tables
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
| Deno 2.9.4 | V8 | yes | 0.15 µs |
| Chrome 151 | V8 | yes | 5 µs |
| Firefox 152 | SpiderMonkey | no | 20 µs |

13th Gen Intel Core i9-13900K, Linux x64. 100,000 entries, median of 21
rounds, median of 3 passes, one isolate per contender. Treat the ratios
within a column as the portable part and the absolute figures as specific to
this machine — but not the ratios *across* columns, which is the point of
publishing five.

Five properties of the harness are load-bearing:

- **Every runtime executes the same scenario code.** `benches/runtime.ts`
  supplies the four things that differ between hosts — a nanosecond clock,
  module loading, isolation, and where results go — and the scenarios import
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
  scenarios, and vary more between passes than the server runtimes do —
  Chrome's sparse fill spans 9.7–14.3 ns across passes, where Bun's repeats
  at 7.8.

## Results at 100,000 entries

Speedup against `Map` — above 1.00x the table is faster:

| workload | Bun 1.3.14 | Node 24.15.0 | Deno 2.9.4 | Chrome 151 | Firefox 152 |
| --- | --- | --- | --- | --- | --- |
| fill, sparse (pre-sized) | 8.8x | 7.2x | 6.6x | 3.5x | 5.1x |
| fill, sparse (grown from empty) | 2.9x | 2.4x | 2.4x | 1.59x | 2.3x |
| fill, dense (pre-sized) | 7.3x | 4.7x | 3.9x | 3.1x | 3.9x |
| lookup hit, sparse | 1.55x | 3.2x | 3.6x | 3.0x | 1.76x |
| lookup miss, sparse | 1.40x | 3.7x | 3.8x | 2.8x | 1.72x |
| lookup hit, dense | 1.07x | 1.90x | 2.3x | 1.61x | 1.38x |
| lookup miss, dense | 0.86x | 2.1x | 2.1x | 2.2x | 1.38x |
| `has`, sparse | 1.89x | 3.7x | 4.2x | 3.6x | 2.1x |
| overwrite an existing key | 2.4x | 3.1x | 3.3x | 2.9x | 3.4x |
| delete | 5.6x | 6.2x | 6.3x | 5.0x | 4.4x |
| churn (delete + reinsert) | 3.3x | 3.9x | 4.0x | 3.1x | 2.8x |
| u64 bulk fill (`setMany`) | 6.4x | 11x | 8.3x | 5.4x | 9.3x |
| u64 bulk lookup (`getMany`) | 1.72x | 4.2x | 3.8x | 3.4x | 2.5x |
| u64 bulk delete (`deleteMany`) | 5.9x | 12x | 9.0x | — | — |
| iterate (`forEach`) | 2.3x | 0.80x | 0.76x | 0.74x | 1.42x |
| string keys, repeated lookup | 0.36x | 0.50x | 0.50x | 0.44x | 0.75x |

The same rows as nanoseconds per operation, SwissTable / `Map`:

| workload | Bun 1.3.14 | Node 24.15.0 | Deno 2.9.4 | Chrome 151 | Firefox 152 |
| --- | --- | --- | --- | --- | --- |
| fill, sparse (pre-sized) | 7.8 / 68.5 | 9.1 / 65.4 | 9.2 / 60.8 | 14.2 / 49.7 | 11.0 / 56.4 |
| fill, sparse (grown from empty) | 23.6 / 68.5 | 27.3 / 65.4 | 25.7 / 60.8 | 31.3 / 49.7 | 24.2 / 56.4 |
| fill, dense (pre-sized) | 8.8 / 64.6 | 9.3 / 43.8 | 9.3 / 36.1 | 9.8 / 30.1 | 9.8 / 38.0 |
| lookup hit, sparse | 7.1 / 11.0 | 8.2 / 26.3 | 7.0 / 25.6 | 8.6 / 25.3 | 11.0 / 19.4 |
| lookup miss, sparse | 8.1 / 11.3 | 8.7 / 32.0 | 8.6 / 32.3 | 9.5 / 26.8 | 12.0 / 20.7 |
| lookup hit, dense | 7.4 / 7.8 | 8.5 / 16.1 | 7.1 / 15.9 | 8.4 / 13.5 | 9.8 / 13.5 |
| lookup miss, dense | 8.1 / 6.9 | 8.4 / 17.8 | 8.2 / 17.0 | 9.1 / 20.2 | 10.4 / 14.4 |
| `has`, sparse | 5.7 / 10.8 | 6.9 / 25.6 | 6.0 / 25.1 | 6.9 / 24.8 | 8.9 / 18.9 |
| overwrite an existing key | 5.9 / 14.2 | 8.1 / 25.6 | 7.7 / 25.1 | 8.5 / 24.7 | 8.9 / 30.1 |
| delete | 5.4 / 30.1 | 8.0 / 49.2 | 6.7 / 42.1 | 7.9 / 39.9 | 8.0 / 35.0 |
| churn (delete + reinsert) | 9.8 / 32.1 | 11.9 / 46.0 | 11.3 / 44.5 | 12.5 / 39.2 | 14.8 / 41.3 |
| u64 bulk fill (`setMany`) | 7.4 / 47.1 | 7.1 / 77.6 | 7.9 / 65.3 | 8.8 / 47.7 | 7.2 / 66.8 |
| u64 bulk lookup (`getMany`) | 6.1 / 10.4 | 5.6 / 23.5 | 6.1 / 23.5 | 6.8 / 22.8 | 6.5 / 16.1 |
| u64 bulk delete (`deleteMany`) | 4.8 / 28.3 | 4.2 / 48.5 | 4.7 / 42.1 | — | — |
| iterate (`forEach`) | 7.3 / 16.9 | 13.2 / 10.5 | 13.6 / 10.3 | 12.6 / 9.3 | 5.8 / 8.3 |
| string keys, repeated lookup | 24.3 / 8.7 | 35.6 / 18.0 | 25.7 / 12.8 | 25.5 / 11.2 | 90.2 / 67.6 |

`Map` columns are `Map<number, number>`, or `Map<number, {lo,hi}>` for the
u64 rows. A `Map<number, bigint>` is worse again — 58 to 106 ns to fill,
because every value is boxed.

Read the table column by column, not row by row. The SwissTable numbers move
little between engines: a sparse lookup hit costs 7.0–11.0 ns everywhere,
because the work is a WASM call and two memory accesses no engine is involved
in. `Map` moves a lot — 11.0 ns on JavaScriptCore against 25–26 ns on V8 —
and that is what makes the same library look 1.55x faster on Bun and 3.6x
faster on Deno.

## Mutation, not lookup, is where the margin is

Lookup is the workload most often benchmarked and the one these tables win
least. The spread opens on everything that writes.

`delete` is 4.4x to 6.3x. `Map` unlinks an entry from its insertion-ordered
chain and eventually compacts it; a control byte here goes from its
fingerprint to `DELETED` and nothing else moves. Churn — delete a key and put
it straight back — is 2.8x to 4.0x, and holds capacity while doing it,
because a re-insert reclaims the tombstone without consuming growth.

`has` is cheaper than `get` on the same table on every runtime: both cross
once and probe identically, and the difference is only the latched result
that `get` reads back out of linear memory.

Key distribution costs the table nothing: dense, sparse and
scattered-but-small keys all look up at the same speed, because the Murmur3
finalizer spreads every input bit before the hash is split — see
[design.md](design.md#hash-splitting). The dense rows are closer because
`Map` is faster there, not because the table is slower — and on
JavaScriptCore a dense miss is the one row `Map` wins outright, at 6.9 ns
against 8.1.

Neither is the right answer for dense keys anyway: a directly-indexed
`Int32Array` fills at 0.9–1.2 ns and looks up at 0.6–0.7 ns on every runtime,
and a plain object looks up at 0.5–0.8 ns. If the keys really are dense, use
the array.

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

Two banks are reserved because a rehash needs somewhere to move entries to,
and both are static arrays at the compiled ceiling. Only one holds entries at
a time, so the live-bank column is what the data occupies and the both-banks
column is what the module reserves for it. Against `Map`'s 37.4 B on V8 that
is 3.6x less live, or 1.8x less counting the standby bank; against
JavaScriptCore's 67.1 B, 6.5x and 3.3x.

**An instance reserves its whole arena up front**: 20 MiB of linear memory
for the u32 module, 29 MiB for the u64 one, whether it holds one entry or
917,504. That is address space, committed page by page as the table touches
it, so what a process actually resides tracks the entries rather than the
reservation — 9 MiB at 500,000 u32 entries on Node. The reservation still
matters twice over: every table is its own module instance, so ten tables
reserve ten arenas, and a wasm32 module cannot exceed 4 GiB of them. Build a
second pair of modules with a lower `SWISS_MAX_CAPACITY_LOG2` when the
working set is known to be small — at `2^16` a u32 instance reserves 3.1 MiB
and caps at 57,344 entries.

A resident-set reading is the wrong instrument for the comparison and is
reported by `--scenario=memory` only as a cross-check: it counts a WASM arena
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
engines, and it is visible in the tables above as the ~1–2 ns the V8 hosts
add to every single-key row.

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
| `Uint32Array`, keys `< 2^31` | 5.8 ns | 6.5 ns | 6.0 ns |
| `Uint32Array`, keys `>= 2^31` | 5.6 ns | 6.6 ns | 6.2 ns |
| plain `Array` (always a double) | 9.8 ns | 7.6 ns | 6.6 ns |

Keys held in a plain `Array` are already boxed doubles before the binding
sees them, and unboxing them costs ~1.7x on JavaScriptCore against ~1.15x on
V8. Keep keys in a typed array; it is free where it does not matter and worth
a lot where it does.

## Why fill is measured twice

`Map` and `Object` cannot be pre-sized in JavaScript. They always grow from
empty and pay for every internal rehash inside the timed region, so timing
only a pre-sized table would compare against containers handed their final
capacity for free.

Growing from empty costs about 3x — 23.6 ns against 7.8 on Bun, 27.3 against
9.1 on Node — the price of rehashing through 11 doublings (64 to 131,072
slots), each re-probing every live entry. It still beats `Map` by 1.59x to
2.9x, so the ranking never depended on the advantage. Pre-size anyway when
the count is known; it is the cheapest optimization available here.

Lookups need only one row: a grown table converges on exactly the capacity a
pre-sized one starts with — both reach 131,072 slots at 100,000 entries — so
the working set is identical either way.

## How fast a batch amortizes its crossing

A bulk call stages a whole batch and crosses once per chunk, so the crossing
divides by the batch size. Both curves are the same 100,000 keys; only the
batch handed to one call changes:

| batch | `getMany` (Bun / Node / Deno) | `setMany` (Bun / Node / Deno) |
| --- | --- | --- |
| 1 | 179 / 153 / 138 ns | 164 / 157 / 144 ns |
| 8 | 24.9 / 21.0 / 20.7 ns | 41.8 / 24.8 / 24.8 ns |
| 64 | 8.7 / 6.3 / 6.9 ns | 11.7 / 9.5 / 10.7 ns |
| 512 | 5.2 / 4.3 / 5.2 ns | 7.9 / 8.6 / 8.6 ns |
| 4,096 | 4.8 / 4.2 / 5.1 ns | 7.4 / 7.0 / 8.0 ns |
| 100,000 | 5.2 / 4.8 / 5.5 ns | 7.3 / 7.2 / 9.3 ns |

A batch of 1 is worse than the per-key API — it pays the staging setup with
nothing to divide it into. From ~512 the crossing has stopped mattering, and
past ~4,096 the curve is flat: there is no reason to hand-tune batch sizes
above that, and `maxBatch` chunking makes larger batches free anyway.

## Load factor barely matters; capacity does

Holding entries fixed at 50,000 and varying capacity:

| load | slots | Bun | Node | Deno |
| --- | --- | --- | --- | --- |
| 76% | 65,536 | 6.7 ns | 7.0 ns | 6.7 ns |
| 38% | 131,072 | 6.6 ns | 6.7 ns | 6.4 ns |
| 19% | 262,144 | 7.7 ns | 8.1 ns | 7.6 ns |
| 10% | 524,288 | 9.9 ns | 10.4 ns | 9.2 ns |

Running at the 7/8 ceiling costs nothing against running half empty — the
group scan resolves in its first iteration either way. What does cost is the
control array outgrowing cache: at 10% full the table is ~40% slower than at
76%. Over-reserving is not free, so size `expectedEntries` to what you expect
rather than padding it.

## Whole-table operations

| operation | Bun | Node | Deno |
| --- | --- | --- | --- |
| `clear()` | 4.3 µs | 3.1 µs | 3.4 µs |
| `shrinkToFit()` after emptying | 164 µs | 67 µs | 71 µs |
| `reserve()` forcing one rehash | 1.54 ms | 1.48 ms | 1.44 ms |

`clear()` is a memset of the control bytes. The other two rehash, and a
rehash is the expensive thing in this design — which is the whole argument
for passing `expectedEntries` up front.

Capacity only ever rises on its own, and a scan visits every slot, so a table
that peaked large and was then emptied keeps paying peak walk cost until
`shrinkToFit()` hands the slots back: walking the 8 entries left from a peak
of 100,000 costs 41–72 µs before the call and 1.3–1.5 µs after it.

## Iteration is the one place the engine changes the answer

| walk | Bun | Node | Deno | Chrome | Firefox |
| --- | --- | --- | --- | --- | --- |
| `keys()` | 8.3 ns | 8.2 ns | 7.7 ns | 6.3 ns | 6.3 ns |
| `forEach` | 7.3 ns | 13.2 ns | 13.6 ns | 12.6 ns | 5.8 ns |
| `Map.forEach` | 16.9 ns | 10.5 ns | 10.3 ns | 9.3 ns | 8.3 ns |
| u64 `forEachLanes`, lanes kept | 4.8 ns | 12.1 ns | 12.0 ns | 12.0 ns | 6.1 ns |
| u64 `forEach`, lanes kept | 5.3 ns | 14.4 ns | 15.8 ns | 15.0 ns | 12.4 ns |

`forEach` beats `Map.forEach` by 2.3x on JavaScriptCore and loses to it by
about 25% on V8, where the per-entry callback through the WASM scan costs
more than V8's own iteration. `keys()` is within 8.3 ns everywhere and is the
walk to reach for when the values are not needed.

`forEachLanes` exists for the u64 table because the boxed `{lo, hi}` object
is only free while the JIT can prove it does not outlive the call. A caller
that keeps the lanes does not let it prove that, and the lane-wise callback
is then faster on every engine — by 10% on Bun and by 2x on Firefox.

## The two limits that cannot be engineered away

### Small tables: the crossing is the whole budget

`T >= c`, and a crossing does no work at all. Below the crossover both
containers are cache-resident, `mu(N)` is near zero for both, and the
crossing is pure overhead. Where that crossover sits is an engine question,
because it depends on how fast the engine's own `Map` is:

| entries | Bun 1.3.14 | Node 24.15.0 | Deno 2.9.4 | Chrome 151 | Firefox 152 |
| --- | --- | --- | --- | --- | --- |
| 2,000 | 0.71x | 0.83x | 1.30x | 0.94x | 0.34x |
| 8,000 | 0.95x | 1.89x | 3.29x | 2.75x | 1.72x |
| 16,000 | 1.42x | 3.46x | 3.76x | 3.09x | 1.86x |
| 32,000 | 1.28x | 3.71x | 3.89x | 3.32x | 1.96x |
| 128,000 | 1.52x | 3.34x | 3.89x | 3.30x | 1.99x |
| 512,000 | 1.54x | 3.10x | 3.53x | 2.83x | 1.74x |

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

`InternedSwissMap` is therefore 1.3x to 2.8x slower than `Map<string, number>`
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
