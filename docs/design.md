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
safe. The u32 module reserves 20 MiB, the u64 module 32 MiB — 2 MiB of
control bytes plus 24 MiB of 12-byte entry records, plus the staging buffers
and the linker-placed stack.

Exports are declared per function with
`__attribute__((export_name("...")))`, and `scripts/build-wasm.ts` passes a
`--export=` for each one. Note that this list is **not** a build-time
guarantee: renaming an export in the C source still links cleanly, because
`wasm-ld` does not treat a missing `--export=` symbol as an error. The check
that actually catches it is in the bindings — `load()` verifies every
expected symbol is present on the instance and throws `TypeError` otherwise.

Capacity is `1 << 20` slots per bank, giving 917,504 live entries at the 7/8
load factor. Raising it means editing `MAX_CAPACITY` **and** the memory
figures, since the statics have to fit.
