# Changelog

Notable changes to this package. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The public API is the exports of `swisstable` and the two `.wasm` subpaths.
The `*WasmExports` interfaces mirror the native sources, are marked
`@internal`, and change without a major version.

## 1.0.0 - 2026-08-09

Initial release.

### Tables

- `SwissU32ToU32` and `SwissU32ToU64`, SwissTable hash maps resident in
  WebAssembly linear memory. Keys, values, control bytes, and probing never
  cross the JavaScript boundary, so a lookup costs one WASM call.
- Control bytes matched sixteen at a time with `wasm_simd128`.
- Bulk `setMany`, `getMany`, and `deleteMany` on both tables, crossing once
  per batch rather than once per key.
- `getOrInsert` and `increment` on both tables, doing a read-modify-write in
  one crossing and one probe.
- `keys`, `values`, `entries`, `forEach`, and `for…of`. A rehash during a
  walk is detected and throws rather than silently skipping or repeating
  entries.
- `reserve`, `clear`, and `shrinkToFit` — the last being the only way
  capacity comes back down, which matters because iteration costs
  `O(capacity)`.
- `dispose()`, and `Symbol.dispose` where the runtime has it, so an
  instance's linear memory is released without waiting for the collector.
- `loadSync` and `loadSyncWithSeed`, building a table from an
  already-compiled `WebAssembly.Module` without awaiting.

### String keys

- `StringInterner`, assigning stable `u32` IDs in first-seen order, with
  optional ID recycling and an optional size cap.
- `InternedSwissMap`, presenting a `string -> V` map over a numeric table.

### Hashing

- Every table seeds its hash from the runtime's CSPRNG, so the set of keys
  sharing a probe group differs between instances and between processes and
  cannot be computed offline.
- `createWithSeed`, `loadWithSeed`, and `loadSyncWithSeed` fix the seed for
  reproducible tests, benchmarks, and builds. Not for untrusted input — see
  [SECURITY.md](SECURITY.md).

### Packaging

- Ships compiled ESM with type declarations. Both modules are compiled into
  the package, so `create()` needs no `.wasm` file, no loader, and no build
  step; `load()` accepts bytes or a compiled `WebAssembly.Module` for
  callers who want control, and the `.wasm` files are exposed as package
  subpaths.
- No runtime dependencies. No allocator, `-nostdlib`, and `memory.grow` is
  never called.
- Runs on Node 16.9+, Bun, Deno, bundlers, and browsers with WebAssembly
  SIMD (Chrome 91+, Firefox 89+, Safari 16.4+). `supportsSimd()` reports
  whether the current runtime qualifies.
- Published from CI with npm provenance, built with a pinned Zig toolchain
  verified against its published checksum, and every platform in the build
  matrix must produce byte-identical modules.
