# swisstable

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/bun-1.3%2B-black.svg)](https://bun.com)
[![TypeScript](https://img.shields.io/badge/typescript-7.0%2B-3178c6.svg)](https://www.typescriptlang.org/)

SIMD SwissTable hash maps that live entirely inside WebAssembly linear memory,
with thin TypeScript bindings.

**For `u32` keys above ~16k entries, these tables are 1.1–9x faster than
`Map` on every workload measured.** Below that threshold, or with string
keys, `Map` wins and you should use it — both limits are structural, and
[quantified below](#when-not-to-use-this).

Keys, values, control bytes, and probing never cross the JavaScript boundary,
so a lookup costs one WASM call, and a bulk operation costs one call per
chunk regardless of batch size.

```ts
import { readFile } from "node:fs/promises";
import { SwissU32ToU32 } from "swisstable";

const wasm = await readFile(new URL(import.meta.resolve("swisstable/swiss_u32.wasm")));
const table = await SwissU32ToU32.load(wasm, 100_000);

table.set(0xdead_beef, 42);
table.get(0xdead_beef); // 42
```

## Contents

- [Why](#why) · [When not to use this](#when-not-to-use-this)
- [Install](#install) · [Quick start](#quick-start) · [API](#api)
- [Benchmarks](#benchmarks) · [How it works](#how-it-works)
- [Contributing](#contributing) · [License](#license)

Full documentation:

| Doc | Covers |
| --- | --- |
| [docs/api.md](docs/api.md) | Every export, method, and thrown error |
| [docs/design.md](docs/design.md) | Control bytes, probing, banks, memory layout, build |
| [docs/performance.md](docs/performance.md) | Cost model, benchmarks, the two structural limits |
| [examples/](examples/README.md) | Four runnable programs |

## Why

**Smaller working set.** Entries cost ~10 B against `Map`'s ~24–32 B. Once a
table is large enough that `Map` spills a cache level and this one does not,
every lookup saves a memory round trip — which is why the advantage grows
with entry count rather than staying a fixed factor.

**One boundary crossing per operation.** Lookups latch their result in linear
memory and the binding reads it through a cached typed-array view, so
presence and value arrive together without a second call and without boxing a
`BigInt`.

**Batches amortize the crossing.** `setMany`/`getMany`/`deleteMany` stage a
whole batch into memory the module owns and cross once. This is the widest
margin in the suite: 6.9 ns/op against `Map`'s 40.7 for a 100k-entry fill.

**No allocator, no surprises.** The modules link `-nostdlib` with fixed
linear memory and never call `memory.grow`, so views are built once and never
detach, and there is no allocation on any hot path.

## When not to use this

There is no free lunch. Two workloads `Map` wins, for reasons no amount of
tuning removes:

| Situation | Use instead | Why |
| --- | --- | --- |
| Fewer than ~16k entries | `Map` | A boundary crossing costs ~2.6 ns before doing any work; a cache-resident `Map` lookup costs ~3.2 ns in total. |
| String keys, looked up repeatedly | `Map<string, V>` | Engines cache a string's hash on the string object. A WASM table must copy and rehash the bytes: `O(len)` against `O(1)`. |
| Dense integer keys with no gaps | `Int32Array` | Direct indexing is 0.5 ns and needs no hashing at all. |
| Non-integer or `> 2^32 - 1` keys | `Map` | Keys and values are strictly unsigned 32-bit; anything else throws. |

`InternedSwissMap` still exists for string data, but its payoff is
intern-once-then-key-by-ID, not raw string lookup — see
[`examples/03-string-pool.ts`](examples/03-string-pool.ts).

## Install

```bash
npm install swisstable    # or bun add / pnpm add / yarn add
```

Ships compiled ESM with type declarations and the prebuilt `.wasm` modules.
Nothing is built on install and there are no runtime dependencies — it works
in Node, Bun, Deno, bundlers, and browsers alike.

The only requirement is WebAssembly with SIMD: Node 16+, Bun, Deno,
Chrome 91+, Firefox 89+, Safari 16.4+.

Building the modules from source instead needs clang with the `wasm32`
target and `wasm-ld` (LLVM lld) on `PATH`; see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Quick start

`load` takes the module bytes, so how you read them is up to your runtime.
The `.wasm` files are exposed as package subpaths, so nothing needs a
hardcoded path into `node_modules`. On the server:

```ts
import { readFile } from "node:fs/promises";
import { SwissU32ToU64, StringInterner } from "swisstable";

const wasm = await readFile(new URL(import.meta.resolve("swisstable/swiss_u64.wasm")));
const table = await SwissU32ToU64.load(wasm, 1 << 16);

const interner = new StringInterner();
table.setSpan(interner.intern("prompt:42"), { offset: 128, length: 64 });

table.getSpan(interner.intern("prompt:42")); // { offset: 128, length: 64 }
```

In a browser or at the edge, fetch them instead:

```ts
const response = await fetch("/swiss_u64.wasm");
const table = await SwissU32ToU64.load(await response.arrayBuffer());
```

Creating several tables? Compile once and pass the module, which skips
validation and codegen each time:

```ts
const module = await WebAssembly.compile(wasm);
const forward = await SwissU32ToU32.load(module, 1_000);
const reverse = await SwissU32ToU32.load(module, 1_000);
```

Four runnable examples live in [`examples/`](examples/README.md), in reading
order:

```bash
bun run examples/01-basic.ts           # the API, u32 validation, capacity
bun run examples/02-bulk.ts            # batching, chunking, spans
bun run examples/03-string-pool.ts     # string keys and the pool pattern
bun run examples/04-multiple-tables.ts # one module, many instances
```

## API

Four exports:

| Export | Mapping | Use it for |
| --- | --- | --- |
| `SwissU32ToU32` | `u32 -> u32` | counters, ID remaps, presence sets |
| `SwissU32ToU64` | `u32 -> u64` as `{lo, hi}` lanes | spans, offsets, packed pairs |
| `StringInterner` | `string -> u32` | stable IDs in first-seen order |
| `InternedSwissMap` | `string -> V` | string keys over a numeric table |

Both tables share the same shape, and `SwissU32ToU64` adds bulk methods:

```ts
await Table.load(bytes, expectedEntries?)

table.size; table.capacity;
table.has(key); table.get(key); table.set(key, value); table.delete(key);
table.reserve(entries); table.clear();

// SwissU32ToU64 only — one WASM call per batch, not per key
table.setMany(keys, valsLo, valsHi);
table.getMany(keys);      // { valsLo, valsHi, found }
table.setSpan(key, { offset, length });
```

Three rules apply everywhere: keys and values are strictly `u32` and anything
else throws `RangeError`; capacity is fixed at build time (917,504 entries);
and a stored `0` is always distinguishable from an absent key.

**→ [docs/api.md](docs/api.md)** for every method, parameter, and thrown
error.

## Benchmarks

```bash
bun run build && bun run bench
```

100k entries, best of 7 rounds, Bun 1.3.14 on x64 Linux. Treat the ratios as
portable and the absolute figures as not.

| Workload | SwissTable | `Map` | Speedup |
| --- | --- | --- | --- |
| fill, sparse keys | **7.3 ns** | 65.5 ns | 9.0x |
| lookup hit, sparse | **6.0 ns** | 10.2 ns | 1.7x |
| lookup miss, sparse | **8.4 ns** | 11.4 ns | 1.4x |
| u64 bulk fill (`setMany`) | **6.9 ns** | 40.7 ns | 5.9x |
| u64 bulk lookup (`getMany`) | **6.2 ns** | 10.4 ns | 1.7x |

**→ [docs/performance.md](docs/performance.md)** for the full table including
dense keys and grown-from-empty fills, the cost model behind the numbers, the
int32 argument-tagging cliff that dominates everything else, and the proofs
for both limits above.

## How it works

One byte of metadata per slot, scanned sixteen at a time with
`wasm_simd128`. The low 7 bits of the hash are the fingerprint stored in that
byte; the rest picks the group. A lookup compares all sixteen fingerprints in
one instruction and usually gets exactly one candidate to confirm.

```
control:  [ EMPTY | 0x2a | DELETED | 0x7f | EMPTY | ... ]   1 byte per slot
entries:  [       | k,v  |         | k,v  |       | ... ]   8 or 12 bytes
```

Rehashing copies live entries between two preallocated banks, so nothing ever
allocates and the module links `-nostdlib`. Load factor is capped at 7/8,
capacity is a power of two, and deletion writes a tombstone that the next
rehash reclaims.

**→ [docs/design.md](docs/design.md)** for hash splitting, the probing
sequence and why it terminates, the invariant behind tombstone reuse, memory
layout, and the build.

## Contributing

Contributions are welcome. Bug reports and benchmark results on other
hardware are especially useful — the numbers above are from one x64 Linux
machine.

```bash
git clone https://github.com/vii/swisstable
cd swisstable
bun install
bun run build      # compile native/*.c to dist/wasm/*.wasm

bun test           # 35 tests across 3 suites
bun run typecheck  # tsc --noEmit
bun run bench      # throughput against Map, Object, Int32Array
```

Run all four before opening a pull request. `bun run build` is not optional
even for a TypeScript-only change, since the tests load the compiled modules.
Add a test for new behaviour, and if a change moves the published benchmark
numbers, update the tables and say which direction they moved.

Building needs clang with the `wasm32` target and `wasm-ld` (LLVM lld) on
`PATH`. Read [docs/design.md](docs/design.md) before touching the C — several
invariants are load bearing and not obvious from the code.

**→ [CONTRIBUTING.md](CONTRIBUTING.md)** for the full guide.

## License

[MIT](LICENSE)
