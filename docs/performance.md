# Performance

**These tables beat `Map` on every measured workload for `u32` keys above
~16k entries, by 1.1x to 9x. Below that threshold, and for repeated
string-key lookups, `Map` wins and no implementation change fixes it.**

Three things explain the whole picture:

1. A crossing into WASM costs ~2.6 ns before any work happens, so the tables
   need a working-set advantage large enough to repay it — which only exists
   once a table outgrows cache.
2. The largest single cost is not in the table at all. It is how JavaScript
   tags integer arguments, and it is worth ~14 ns per call if you get it
   wrong.
3. Batching moves the crossing off the per-key path entirely, which is why
   the bulk APIs show the widest margins.

Numbers are from `bun run bench` on x64 Linux, Bun 1.3.14, best of 7 rounds.
Treat the ratios as portable and the absolute figures as not.

## Results at 100k entries

| Workload | SwissTable | `Map` | Speedup |
| --- | --- | --- | --- |
| fill, sparse keys (pre-sized) | 7.3 ns | 65.5 ns | 9.0x |
| fill, sparse keys (grown) | 23.2 ns | 65.5 ns | 2.8x |
| fill, dense keys (pre-sized) | 9.3 ns | 38.5 ns | 4.1x |
| fill, dense keys (grown) | 23.4 ns | 38.5 ns | 1.6x |
| lookup hit, sparse | 6.0 ns | 10.2 ns | 1.7x |
| lookup miss, sparse | 8.4 ns | 11.4 ns | 1.4x |
| lookup hit, dense | 6.7 ns | 7.3 ns | 1.1x |
| u64 bulk fill, `setMany` | 6.9 ns | 40.7 ns | 5.9x |
| u64 bulk lookup, `getMany` | 6.2 ns | 10.4 ns | 1.7x |

Neither container is the right answer for dense keys: a directly-indexed
`Int32Array` fills at 0.4 ns and looks up at 0.5 ns, and a plain object looks
up at 1.8 ns. If the keys really are dense, use the array.

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

## The two limits that cannot be engineered away

### Small tables: the crossing is the whole budget

`T >= c`, and `c` is ~2.6 ns for a crossing that does no work at all. An
L1-resident `Map` lookup costs ~3.2 ns in total, leaving ~0.6 ns for the
entire probe. Measured crossover is around 16k entries:

| entries | Swiss | `Map` | winner |
| --- | --- | --- | --- |
| 2,000 | 5.8 ns | 3.2 ns | Map |
| 8,000 | 6.8 ns | 4.6 ns | Map |
| 16,000 | 7.1 ns | 8.1 ns | SwissTable |
| 128,000 | 9.0 ns | 11.8 ns | SwissTable |
| 512,000 | 12.9 ns | 13.5 ns | SwissTable |

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

`benches/bench.ts` reports the best of 7 rounds after 3 warmups. Read-only
workloads replay until a round covers at least 2M operations, so harness
overhead stays negligible at small `N`; mutating workloads never replay,
since a second pass would overwrite rather than insert. Contenders run
strictly one at a time — running them concurrently would interleave their
work inside each other's timed regions.
