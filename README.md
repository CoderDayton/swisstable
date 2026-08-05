# swisstable

[![CI](https://github.com/CoderDayton/swisstable/actions/workflows/ci.yml/badge.svg)](https://github.com/CoderDayton/swisstable/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/bun-1.3%2B-black.svg)](https://bun.com)
[![TypeScript](https://img.shields.io/badge/typescript-7.0%2B-3178c6.svg)](https://www.typescriptlang.org/)

This package is a port of Google's high-performance [SwissTable] hash map to
freestanding `wasm32`, with thin TypeScript bindings. Keys are `u32`.

The table lives entirely inside WebAssembly linear memory: keys, values,
control bytes, and probing never cross the JavaScript boundary, so a lookup
costs one WASM call and a bulk operation costs one call per chunk regardless
of batch size. Above ~6k entries that makes it 1.2–9x faster than `Map` on
every integer workload measured, and the margin is widest on mutation —
`delete` is 5.6x. Below that, or with string keys, `Map` wins, and for dense
keys a typed array beats both — see
[when not to use this](#when-not-to-use-this).

The original C++ version can be found [here], and this [CppCon talk] gives an
overview of how the algorithm works.

[SwissTable]: https://abseil.io/blog/20180927-swisstables
[here]: https://github.com/abseil/abseil-cpp/blob/master/absl/container/internal/raw_hash_set.h
[CppCon talk]: https://www.youtube.com/watch?v=ncHmEUmJZf4

Docs: [API](docs/api.md) · [Design](docs/design.md) ·
[Performance](docs/performance.md) · [Examples](examples/README.md) ·
[Contributing](CONTRIBUTING.md)

## Features

- One byte of metadata per slot, compared sixteen at a time with `wasm_simd128`.
- Lower memory usage: ~10 bytes per entry against `Map`'s ~24–32.
- Bulk `setMany`/`getMany`/`deleteMany` stage a whole batch and cross once —
  7.4 ns/op against `Map`'s 56.4 for a 100k-entry fill.
- No allocator: fixed linear memory, linked `-nostdlib`, never calls
  `memory.grow`, and no allocation on any hot path.
- The modules are compiled into the package, so there is no `.wasm` file to
  locate, copy, or serve, and no loader to write per runtime.
- Ships compiled ESM with type declarations. Nothing is built on install and
  there are no runtime dependencies.
- Runs in Node, Bun, Deno, bundlers, and browsers — anything with WebAssembly
  SIMD (Node 16+, Chrome 91+, Firefox 89+, Safari 16.4+).

## Usage

```bash
npm install swisstable    # or bun add / pnpm add / yarn add
```

Then:

```ts
import { SwissU32ToU32 } from "swisstable";

// Sizing up front avoids rehashing during the initial fill.
const table = await SwissU32ToU32.create(100_000);

table.set(0xdead_beef, 42);
table.get(0xdead_beef); // 42
```

`create` uses the module compiled into the package and compiles it once,
sharing it across every table. To control loading yourself — streaming
compilation, a module shared across workers, a custom asset path — use
`load(bytes)` instead; the `.wasm` files are also exposed as package
subpaths.

Four exports:

| Export | Mapping | Use it for |
| --- | --- | --- |
| `SwissU32ToU32` | `u32 -> u32` | counters, ID remaps, presence sets |
| `SwissU32ToU64` | `u32 -> u64` as `{lo, hi}` lanes | spans, offsets, packed pairs |
| `StringInterner` | `string -> u32` | stable IDs in first-seen order |
| `InternedSwissMap` | `string -> V` | string keys over a numeric table |

Keys and values are strictly `u32` and anything else throws `RangeError`;
capacity is fixed at build time (917,504 entries); a stored `0` is always
distinguishable from an absent key. See [docs/api.md](docs/api.md) for every
method and thrown error, and [`examples/`](examples/README.md) for four
runnable programs.

## When not to use this

| Situation | Use instead | Why |
| --- | --- | --- |
| Fewer than ~6k entries | `Map` | A crossing costs ~2.6 ns before doing any work; a cache-resident `Map` lookup costs ~3.6 ns in total. |
| String keys, looked up repeatedly | `Map<string, V>` | Engines cache a string's hash on the string object; a WASM table must copy and rehash the bytes. |
| Dense integer keys with no gaps | `Int32Array` | Direct indexing is 0.5 ns and needs no hashing. |
| Non-integer or `> 2^32 - 1` keys | `Map` | Anything outside `u32` throws. |

Both limits are structural rather than tuning problems;
[docs/performance.md](docs/performance.md) quantifies them.

## Benchmarks

100k entries, median of 21 rounds, each contender in its own process, probed
in a shuffled order, median of three runs. Bun 1.3.14 on x64 Linux. Ratios
are portable, absolute figures are not.

| Workload | SwissTable | `Map` | Speedup |
| --- | --- | --- | --- |
| fill, sparse keys | **7.8 ns** | 68.7 ns | 8.8x |
| lookup hit, sparse | **6.9 ns** | 11.3 ns | 1.6x |
| lookup miss, sparse | **7.7 ns** | 11.2 ns | 1.5x |
| `has`, sparse | **5.4 ns** | 11.1 ns | 2.1x |
| overwrite existing key | **6.3 ns** | 14.5 ns | 2.3x |
| delete | **5.5 ns** | 31.0 ns | 5.6x |
| churn (delete + reinsert) | **10.1 ns** | 33.1 ns | 3.3x |
| u64 bulk fill (`setMany`) | **7.4 ns** | 56.4 ns | 7.6x |
| u64 bulk lookup (`getMany`) | **7.0 ns** | 10.5 ns | 1.5x |

Reproduce with `bun run build && bun run bench`. The full table, the cost
model behind it, and the int32 argument-tagging cliff that dominates
everything else are in [docs/performance.md](docs/performance.md).

## Contributing

Contributions are welcome. Bug reports and benchmark results on other
hardware are especially useful — the numbers above are from one machine.

```bash
bun install
bun run hooks      # lefthook pre-commit and pre-push gates
bun run build      # compile native/*.c to dist/wasm/*.wasm
bun test           # 88 tests across 9 suites
bun run typecheck
bun run bench
```

Run all four before opening a pull request; `bun run build` is not optional
even for a TypeScript-only change, since the tests load the compiled modules.
Building needs clang with the `wasm32` target and `wasm-ld` on `PATH`. Read
[docs/design.md](docs/design.md) before touching the C — several invariants
are load bearing and not obvious from the code, and
[CONTRIBUTING.md](CONTRIBUTING.md) has the full guide.

## License

[MIT](LICENSE)
