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
of batch size. At 100,000 entries that makes it 1.4–12x faster than `Map` on
sparse integer keys — on Bun, Node, Deno, Chrome, and Firefox alike — with
the widest margins on mutation and bulk transfer. `Map` wins below ~2,000
entries and on string keys, and dense integer keys belong in a typed array —
see [when not to use this](#when-not-to-use-this).

The original C++ version can be found [here].

[SwissTable]: https://abseil.io/blog/20180927-swisstables
[here]: https://github.com/abseil/abseil-cpp/blob/master/absl/container/internal/raw_hash_set.h

Docs: [API](docs/api.md) · [Design](docs/design.md) ·
[Performance](docs/performance.md) · [Examples](examples/README.md) ·
[Contributing](CONTRIBUTING.md)

## Features

- One byte of metadata per slot, compared sixteen at a time with `wasm_simd128`.
- 10.3 bytes per entry at full occupancy, 20.6 with the standby bank a rehash
  needs, against a measured 37 for `Map` on V8 and 67 on JavaScriptCore.
- Holds up to 117,440,512 entries (u32) or 58,720,256 (u64).
- An instance starts at 1.25 MiB (u32) or 1.75 MiB (u64) and grows with the
  table, so a small table costs what a small table costs. See
  [Footprint](docs/design.md#footprint). `dispose()`, or a `using`
  declaration, hands an instance back without waiting for the collector.
- Bulk `setMany`/`getMany`/`deleteMany` on both tables cross once per batch:
  a 100,000-entry u32 fill is 6.1–6.9 ns/op against `Map`'s 48–70, and the
  matching lookup 3.9–4.9 against 11–24.
- `getOrInsert` and `increment` do a read-modify-write in one crossing and
  one probe. Inserting a missing key is 5.0–6.3x faster than `Map`.
- No allocator. Linked `-nostdlib`, with the banks at computed offsets and
  linear memory grown to reach them. Nothing allocates on a hot path.
- Ships compiled ESM with type declarations, and the modules are compiled in:
  no `.wasm` to serve, no loader to write, no install step, no dependencies.
- Runs in Node, Bun, Deno, bundlers, and browsers. Anything with WebAssembly
  SIMD (Node 16.9+, Chrome 91+, Firefox 89+, Safari 16.4+), which
  `supportsSimd()` reports for the current runtime.

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
subpaths. `loadSync(module)` builds a table from an already-compiled module
without awaiting, for the places that cannot.

Four exports:

| Export | Mapping | Use it for |
| --- | --- | --- |
| `SwissU32ToU32` | `u32 -> u32` | counters, ID remaps, presence sets |
| `SwissU32ToU64` | `u32 -> u64` as `{lo, hi}` lanes | spans, offsets, packed pairs |
| `StringInterner` | `string -> u32` | stable IDs in first-seen order |
| `InternedSwissMap` | `string -> V` | string keys over a numeric table |

Keys and values are strictly `u32` and anything else throws `RangeError`.
Capacity is bounded at 117,440,512 entries (u32) or 58,720,256 (u64). A
stored `0` is always distinguishable from an absent key. See
[docs/api.md](docs/api.md) for every method and thrown error, and
[`examples/`](examples/README.md) for five runnable programs.

Two operational notes. Each table seeds its hash from the runtime's CSPRNG,
so a colliding key set cannot be computed offline and reused across
processes; `createWithSeed` fixes the seed for reproducible runs and should
not be pointed at untrusted input. And a table is single-threaded — one
instance is one table, and no instance may be shared across workers. Both
are covered in
[Untrusted keys and threading](docs/api.md#untrusted-keys-and-threading).

## When not to use this

| Situation | Use instead | Why |
| --- | --- | --- |
| Fewer than ~2k entries | `Map` | A crossing costs a few ns before any work happens, and both containers are cache-resident. Between 2k and 16k the winner depends on the engine. |
| String keys, looked up repeatedly | `Map<string, V>` | Engines cache a string's hash on the string object; a WASM table must copy and rehash the bytes. |
| Dense integer keys with no gaps | `Int32Array` | Direct indexing is 0.5 ns and needs no hashing. |
| Non-integer or `> 2^32 - 1` keys | `Map` | Anything outside `u32` throws. |

Both limits are structural rather than tuning problems;
[docs/performance.md](docs/performance.md) quantifies them.

## Benchmarks

Speedup against `Map` at 100,000 sparse `u32` keys — above 1.00x the table is
faster. Median of 21 rounds and of 3 passes, each contender in an isolate of
its own, probed in a shuffled order. i9-13900K on x64 Linux.

| Workload | Bun 1.3 | Node 24 | Deno 2.9 | Chrome 151 | Firefox 153 |
| --- | --- | --- | --- | --- | --- |
| fill (pre-sized) | 5.2x | 6.2x | 5.0x | 3.6x | 4.7x |
| lookup hit | 1.50x | 2.7x | 2.8x | 2.3x | 1.60x |
| lookup miss | 1.29x | 3.2x | 3.4x | 2.5x | 1.70x |
| `has` | 1.77x | 3.2x | 3.5x | 2.9x | 1.86x |
| overwrite existing key | 2.2x | 2.5x | 2.5x | 2.2x | 2.8x |
| delete | 6.1x | 5.5x | 5.8x | 4.1x | 4.7x |
| churn (delete + reinsert) | 3.3x | 3.6x | 3.5x | 2.6x | 3.2x |
| count (`increment`) | 1.26x | 1.33x | 1.35x | 1.28x | 0.89x |
| u32 bulk fill (`setMany`) | 8.4x | 11x | 8.3x | 7.6x | 9.2x |
| u32 bulk lookup (`getMany`) | 2.7x | 5.6x | 4.9x | 5.4x | 3.6x |
| u64 bulk fill (`setMany`) | 10x | 9.7x | 8.6x | 6.4x | 8.5x |
| u64 bulk lookup (`getMany`) | 2.1x | 4.1x | 3.8x | 3.6x | 2.3x |

The table costs about the same on every engine. The columns differ because
`Map` does. Counting is the one row a browser engine takes: at 1,000 distinct
keys `Map` stays in cache, and the crossing is most of the budget.

Reproduce with `bun run build && bun run bench`, or `bun run bench:all` for
every runtime installed. Absolute figures, the cost model, the crossover by
engine, and where the caller's own key storage costs 1.7x are in
[docs/performance.md](docs/performance.md).

## Contributing

Contributions are welcome. Bug reports and benchmark results on other
hardware are especially useful — the numbers above are from one machine.
`bun run bench:all` followed by `bun run bench:compare` produces them in the
same form, and records the engine, CPU, and clock each column was taken on.

```bash
bun install
bun run hooks      # lefthook pre-commit and pre-push gates
bun run build      # compile native/*.c to dist/wasm/*.wasm
bun test           # 246 tests across 24 suites
bun run typecheck
bun run smoke      # the built package under plain Node
bun run smoke:browser  # the built package in Chrome or Firefox
bun run bench      # this runtime
bun run bench:all  # bun, node, deno, chrome, firefox — three passes each
```

Run `build`, `test`, and `typecheck` before opening a pull request; `bun run
build` is not optional even for a TypeScript-only change, since the tests
load the compiled modules.
Building needs nothing installed: `bun run build` downloads the pinned Zig
toolchain into `.zig/`, verifies it against its published checksum, and
compiles with it. Read
[docs/design.md](docs/design.md) before touching the C — several invariants
are load bearing and not obvious from the code, and
[CONTRIBUTING.md](CONTRIBUTING.md) has the full guide.

## License

[MIT](LICENSE)
