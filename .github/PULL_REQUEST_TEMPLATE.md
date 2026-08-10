<!--
Setup, the build/test loop, and the rules for touching native/ are in
CONTRIBUTING.md. This template only asks for what a reviewer cannot work out
from the diff.
-->

## What this changes

<!-- One or two sentences. What behaviour is different afterwards? -->

## Why

<!-- The problem, not the patch. Link the issue if there is one. -->

## How it was checked

<!-- Name the commands you ran and what they reported. "Tests pass" is not a
result; "bun test -> 247 pass" is. -->

- [ ] `bun run build && bun run typecheck && bun test`
- [ ] `bun run smoke` (the emitted JavaScript under Node)
- [ ] `bun run check:ubsan` — **required if this touches `native/`**
- [ ] `bun run bench` — **required if this claims a performance change**

## Checklist

- [ ] `src/generated/` is rebuilt and committed if `native/` changed. CI
      fails otherwise, and a stale payload ships wasm that disagrees with the
      C in the same commit.
- [ ] New behaviour has the smallest test that would fail without it.
- [ ] Docs under `docs/` and the README state what is true now, with no
      before/after notes.
- [ ] `CHANGELOG.md` has an entry if the public surface moved. The
      `*WasmExports` interfaces are `@internal` and need none.

## Anything a reviewer should push back on

<!-- Tradeoffs you made, alternatives you rejected, parts you are unsure
about. Say so here rather than waiting to be asked. -->
