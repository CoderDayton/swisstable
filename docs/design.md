# Design

How the tables are built, and why each choice is the way it is.

The layout follows Google's SwissTable — see
[abseil's writeup](https://abseil.io/about/design/swisstables) and
[cwisstable's DESIGN.md](https://github.com/google/cwisstable/blob/main/DESIGN.md)
— adapted to a freestanding wasm32 module with no allocator.

- [The core idea](#the-core-idea)
- [Hash splitting](#hash-splitting)
- [Probing](#probing)
- [Load factor and tombstones](#load-factor-and-tombstones)
- [Two banks instead of an allocator](#two-banks-instead-of-an-allocator)
- [Memory layout](#memory-layout)
- [Crossing the boundary](#crossing-the-boundary)
- [Bulk staging](#bulk-staging)
- [Build](#build)

## The core idea

A SwissTable keeps two parallel arrays: one byte of metadata per slot, and
the entries themselves.

```
control:  [ EMPTY | 0x2a | DELETED | 0x7f | EMPTY | ... ]   1 byte per slot
entries:  [       | k,v  |         | k,v  |       | ... ]   8 or 12 bytes per slot
```

Each control byte is one of three things:

| Value | Meaning |
| --- | --- |
| `0xff` (`EMPTY`) | Never used. Ends a probe sequence. |
| `0x80` (`DELETED`) | Tombstone. Does **not** end a probe sequence. |
| `0x00`–`0x7f` | Live, holding the 7-bit fingerprint of the key's hash. |

The high bit alone distinguishes live from not-live, which lets one SIMD
compare classify all sixteen slots in a group at once.

A lookup loads 16 control bytes, compares them against the key's fingerprint
with `wasm_i8x16_eq`, and turns the result into a bitmask with
`wasm_i8x16_bitmask`. Each set bit is a candidate; the full key is then
checked to rule out the 1-in-128 fingerprint collisions. At the 7/8 load
factor a group usually yields exactly one candidate, so a hit costs one SIMD
compare and one key comparison.

## Hash splitting

Keys go through the Murmur3 finalizer, then split into two independent
pieces:

```c
static inline uint32_t h1(uint32_t hash) { return hash >> 7; }   // probe position
static inline uint32_t h2(uint32_t hash) { return hash & 0x7f; } // fingerprint
```

**The `>> 7` is load-bearing.** Without it, the low bits selecting the group
and the bits forming the fingerprint come from the same place, so every slot
within a group shares part of its fingerprint and the SIMD match degenerates
into a near-constant candidate set. This was a real bug in an early revision,
found by reading cwisstable's design notes.

The finalizer matters too. Keys are frequently dense or strided — indices,
IDs, pointers shifted right — which a bare identity hash would pile onto a
handful of groups.

## Probing

Probing walks whole groups, quadratically:

```
position₀ = h1(hash) & mask, rounded down to a group boundary
positionₙ₊₁ = (positionₙ + 16n) & mask
```

The visited group indices are the triangular numbers modulo the group count.
For a power-of-two capacity that sequence enumerates every group exactly once
before repeating, so **the loop terminates even on a table with no empty slot
left.**

Probe positions are always group-aligned and below capacity, so the 16-byte
load never runs past the end of the bank — no mirrored sentinel prefix is
needed, unlike implementations that allow unaligned group loads.

A group containing an `EMPTY` slot ends a search: an insert would have
stopped there, so the key cannot lie further along the sequence.

## Load factor and tombstones

Live entries are capped at 7/8 of capacity. Above that, probe sequences
lengthen sharply; below it, the group scan almost always resolves in its
first iteration.

Deletion writes `DELETED` rather than `EMPTY`, because turning a slot empty
would truncate the probe sequences of every key that hashed through it. The
next rehash drops tombstones and reclaims the slots.

The invariant that makes insertion terminate is subtler than the load factor
itself. `growth_left` is decremented **only when an insert consumes an
`EMPTY` slot**, never when it reuses a tombstone. That guarantees at least
`capacity/8` slots stay `EMPTY` at all times, which is what stops
`find_insert_slot` — a loop with no other bound — from spinning forever.

Insertion prefers the first tombstone it sees, reclaiming it, but only
returns once it has also found an `EMPTY` slot. Stopping at the tombstone
could place a key ahead of a live duplicate further along the same sequence.

## Two banks instead of an allocator

The modules link `-nostdlib` and have no allocator, so a rehash cannot
allocate a new table. Instead each module statically reserves **two** banks
and rehashes by copying live entries from the active one into the idle one,
then swapping.

The cost is double the memory. The benefit is that nothing on any path
allocates, the module has no libc dependency, and capacity is knowable at
build time.

`ensure_insert_space` handles three cases: an untouched table gets a minimal
bank; a table with remaining growth is already fine; a table out of growth
either doubles (genuinely full of live entries) or rehashes at the same
capacity (its growth was spent on entries since deleted, which the rehash
reclaims).

## Memory layout

Key and value share one record:

```c
typedef struct { uint32_t key; uint32_t value; } Entry;          // u32 table
typedef struct { uint32_t key; uint32_t lo; uint32_t hi; } Entry; // u64 table
```

A lookup is a chain of dependent loads: control byte, then the key to confirm
the match, then the value. Separate key and value arrays put the last two on
different cache lines, so a hit costs three serialized misses instead of two.
Interleaving removes one from the critical path — worth ~3 ns per lookup at
100k entries.

## Footprint

The banks are fixed static arrays and the module links with
`--initial-memory == --max-memory`, so an instance reserves its whole linear
memory — 20 MiB for u32, 28 MiB for u64 — the moment it is instantiated,
holding zero entries or 917,504.

Both figures are derived from `MAX_CAPACITY`, not written down beside it:
`scripts/build-wasm.ts` computes them from bytes-per-slot times the slot
count plus fixed overhead, so lowering `SWISS_MAX_CAPACITY_LOG2` shrinks the
reservation instead of leaving it stranded at the default. At `2^16` a u32
instance costs 3.1 MiB and a u64 instance 3.6 MiB, which is the build to
reach for when the workload is many small tables rather than one large one.

Reserved is not resident. The host commits pages as they are touched, and an
empty table touches only the control bytes of its initial 64 slots. Measured
on x64 Linux:

| | RSS | virtual |
| --- | --- | --- |
| empty u32 table | +1.7 MiB | +15.6 MiB |
| 64 empty u32 tables | +5.0 MiB | — |
| one table after 900k inserts | +32.9 MiB | +16.6 MiB |

Two things follow. The first is that address space is claimed up front:
virtual size barely moves across a fill that adds 27 MiB of resident memory.
The second is that the marginal cost of an extra instance is small — roughly
50 KiB once the first has paid for module compilation — so a program holding
dozens of tables is fine, and the fixed cost that matters is per *process*,
not per table.

What this does not buy back is the small-table case. The reason `Map` wins
below ~8k entries is the boundary crossing, not the footprint; see
[performance.md](performance.md#small-tables-the-crossing-is-the-whole-budget).

## Crossing the boundary

Two decisions exist purely to keep a lookup at **one** boundary crossing.

**Results are latched, not returned.** `has_get()` returns presence as an
`i32` and writes the value to a fixed address in linear memory. The binding
holds a `Uint32Array` view over that address, built once at load, and reads
the value from it. A packed `u64` return would instead box a `BigInt` on
every lookup — ~14 ns, more than a second crossing would cost — and could not
distinguish a stored `0` from absence anyway.

**Views are built once.** The modules are linked with initial memory equal to
maximum memory and never call `memory.grow`, so the backing `ArrayBuffer` is
never detached or reallocated and a view stays valid for the module's
lifetime.

**`size` and `capacity` are read the same way**, through `size_ptr()` and
`capacity_ptr()`. They are properties on the JavaScript side, and a property
that costs a boundary crossing sets the wrong expectation — a caller writing
`for (i = 0; i < table.size; i++)` pays per iteration for what reads like a
field. Measured through the real binding:

| | per read |
| --- | --- |
| `table.size` (memory view) | 0.184 ns |
| `wasm.size()` (export call) | 0.945 ns |
| hoisted local (the floor) | 0.188 ns |

So the property now costs what a local costs. This is not a cached count:
the view is over the module's own counter, at the address the module
reported, so there is no second copy and nothing to invalidate. The `size()`
and `capacity()` exports remain — they are the definition these addresses
point at, and what `load()` validates.

Exposing the addresses is free on the C side because those counters are
ordinary statics that already live in linear memory. The module has exactly
one WebAssembly *global* (`__stack_pointer`), so nothing was moved out of a
register to make this work.

The third decision lives on the JavaScript side: every key is passed as
`x | 0`. See
[performance.md](performance.md#what-dominates-the-int32-tagging-cliff) —
this one is worth more than everything else combined.

## Bulk staging

The bulk API stages a batch into buffers the **C module owns**, and exports
their addresses:

```c
uint32_t bulk_capacity(void);     // 65536 keys
uint32_t bulk_keys_ptr(void);
uint32_t bulk_vals_lo_ptr(void);
uint32_t bulk_vals_hi_ptr(void);
uint32_t bulk_flags_ptr(void);
```

Ownership direction is the whole point. An earlier revision picked the
staging offsets on the JavaScript side, and they silently aliased the table
banks — the buffers sat *inside* live entry storage. Letting the linker place
them and exporting the addresses makes that class of bug unrepresentable.

`set_many` reserves once for the whole batch rather than once per key, which
is the primary amortization over N individual `set` calls. The bound is
pessimistic — keys already present overwrite rather than insert — so it can
over-reserve, never under-reserve.

## Build

`scripts/build-wasm.ts` drives clang directly:

```
--target=wasm32 -O3 -msimd128 -nostdlib
-Wl,--no-entry -Wl,--export-memory
-Wl,--initial-memory=N -Wl,--max-memory=N
-Wl,--export=<symbol>   (one per exported function)
```

Initial and maximum memory are equal, which is what makes the cached views
safe. The u32 module reserves 20 MiB, the u64 module 28 MiB — 2 MiB of
control bytes plus 24 MiB of 12-byte entry records, plus the staging buffers
and the linker-placed stack. Both are computed from `MAX_CAPACITY_LOG2` in
the build script rather than hardcoded, so the two cannot drift apart.

Exports are declared per function with
`__attribute__((export_name("...")))`, and `scripts/build-wasm.ts` passes a
`--export=` for each one. Note that this list is **not** a build-time
guarantee: renaming an export in the C source still links cleanly, because
`wasm-ld` does not treat a missing `--export=` symbol as an error. The check
that actually catches it is in the bindings — `load()` verifies every
expected symbol is present on the instance and throws `TypeError` otherwise,
and `create()` routes through `load()` for the same reason.

Capacity is `1 << 20` slots per bank, giving 917,504 live entries at the 7/8
load factor. Override it at build time with `SWISS_MAX_CAPACITY_LOG2`, a
power-of-two exponent in `[4, 26]` — a power of two because the mask
arithmetic depends on it. The C sources take it as `-DMAX_CAPACITY_LOG2` and
fall back to 20 via `#ifndef`, and the build script sizes linear memory from
the same number, so there are no longer two places to keep in step.

## Embedding

The build emits each module twice: as a `.wasm` file, and as a base64 string
in `src/generated/<name>.ts`. `create()` decodes the latter, which is why it
needs no loader and behaves the same on every runtime — no `fs`, no `fetch`,
no bundler asset handling.

base64 costs 33% over the raw bytes, about 1.3 KiB across both modules.
Decoding runs once per process and takes a few microseconds against a
compile that is orders of magnitude more, so the payload size is the only
real cost and it is small.

The compiled `WebAssembly.Module` is cached per module for the lifetime of
the process, so only the first `create()` pays validation and codegen.
Rejections are cached too: the way compilation fails here is a runtime that
cannot compile these modules at all, usually missing SIMD, and that does not
change on a retry.
