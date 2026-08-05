# Performance

**These tables beat `Map` on `u32` keys above ~6k entries, by 1.2x to 9x,
with the widest margins on mutation rather than lookup. Below that threshold,
and for string keys, `Map` wins and no implementation change fixes it. For
dense keys a typed array beats both.**

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
figures as not. Three things about the harness are load-bearing:

- **Rounds are reduced by median, not by best-of.** A minimum over N rounds
  is biased low by an amount that grows with variance, and the contenders
  that vary most here do so because they allocate — so a best-of quietly
  writes off the collection they caused. `Map`'s 100k fill reads 71.2 ns/op
  as a best-of-7 and 46.2 as a best-of-21; the tables barely move. Garbage a
  container generates is part of what it costs.

- **Each contender is measured in a process of its own.** Contenders sharing
  one process specialize each other's inline caches on the library's call
  sites, which was worth up to 2.7x on a single row and inverted several
  rankings.
- **Keys are probed in a shuffled order, not insertion order.** `Map` keeps
  its entries in insertion order, so replaying that order walks its entry
  table sequentially; with dense integer keys its bucket index goes
  near-sequentially too. That is worth ~1.6 ns/op to `Map` on dense keys and
  ~0.2 ns to a table that hashes, so insertion-order probing compares a
  sequential scan against a random one.

## Results at 100k entries

| Workload | SwissTable | `Map` | Speedup |
| --- | --- | --- | --- |
| fill, sparse keys (pre-sized) | 7.8 ns | 68.7 ns | 8.8x |
| fill, sparse keys (grown) | 24.3 ns | 68.7 ns | 2.8x |
| fill, dense keys (pre-sized) | 8.8 ns | 62.6 ns | 7.1x |
| fill, dense keys (grown) | 25.1 ns | 62.6 ns | 2.5x |
| lookup hit, sparse | 6.9 ns | 11.3 ns | 1.6x |
| lookup miss, sparse | 7.7 ns | 11.2 ns | 1.5x |
| lookup hit, dense | 6.9 ns | 8.1 ns | 1.2x |
| lookup miss, dense | 7.6 ns | 7.1 ns | 0.9x |
| `has`, sparse | 5.4 ns | 11.1 ns | 2.1x |
| overwrite an existing key | 6.3 ns | 14.5 ns | 2.3x |
| delete | 5.5 ns | 31.0 ns | 5.6x |
| churn, delete + reinsert | 10.1 ns | 33.1 ns | 3.3x |
| u64 bulk fill, `setMany` | 7.4 ns | 56.4 ns | 7.6x |
| u64 bulk lookup, `getMany` | 7.0 ns | 10.5 ns | 1.5x |
| u64 bulk delete, `deleteMany` | 4.9 ns | 29.3 ns | 6.0x |

`Map` columns are `Map<number, number>`, or `Map<number, {lo,hi}>` for the
u64 rows. A `Map<number, bigint>` is worse again — 84.0 ns to fill, because
every value is boxed.

## Mutation, not lookup, is where the margin is

Lookup is the workload everyone benchmarks and the one where these tables win
least: 1.6x on a hit, and `Map` actually takes dense-key misses. The spread
opens on everything that writes.

`delete` is 5.6x. `Map` has to unlink an entry from its insertion-ordered
chain and eventually compact it; a control byte here goes from its
fingerprint to `DELETED` and nothing else moves. Churn — delete a key and put
it straight back — is 3.3x, and it holds capacity while doing it, because a
re-insert reclaims the tombstone without consuming growth.

`has` is 2.1x, and 1.3x cheaper than `get` on the same table: both cross once
and probe identically, and the difference is only the latched result `get`
reads back out of linear memory.

Dense keys cost the table nothing: measured in isolation it looks up dense,
sparse, and scattered-but-small keys at the same ~7.0 ns, and shuffling the
probe order moves it ~0.2 ns. That is the Murmur3 finalizer doing its job —
see [design.md](design.md#hash-splitting). The dense row is close only
because `Map` gets faster there, not because the table gets slower.

Neither is the right answer for dense keys anyway: a directly-indexed
`Int32Array` fills at 1.7 ns and looks up at 0.6 ns, and a plain object looks
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

The table above measures the argument forms at the boundary, including the
one the bindings deliberately do not use. Measured through the shipped API
instead — `bun run bench --scenario=tagging`, where every key is a valid
`u32` and the `| 0` is always applied:

| key source | `has(key)` |
| --- | --- |
| `Uint32Array`, keys `< 2^31` | 6.3 ns |
| `Uint32Array`, keys `>= 2^31` | 6.0 ns |
| plain `Array` (always a double) | 11.0 ns |

The cliff between low and high `u32` keys is gone, which is the mitigation
working: whatever a `Uint32Array` element is tagged as, the binding hands
WASM an int32. What survives is the plain-`Array` penalty, ~1.8x, because
that one is in the caller's own element load and no binding can reach it.
Keep keys in a typed array.

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
| 1 | 192.1 ns | 188.5 ns |
| 8 | 28.7 ns | 45.4 ns |
| 64 | 9.1 ns | 12.5 ns |
| 512 | 6.1 ns | 8.2 ns |
| 4,096 | 5.6 ns | 7.5 ns |
| 100,000 | 6.1 ns | 7.5 ns |

A batch of 1 is worse than the per-key API — it pays the staging setup with
nothing to divide it into. From ~512 the crossing has stopped mattering, and
past ~4,096 the curve is flat: there is no reason to hand-tune batch sizes
above that, and `maxBatch` chunking makes larger batches free anyway.

## Load factor barely matters; capacity does

Holding entries fixed at 50,000 and varying capacity:

| load | slots | lookup |
| --- | --- | --- |
| 76% | 65,536 | 7.2 ns |
| 38% | 131,072 | 7.1 ns |
| 19% | 262,144 | 8.8 ns |
| 10% | 524,288 | 10.5 ns |

Running at the 7/8 ceiling costs nothing against running half empty — the
group scan resolves in its first iteration either way. What does cost is the
control array outgrowing cache: at 10% full the table is 46% slower than at
76%. Over-reserving is not free, so size `expectedEntries` to what you expect
rather than padding it.

## Whole-table operations

| operation | cost at 100k entries |
| --- | --- |
| `clear()` | 5.6 us |
| `shrinkToFit()` after emptying | 184 us |
| `reserve()` forcing one rehash | 1.76 ms |

`clear()` is a memset of the control bytes. The other two rehash, and a
rehash is the expensive thing in this design — which is the whole argument
for passing `expectedEntries` up front.

## The two limits that cannot be engineered away

### Small tables: the crossing is the whole budget

`T >= c`, and `c` is ~2.6 ns for a crossing that does no work at all. An
L1-resident `Map` lookup costs ~3.6 ns in total, leaving ~1 ns for the entire
probe. Measured crossover is around 6k entries:

| entries | Swiss | `Map` | winner |
| --- | --- | --- | --- |
| 2,000 | 4.7 ns | 3.6 ns | Map |
| 4,000 | 5.1 ns | 4.1 ns | Map |
| 8,000 | 5.2 ns | 6.9 ns | SwissTable |
| 12,000 | 5.4 ns | 7.0 ns | SwissTable |
| 16,000 | 5.6 ns | 8.2 ns | SwissTable |
| 32,000 | 6.0 ns | 7.8 ns | SwissTable |
| 128,000 | 7.8 ns | 12.2 ns | SwissTable |
| 512,000 | 10.8 ns | 19.4 ns | SwissTable |

This table is measured standalone — one size per process, the loop inlined —
rather than by the bench's `scale-sweep` scenario, whose two smallest rows
read about twice this on the table's side. That defect is described at
`scaleSweep` in benches/bench.ts; it lands precisely where the crossover is
decided, so the crossover is not quoted from it.

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
