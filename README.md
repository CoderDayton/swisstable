# swisstable

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/bun-1.3%2B-black.svg)](https://bun.com)
[![TypeScript](https://img.shields.io/badge/typescript-7.0%2B-3178c6.svg)](https://www.typescriptlang.org/)

This package is a port of Google's high-performance [SwissTable] hash map to
freestanding `wasm32`, with thin TypeScript bindings. Keys are `u32`.

The table lives entirely inside WebAssembly linear memory: keys, values,
control bytes, and probing never cross the JavaScript boundary, so a lookup
costs one WASM call and a bulk operation costs one call per chunk regardless
of batch size. Above ~16k entries that makes it 1.1–9x faster than `Map` on
every workload measured. Below that, or with string keys, `Map` wins — see
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
  6.9 ns/op against `Map`'s 40.7 for a 100k-entry fill.
- No allocator: fixed linear memory, linked `-nostdlib`, never calls
  `memory.grow`, and no allocation on any hot path.
- Ships compiled ESM with type declarations and prebuilt `.wasm` modules.
  Nothing is built on install and there are no runtime dependencies.
- Runs in Node, Bun, Deno, bundlers, and browsers — anything with WebAssembly
  SIMD (Node 16+, Chrome 91+, Firefox 89+, Safari 16.4+).

## Usage

```bash
npm install swisstable    # or bun add / pnpm add / yarn add
```

Then:

```ts
import { readFile } from "node:fs/promises";
import { SwissU32ToU32 } from "swisstable";

const wasm = await readFile(new URL(import.meta.resolve("swisstable/swiss_u32.wasm")));
const table = await SwissU32ToU32.load(wasm, 100_000);

table.set(0xdead_beef, 42);
table.get(0xdead_beef); // 42
```

`load` takes the module bytes, so how you read them is up to your runtime —
`fetch(...).arrayBuffer()` in a browser. The `.wasm` files are exposed as
package subpaths, so nothing needs a hardcoded path into `node_modules`.

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
| Fewer than ~16k entries | `Map` | A crossing costs ~2.6 ns before doing any work; a cache-resident `Map` lookup costs ~3.2 ns in total. |
| String keys, looked up repeatedly | `Map<string, V>` | Engines cache a string's hash on the string object; a WASM table must copy and rehash the bytes. |
| Dense integer keys with no gaps | `Int32Array` | Direct indexing is 0.5 ns and needs no hashing. |
| Non-integer or `> 2^32 - 1` keys | `Map` | Anything outside `u32` throws. |

Both limits are structural rather than tuning problems;
[docs/performance.md](docs/performance.md) quantifies them.

## Benchmarks

100k entries, best of 7 rounds, Bun 1.3.14 on x64 Linux. Ratios are portable,
absolute figures are not.

| Workload | SwissTable | `Map` | Speedup |
| --- | --- | --- | --- |
| fill, sparse keys | **7.3 ns** | 65.5 ns | 9.0x |
| lookup hit, sparse | **6.0 ns** | 10.2 ns | 1.7x |
| lookup miss, sparse | **8.4 ns** | 11.4 ns | 1.4x |
| u64 bulk fill (`setMany`) | **6.9 ns** | 40.7 ns | 5.9x |
| u64 bulk lookup (`getMany`) | **6.2 ns** | 10.4 ns | 1.7x |

Reproduce with `bun run build && bun run bench`. The full table, the cost
model behind it, and the int32 argument-tagging cliff that dominates
everything else are in [docs/performance.md](docs/performance.md).

## Contributing

Contributions are welcome. Bug reports and benchmark results on other
hardware are especially useful — the numbers above are from one machine.

```bash
bun install
bun run build      # compile native/*.c to dist/wasm/*.wasm
bun test           # 35 tests across 3 suites
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
