# Security policy

## Reporting a vulnerability

Report privately through GitHub: open the repository's
[Security tab](https://github.com/CoderDayton/swisstable/security/advisories/new)
and file a draft advisory. Do not open a public issue for something you
believe is exploitable.

Include the runtime and version, the package version, and a reproduction —
the key sequence or input that triggers it, ideally as a runnable script.

Expect an acknowledgement within 7 days and an assessment within 14. A
confirmed vulnerability is fixed in a patch release, and the advisory is
published once the fix is on npm, crediting you unless you prefer otherwise.

## What this package is

A hash map inside a WebAssembly module. It reads no files, opens no sockets,
spawns nothing, and has no runtime dependencies. It touches its own linear
memory and nothing else, and cannot reach past it — a bug in the C is
confined to the instance's memory by the WebAssembly sandbox, which is the
main reason the table is compiled rather than written in JavaScript.

The modules are built `-nostdlib` with no allocator and never call
`memory.grow`, so there is no allocation path to exhaust and no `malloc` to
corrupt.

## In scope

- Reading or writing outside the module's own linear memory.
- A key sequence that makes the probe loop run without terminating. The
  loop's bound is a load-bearing invariant, tested in
  `test/probe-bound.test.ts`, and a way around it wedges the calling thread
  for good — WebAssembly has no interrupt.
- A lookup returning an entry that was never inserted, or missing one that
  was, for keys inside the documented `u32` range.
- Anything that survives `dispose()` and lets a released instance still be
  reached.
- A published artifact that does not match the tagged source.

## Known limits, by design

These are documented behavior, not vulnerabilities. Report them only if you
can show the actual behavior is worse than what is written here.

**The hash seed is 32 bits.** Each table draws one from the runtime's CSPRNG
and mixes it into every key, so a colliding key set cannot be computed
offline and reused across processes. It is not a keyed MAC: an attacker who
can observe which keys collide can search the seed space offline and craft
keys against the seed they recover. The damage that buys is bounded — at
most 4,096 distinct keys share a probe group at the default capacity, which
measures about 5x slower lookups, not a stall. See
[Untrusted keys and threading](docs/api.md#untrusted-keys-and-threading).

**`createWithSeed` and `loadWithSeed` disable that protection.** They exist
for reproducible tests and benchmarks. A fixed seed compiled into a service
that handles attacker-chosen keys puts every process running it back on one
layout; that is the caller's decision, and it is documented at both call
sites.

**A table is single-threaded.** One instance is one table, its state is
plain memory with no atomics, and sharing an instance across workers
corrupts it. Share the compiled `WebAssembly.Module` instead and give each
worker its own instance.

**Capacity is fixed at build time.** Exceeding it throws `RangeError`
rather than growing. An input that drives a table past 917,504 entries is a
capacity-planning problem in the calling service.

**Every instance reserves its full linear memory up front** — 20 MiB for
`SwissU32ToU32`, 29 MiB for `SwissU32ToU64` — committed by page, so an empty
one costs about 1.7 MiB RSS. Code that creates a table per request and never
calls `dispose()` will accumulate them until the collector runs.

## Supported versions

The latest published minor receives security fixes. Older minors do not.
