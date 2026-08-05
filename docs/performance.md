# Performance

**These tables beat `Map` on sparse `u32` keys above ~8k entries, by 1.3x to
9x, with the widest margins on mutation rather than lookup. Below that
threshold, and for string keys, `Map` wins and no implementation change fixes
it. For dense keys a typed array beats both.**

Three things explain the whole picture:

1. A crossing into WASM costs ~2.6 ns before any work happens, so the tables
   need a working-set advantage large enough to repay it — which only exists
   once a table outgrows cache.
2. The largest single cost is not in the table at all. It is how JavaScript
   tags integer arguments, and it is worth ~14 ns per call if you get it
   wrong.
3. Batching moves the crossing off the per-key path entirely, which is why
   the bulk APIs show the widest margins.

Numbers are from `bun run bench` on x64 Linux, Bun 1.3.14, median of 21
rounds, median of three runs. Treat the ratios as portable and the absolute
figures as not. Three properties of the harness are load-bearing:

- **Rounds reduce by median, not best-of.** A minimum is biased low by an
  amount that grows with variance, and what varies most here is whatever
  allocates — so a best-of discounts the collection a container causes.
  Garbage is part of what a container costs.
- **Each contender runs in a process of its own.** Contenders sharing a
  process specialize each other's inline caches on the library's call sites.
- **Keys are probed in a shuffled order.** `Map` stores entries in insertion
  order, so replaying that order walks its entry table sequentially and, for
  dense integer keys, its bucket index too. Insertion-order probing compares
  a sequential scan against a random one.

## Results at 100k entries

| Workload | SwissTable | `Map` | Speedup |
| --- | --- | --- | --- |
| fill, sparse keys (pre-sized) | 7.9 ns | 71.1 ns | 9.0x |
| fill, sparse keys (grown) | 25.7 ns | 71.1 ns | 2.8x |
| fill, dense keys (pre-sized) | 9.0 ns | 65.6 ns | 7.3x |
| fill, dense keys (grown) | 25.5 ns | 65.6 ns | 2.6x |
| lookup hit, sparse | 8.1 ns | 12.0 ns | 1.5x |
| lookup miss, sparse | 9.1 ns | 12.1 ns | 1.3x |
| lookup hit, dense | 8.1 ns | 8.5 ns | 1.05x |
| lookup miss, dense | 8.6 ns | 7.9 ns | 0.9x |
| `has`, sparse | 6.7 ns | 12.1 ns | 1.8x |
| overwrite an existing key | 7.1 ns | 16.6 ns | 2.3x |
| delete | 5.7 ns | 38.7 ns | 6.8x |
| churn, delete + reinsert | 11.1 ns | 40.6 ns | 3.7x |
| u64 bulk fill, `setMany` | 8.1 ns | 58.5 ns | 7.2x |
| u64 bulk lookup, `getMany` | 7.1 ns | 11.4 ns | 1.6x |
| u64 bulk delete, `deleteMany` | 5.1 ns | 33.1 ns | 6.5x |

`Map` columns are `Map<number, number>`, or `Map<number, {lo,hi}>` for the
u64 rows. A `Map<number, bigint>` is worse again — 93.3 ns to fill, because
every value is boxed.

## Mutation, not lookup, is where the margin is

Lookup is the workload most often benchmarked and the one these tables win
least: 1.5x on a sparse hit, a dead heat on dense hits, and a loss on dense
misses. The spread opens on everything that writes.

`delete` is 6.8x. `Map` unlinks an entry from its insertion-ordered chain and
eventually compacts it; a control byte here goes from its fingerprint to
`DELETED` and nothing else moves. Churn — delete a key and put it straight
back — is 3.7x, and holds capacity while doing it, because a re-insert
reclaims the tombstone without consuming growth.

`has` is 1.8x against `Map`, and 1.2x cheaper than `get` on the same table:
both cross once and probe identically, and the difference is only the latched
result that `get` reads back out of linear memory.

Key distribution costs the table nothing: dense, sparse and
scattered-but-small keys all look up at the same speed, because the Murmur3
finalizer spreads every input bit before the hash is split — see
[design.md](design.md#hash-splitting). The dense rows are close because
`Map` is faster there, not because the table is slower.

Neither is the right answer for dense keys anyway: a directly-indexed
`Int32Array` fills at 1.2 ns and looks up at 0.6 ns, and a plain object looks
up at 0.5 ns. If the keys really are dense, use the array.

## Why: the cost model

A single-key operation costs

```
T = c + g + r + a * mu(N)
```

| term | what it is | measured |
| --- | --- | --- |
| `c` | JS -> WASM boundary crossing | 0.8 ns (0 args), 2.6 ns (1 int32 arg) |
| `g` | key validation in the binding | 0.37 ns |
| `r` | reading the latched result from linear memory | 0.23 ns |
| `a` | serialized random memory accesses on the critical path | 2 |
| `mu(N)` | mean latency of one such access, set by working-set size | 1–10 ns |

`Map` pays no `c`, `g`, or `r`, and has `a = 2` as well — bucket table, then
entry record. **So these tables win only when their smaller working set makes
`mu(N)` enough smaller to repay the crossing.** Entries cost ~10 B against
`Map`'s ~24–32 B, so the advantage arrives when `Map` spills a cache level
and the table does not.

Three implementation decisions follow directly from this model:

- **Key and value share one record** (`Entry` in the C sources). Separate key
  and value arrays put them on different cache lines, making `a = 3` and
  costing a whole extra memory round trip per hit.
- **Lookups latch their result in linear memory** rather than returning it.
  `has_get()` reports presence and the value is read through a cached
  typed-array view, so `a` stays 2 and `c` is paid once instead of twice.
- **Lookups never return a packed u64.** One call beats two only until the
  return value has to be boxed as a `BigInt`, which costs ~14 ns — more than
  a second crossing.

## What dominates: the int32 tagging cliff

A JavaScript number above `2^31 - 1` cannot be tagged as a machine int32, so
it reaches a WASM `i32` parameter as a boxed double and is converted at the
boundary:

| argument form | ns/op for `has(key)` |
| --- | --- |
| `keys[i]` — u32 value, `>= 2^31` | 16.97 |
| `keys[i] \| 0` — same 32 bits, int32-tagged | 2.83 |
| keys all below `2^31` | 2.71 |
| plain `Array` element (always a double) | 30.70 |

WASM `i32` parameters are untyped bit patterns and the C side reads them as
`uint32_t`, so passing the signed reinterpretation is free and exact. Every
binding therefore validates with `(x >>> 0) === x` and passes `x | 0`.
Without it, roughly 14 ns of every operation goes to converting the
argument — several times the cost of the lookup itself.

This is also why the caller's own key storage matters: keys held in a
`Uint32Array` or as small integers stay on the fast path, while keys held in
a plain `Array` are already doubles before the binding sees them.

That table measures the argument forms at the boundary, including the one the
bindings do not use. Through the shipped API, where the `| 0` is always
applied (`bun run bench --scenario=tagging`):

| key source | `has(key)` |
| --- | --- |
| `Uint32Array`, keys `< 2^31` | 6.9 ns |
| `Uint32Array`, keys `>= 2^31` | 6.5 ns |
| plain `Array` (always a double) | 11.8 ns |

There is no cliff between low and high `u32` keys: whatever a `Uint32Array`
element is tagged as, the binding hands WASM an int32. The plain-`Array`
penalty is ~1.8x and survives, because it is in the caller's own element load
where no binding can reach it. Keep keys in a typed array.

## Why fill is measured twice

`Map` and `Object` cannot be pre-sized in JavaScript. They always grow from
empty and pay for every internal rehash inside the timed region, so timing
only a pre-sized table would compare against containers handed their final
capacity for free.

Growing from empty costs 3.2x — 23.2 ns against 7.3 ns on sparse keys — the
price of rehashing through 11 doublings (64 to 131,072 slots), each
re-probing every live entry. It still beats `Map` by 2.8x, so the ranking
never depended on the advantage. Pre-size anyway when the count is known; it
is the cheapest optimization available here.

Lookups need only one row: a grown table converges on exactly the capacity a
pre-sized one starts with — both reach 131,072 slots at 100k entries — so the
working set is identical either way.

Dense fill costs ~1.8 ns more than it once did. `set` now confirms a key is
absent *before* deciding whether to grow, so that overwriting an existing key
on a table at its capacity ceiling succeeds instead of being rejected. The
price is that the confirming probe runs on the smaller, more heavily loaded
bank when a rehash is imminent, which dense fill triggers often. Correctness
over 1.8 ns.

## How fast a batch amortizes its crossing

A bulk call stages a whole batch and crosses once per chunk, so the crossing
divides by the batch size. Both curves are the same 100k keys; only the batch
handed to one call changes:

| batch | `getMany` | `setMany` |
| --- | --- | --- |
| 1 | 209.4 ns | 189.0 ns |
| 8 | 28.9 ns | 46.3 ns |
| 64 | 10.3 ns | 12.3 ns |
| 512 | 5.9 ns | 8.5 ns |
| 4,096 | 5.7 ns | 7.5 ns |
| 100,000 | 5.8 ns | 7.5 ns |

A batch of 1 is worse than the per-key API — it pays the staging setup with
nothing to divide it into. From ~512 the crossing has stopped mattering, and
past ~4,096 the curve is flat: there is no reason to hand-tune batch sizes
above that, and `maxBatch` chunking makes larger batches free anyway.

## Load factor barely matters; capacity does

Holding entries fixed at 50,000 and varying capacity:

| load | slots | lookup |
| --- | --- | --- |
| 76% | 65,536 | 7.9 ns |
| 38% | 131,072 | 8.0 ns |
| 19% | 262,144 | 9.1 ns |
| 10% | 524,288 | 10.9 ns |

Running at the 7/8 ceiling costs nothing against running half empty — the
group scan resolves in its first iteration either way. What does cost is the
control array outgrowing cache: at 10% full the table is 38% slower than at
76%. Over-reserving is not free, so size `expectedEntries` to what you expect
rather than padding it.

## Whole-table operations

| operation | cost at 100k entries |
| --- | --- |
| `clear()` | 5.8 us |
| `shrinkToFit()` after emptying | 166 us |
| `reserve()` forcing one rehash | 1.76 ms |

`clear()` is a memset of the control bytes. The other two rehash, and a
rehash is the expensive thing in this design — which is the whole argument
for passing `expectedEntries` up front.

## The two limits that cannot be engineered away

### Small tables: the crossing is the whole budget

`T >= c`, and `c` is ~2.6 ns for a crossing that does no work at all. An
L1-resident `Map` lookup costs ~4 ns in total, leaving ~1 ns for the entire
probe. Measured crossover is around 8k entries:

| entries | Swiss | `Map` | winner |
| --- | --- | --- | --- |
| 2,000 | 5.4 ns | 4.0 ns | Map |
| 8,000 | 6.3 ns | 6.0 ns | dead heat |
| 16,000 | 6.5 ns | 8.8 ns | SwissTable |
| 32,000 | 6.8 ns | 8.9 ns | SwissTable |
| 128,000 | 9.9 ns | 13.6 ns | SwissTable |
| 512,000 | 19.4 ns | 28.8 ns | SwissTable |

Below the crossover both containers are cache-resident, `mu(N)` is near zero
for both, and the crossing is pure overhead. Above it, the ~10 B/entry
against `Map`'s ~24–32 B keeps the table a cache level ahead.

### String keys: an asymmetry in what the engine caches

JavaScript engines cache a string's hash on the string object, so a
`Map<string, V>` lookup rehashes nothing. Any WASM-side string table must
copy and hash the bytes — `O(len)` against `O(1)`, per lookup — and no
implementation choice removes that asymmetry.

`InternedSwissMap` is therefore ~2.6x slower than `Map<string, number>` on
repeated string lookups (21.3 ns vs 8.3 ns), and always will be. Its purpose
is different: intern once, then use the u32 ID for every subsequent
operation, at which point the hot path is the numeric table and the string
never appears again. See
[`examples/03-string-pool.ts`](../examples/03-string-pool.ts).

## Reproducing

```bash
bun run build && bun run bench
```

`benches/bench.ts` reports the median of 21 rounds after 3 warmups. Read-only
workloads replay until a round covers at least 2M operations, so harness
overhead stays negligible at small `N`; mutating workloads never replay,
since a second pass would overwrite rather than insert. Each contender is
measured in a process of its own — `--no-isolate` puts them back in one
process, which is faster and not comparable. `--scenario=<name,...>` runs a
subset; `--help` lists them, and `--json` emits the results as data.
