# Contributing

Thanks for taking a look. This is a small, dependency-free project — the
whole loop is build, test, typecheck, benchmark.

## Setup

```bash
git clone https://github.com/CoderDayton/swisstable
cd swisstable
bun install
bun run hooks   # installs the lefthook pre-commit and pre-push gates
bun run build
```

`bun run hooks` is a deliberate one-off rather than a `prepare` script: a
lifecycle script in `package.json` ships to every consumer, where npm reports
it as an install script even though it never runs for a registry install.
The hooks are for contributors, so contributors ask for them.

Requirements:

- [Bun](https://bun.com) 1.3+
- TypeScript 7.0+ (a devDependency; `bun run typecheck` uses it)
- clang with the `wasm32` target, and `wasm-ld` (LLVM lld) on `PATH`

Set `CLANG` to select a specific compiler:

```bash
CLANG=clang-21 bun run build
```

The `.wasm` modules are build output and are not checked in, so
`bun run build` has to run before the tests or benchmarks mean anything.
Suites that need a compiled module skip themselves when `dist/wasm` is empty,
so `bun test` still works on a fresh clone.

`src/generated/*.ts` is the exception: `build:wasm` writes each module out a
second time as base64, and those files **are** committed. They have to be,
because `src` imports them — without them the package would not typecheck on
a clone that has no clang. CI rebuilds and fails if the committed copy drifts
from `native/*.c`, so treat them as build output that happens to be tracked:
never hand-edit, and stage the rebuilt files with any C change.

## Layout

```
native/         C sources for the wasm32 modules
scripts/        build tooling (build-wasm.ts) and benchmarks (bench.ts)
src/            TypeScript bindings and public entry point
src/generated/  base64 module payloads (generated, committed)
examples/       runnable examples, start at 01-basic.ts
test/           bun test suites
docs/           api.md, design.md, performance.md
dist/wasm/      build output (generated, not committed)
```

## The loop

```bash
bun run build      # both steps below
bun run build:wasm # native/*.c -> dist/wasm/*.wasm + src/generated/*.ts
bun run build:js   # src/*.ts   -> dist/js/*.js + .d.ts

bun test           # 88 tests across 9 suites
bun run typecheck  # tsc --noEmit
bun run bench      # throughput against Map, Object, Int32Array
```

Run build, test, typecheck, and bench before opening a pull request.
`bun run build` is not optional even for a TypeScript-only change: the tests
load the compiled modules.

### Two TypeScript configs

`tsconfig.json` is bundler-mode and `noEmit` — it is what the editor and
`bun run typecheck` use, and it lets sources import each other with explicit
`.ts` extensions.

`tsconfig.build.json` is what publishes. It overrides that config to emit
JavaScript and declarations into `dist/js`, rewriting those `.ts` specifiers
to `.js` so the output resolves under plain Node. It also swaps `types:
["bun"]` for `lib: ["DOM"]`, because the published types must not require
consumers to install bun-types, and TypeScript ships the `WebAssembly`
globals only in `lib.dom`.

A change that typechecks under one config can still fail under the other.
Run both.

## Changing the C

Read [docs/design.md](docs/design.md) first — several invariants are load
bearing and not obvious from the code:

- **`h1` must discard the bits `h2` uses.** Without the `>> 7`, group index
  and fingerprint come from the same hash bits and the SIMD match degenerates.
- **`growth_left` may only be decremented when an insert consumes an `EMPTY`
  slot**, never a tombstone. That is the sole guarantee that
  `find_insert_slot` terminates.
- **Probe positions must stay group-aligned and below capacity.** The 16-byte
  SIMD loads assume it; there is no mirrored sentinel prefix to catch an
  overrun.
- **`find_insert_slot` must not return at the first tombstone.** It has to
  reach an `EMPTY` slot first, or it can place a key ahead of a live
  duplicate on the same probe sequence.

If you add or rename an export, update the `exports` list in
`scripts/build-wasm.ts` **and** the validation list in the matching binding.
The linker does not fail on a missing `--export=` symbol — the error surfaces
at `load()` as a `TypeError`, so tests are what catch it.

`MAX_CAPACITY` is set by `MAX_CAPACITY_LOG2`, a power-of-two exponent
defaulting to 20 via `#ifndef` and overridable with the
`SWISS_MAX_CAPACITY_LOG2` environment variable at build time. Linear memory is
derived from it in `scripts/build-wasm.ts` (bytes-per-slot times slots, plus
fixed overhead), so there is no second figure to keep in step — but if you add
a static array, raise that target's `overheadBytes`. The statics have to fit
in the linked linear memory, and the link fails with "initial memory too
small" if they do not, so the arithmetic is checked by every build.

## Changing the benchmarks

`scripts/bench.ts` has a few rules baked in that are easy to break:

- **Contenders run one at a time.** Running them concurrently interleaves
  their work inside each other's timed regions.
- **Only read-only workloads may replay** within a round. Replaying a fill
  would overwrite rather than insert, and stop being the same workload.
- **Nothing allocating belongs in the timed region.** An `Object.keys().length`
  call once inflated the Object contender by ~4x purely through allocation.
- **Fill is measured pre-sized and grown from empty**, because `Map` and
  `Object` cannot be pre-sized and always pay for their own rehashes.

If a change moves the published numbers, update the tables in
[docs/performance.md](docs/performance.md) and the README together, and say
in the pull request which direction they moved and why.

## Publishing

`prepublishOnly` runs the full gate — build, typecheck, tests — so
`npm publish` cannot ship a broken or stale `dist/`.

Before releasing, verify the package from a consumer's point of view rather
than from inside the repo:

```bash
bun pm pack
cd $(mktemp -d) && npm init -y >/dev/null
npm install /path/to/swisstable-<version>.tgz
node --input-type=module -e "
  import { readFile } from 'node:fs/promises';
  import { SwissU32ToU32 } from 'swisstable';
  const url = import.meta.resolve('swisstable/swiss_u32.wasm');
  const t = await SwissU32ToU32.load(await readFile(new URL(url)), 1000);
  t.set(7, 70); console.log(t.get(7));
"
```

This catches the failure mode that inside-the-repo testing never will: an
`exports` map pointing at something the tarball does not contain, or ships in
a form the target runtime cannot execute.

## Tests

New behaviour wants the smallest test that would fail without it. Regressions
worth keeping around, already in the suite:

- keys and values above `2^31`, which cross the boundary as negative int32
- overwriting an existing key on a table at its capacity ceiling
- batches larger than `bulk_capacity`, which exercise chunking
- the staging buffers not overlapping the table banks

## Style

- Match the surrounding code; there is no formatter to defer to.
- Comments explain *why*, not *what*. The C sources document invariants and
  the reasoning behind layout choices; keep that bar.
- No magic numbers — name them, as `STATUS_OK` and `MAX_LIVE` are named.
- Public API changes need matching updates to [docs/api.md](docs/api.md).
